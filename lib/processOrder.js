import { Redis } from '@upstash/redis';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ============================================================
// FAILURE LOGGING — Redis + Google Sheets
// ============================================================

export async function logFailureToRedis(order, errorMessage) {
  try {
    const key = `failed_order:${order?.order_number || 'unknown'}:${Date.now()}`;
    await redis.set(
      key,
      JSON.stringify({
        orderNumber: order?.name || 'unknown',
        customerEmail: order?.email || '',
        errorMessage,
        orderData: order,
        timestamp: new Date().toISOString(),
        retried: false,
      })
    );
    await redis.lpush('failed_orders_list', key);
    return key;
  } catch (e) {
    console.error('Failed to log error to Redis:', e);
    return null;
  }
}

export async function logFailureToSheet(order, errorMessage) {
  try {
    const serviceAccountAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    await sheet.addRow({
      Timestamp: new Date().toISOString(),
      'Order Number': order?.name || 'unknown',
      'Customer Email': order?.email || '',
      'Error Message': errorMessage,
      'Order JSON': JSON.stringify(order || {}).slice(0, 5000),
      Retried: 'No',
    });
  } catch (e) {
    console.error('Failed to log error to Google Sheet:', e);
  }
}

export async function logFailure(order, errorMessage) {
  return await Promise.all([logFailureToRedis(order, errorMessage), logFailureToSheet(order, errorMessage)]);
}

// ============================================================
// DISCOUNT CONFIG
// ============================================================
const GENERAL_TAGS = {
  '30% off': 30,
  diamond: 25,
  platinum: 20,
  gold: 15,
  silver: 10,
  bronze: 5,
  oralux: 20,
};

const SURGICAL_TAGS = {
  '5% surgical': { type: 'percent', value: 5 },
  '10% surgical': { type: 'percent', value: 10 },
  '15% surgical': { type: 'percent', value: 15 },
  '20% surgical': { type: 'percent', value: 20 },
  '30% surgical': { type: 'percent', value: 30 },
  '40% surgical': { type: 'percent', value: 40 },
  '145 surgical': { type: 'fixed', value: 105 },
};

const ACCOUNT_TAXABLE = '201';
const ACCOUNT_GST_FREE = '200';
const TAX_TYPE_TAXABLE = 'OUTPUT';
const TAX_TYPE_GST_FREE = 'EXEMPTOUTPUT';

// ============================================================
// XERO TOKEN REFRESH (tokens expire every 30 min)
// ============================================================
export async function getValidXeroToken() {
  const expiresAt = await redis.get('xero:token_expires_at');
  const accessToken = await redis.get('xero:access_token');

  if (accessToken && expiresAt && Date.now() < expiresAt - 60000) {
    return accessToken;
  }

  const refreshToken = await redis.get('xero:refresh_token');
  if (!refreshToken) {
    throw new Error('No Xero refresh token found. Visit /api/xero-auth to connect Xero first.');
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  const response = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error('Failed to refresh Xero token: ' + JSON.stringify(data));
  }

  await redis.set('xero:access_token', data.access_token);
  await redis.set('xero:refresh_token', data.refresh_token);
  await redis.set('xero:token_expires_at', Date.now() + data.expires_in * 1000);

  return data.access_token;
}

// ============================================================
// FIND OR CREATE XERO CONTACT
// ============================================================
async function findOrCreateContact(accessToken, tenantId, name, email) {
  const searchUrl = `https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(
    `EmailAddress="${email}"`
  )}`;

  const searchResponse = await fetch(searchUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      Accept: 'application/json',
    },
  });

  const searchData = await searchResponse.json();

  if (searchData.Contacts && searchData.Contacts.length > 0) {
    const existingContactId = searchData.Contacts[0].ContactID;
    const existingName = searchData.Contacts[0].Name;

    if (existingName !== name) {
      const updateResponse = await fetch(`https://api.xero.com/api.xro/2.0/Contacts/${existingContactId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Xero-tenant-id': tenantId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          Contacts: [{ ContactID: existingContactId, Name: name }],
        }),
      });
      if (!updateResponse.ok) {
        const updateData = await updateResponse.json();
        console.error('Failed to update contact name:', updateData);
      }
    }

    return existingContactId;
  }

  const createResponse = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      Contacts: [{ Name: name, EmailAddress: email }],
    }),
  });

  const createData = await createResponse.json();

  if (!createResponse.ok) {
    throw new Error('Failed to create Xero contact: ' + JSON.stringify(createData));
  }

  return createData.Contacts[0].ContactID;
}

// ============================================================
// CORE: PROCESS A SHOPIFY ORDER INTO A XERO INVOICE
// ============================================================
// Used by both the live webhook and the retry endpoint.
// Throws on failure — caller is responsible for logging.
export async function processOrderToXeroInvoice(order) {
  // --- Parse order tags ---
  const rawTags = (order.tags || '').toLowerCase().split(',').map((t) => t.trim());

  let generalDiscountPct = 0;
  for (const [tag, pct] of Object.entries(GENERAL_TAGS)) {
    if (rawTags.includes(tag)) {
      generalDiscountPct = Math.max(generalDiscountPct, pct);
    }
  }

  let surgicalDiscount = null;
  for (const [tag, config] of Object.entries(SURGICAL_TAGS)) {
    if (rawTags.includes(tag)) {
      surgicalDiscount = config;
      break;
    }
  }

  // --- Build Xero line items from Shopify line items ---
  const lineItems = (order.line_items || []).map((item) => {
    const isTaxable = item.taxable === true;
    const originalPrice = parseFloat(item.price) || 0;
    const quantity = item.quantity || 1;
    const lineSubtotal = originalPrice * quantity;

    let discountAmount = 0;
    if (Array.isArray(item.discount_allocations)) {
      for (const alloc of item.discount_allocations) {
        const amt = parseFloat(alloc.allocatedAmountSet?.shopMoney?.amount ?? alloc.amount ?? 0);
        discountAmount += amt;
      }
    }

    let discountRate = 0;
    if (discountAmount > 0 && lineSubtotal > 0) {
      discountRate = Math.round((discountAmount / lineSubtotal) * 10000) / 100;
    }

    let description = item.title || 'Item';
    if (item.variant_title && item.variant_title !== 'Default Title') {
      description += ` — ${item.variant_title}`;
    }

    const lineItem = {
      Description: description,
      Quantity: quantity,
      UnitAmount: originalPrice,
      AccountCode: isTaxable ? ACCOUNT_TAXABLE : ACCOUNT_GST_FREE,
      TaxType: isTaxable ? TAX_TYPE_TAXABLE : TAX_TYPE_GST_FREE,
    };

    if (discountRate > 0) {
      lineItem.DiscountRate = discountRate;
    }

    return lineItem;
  });

  // --- Add shipping as its own line item ---
  if (Array.isArray(order.shipping_lines) && order.shipping_lines.length > 0) {
    for (const shippingLine of order.shipping_lines) {
      const shippingPrice = parseFloat(shippingLine.price) || 0;
      if (shippingPrice > 0) {
        lineItems.push({
          Description: shippingLine.title ? `Shipping — ${shippingLine.title}` : 'Shipping',
          Quantity: 1,
          UnitAmount: shippingPrice,
          AccountCode: ACCOUNT_GST_FREE,
          TaxType: TAX_TYPE_GST_FREE,
        });
      }
    }
  }

  if (lineItems.length === 0) {
    throw new Error('Order has no line items');
  }

  // --- Get a valid Xero access token ---
  const accessToken = await getValidXeroToken();
  const tenantId = await redis.get('xero:tenant_id');

  // --- Find or create the Xero contact ---
  let customerName = '';
  if (order.shipping_address?.name) {
    customerName = order.shipping_address.name.trim();
  } else if (order.billing_address?.name) {
    customerName = order.billing_address.name.trim();
  } else if (order.customer?.first_name || order.customer?.last_name) {
    customerName = `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim();
  } else if (order.email) {
    customerName = order.email.split('@')[0];
  } else {
    customerName = 'Shopify Customer';
  }

  const customerEmail = order.email || order.customer?.email || '';

  const contactId = await findOrCreateContact(accessToken, tenantId, customerName, customerEmail);

  // --- Create the invoice ---
  const invoiceNumber = order.name || `#${order.order_number}`;
  const invoiceReference = order.note || '';

  const invoicePayload = {
    Invoices: [
      {
        Type: 'ACCREC',
        Contact: { ContactID: contactId },
        LineItems: lineItems,
        Date: order.created_at ? order.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
        DueDate: order.created_at
          ? new Date(new Date(order.created_at).getTime() + 30 * 24 * 60 * 60 * 1000)
              .toISOString()
              .split('T')[0]
          : undefined,
        InvoiceNumber: invoiceNumber,
        Reference: invoiceReference,
        Status: 'DRAFT',
      },
    ],
  };

  const invoiceResponse = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(invoicePayload),
  });

  const invoiceData = await invoiceResponse.json();

  if (!invoiceResponse.ok) {
    throw new Error('Xero invoice creation failed: ' + JSON.stringify(invoiceData).slice(0, 1000));
  }

  return {
    success: true,
    orderName: order.name,
    xeroInvoiceId: invoiceData.Invoices?.[0]?.InvoiceID,
    lineItemsCount: lineItems.length,
    generalDiscountApplied: generalDiscountPct > 0 ? `${generalDiscountPct}%` : 'none',
    surgicalDiscountApplied: surgicalDiscount
      ? surgicalDiscount.type === 'fixed'
        ? `$${surgicalDiscount.value}`
        : `${surgicalDiscount.value}%`
      : 'none',
  };
}
