import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
// VERIFY SHOPIFY WEBHOOK SIGNATURE
// ============================================================
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // skip verification if not configured yet (set this up before going live)
  const generatedHash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');

  // TEMPORARY DEBUG — remove once verification is confirmed working
  console.log('--- HMAC DEBUG ---');
  console.log('Secret length:', secret.length);
  console.log('Secret first/last char codes:', secret.charCodeAt(0), secret.charCodeAt(secret.length - 1));
  console.log('Header received:', hmacHeader);
  console.log('Generated hash:', generatedHash);
  console.log('Match:', generatedHash === hmacHeader);
  console.log('------------------');

  return generatedHash === hmacHeader;
}

// ============================================================
// XERO TOKEN REFRESH (tokens expire every 30 min)
// ============================================================
async function getValidXeroToken() {
  const expiresAt = await redis.get('xero:token_expires_at');
  const accessToken = await redis.get('xero:access_token');

  // If token still valid for at least 60 more seconds, reuse it
  if (accessToken && expiresAt && Date.now() < expiresAt - 60000) {
    return accessToken;
  }

  // Otherwise refresh it
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
  // Search by email first
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
    return searchData.Contacts[0].ContactID;
  }

  // Not found — create a new contact
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
// MAIN WEBHOOK HANDLER
// ============================================================
export async function POST(request) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('x-shopify-hmac-sha256');

  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (e) {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  try {
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
      const isSurgical = (item.title || '').toLowerCase().includes('surgical guide');
      const isTaxable = item.taxable === true;
      const originalPrice = parseFloat(item.price) || 0;

      let unitPrice = originalPrice;

      if (generalDiscountPct > 0) {
        unitPrice = unitPrice * (1 - generalDiscountPct / 100);
      }

      if (isSurgical && surgicalDiscount) {
        if (surgicalDiscount.type === 'percent') {
          unitPrice = unitPrice * (1 - surgicalDiscount.value / 100);
        } else {
          unitPrice = unitPrice - surgicalDiscount.value;
        }
      }

      unitPrice = Math.max(0, Math.round(unitPrice * 100) / 100);

      let description = item.title || 'Item';
      if (item.variant_title && item.variant_title !== 'Default Title') {
        description += ` — ${item.variant_title}`;
      }

      return {
        Description: description,
        Quantity: item.quantity || 1,
        UnitAmount: unitPrice,
        AccountCode: isTaxable ? ACCOUNT_TAXABLE : ACCOUNT_GST_FREE,
        TaxType: isTaxable ? TAX_TYPE_TAXABLE : TAX_TYPE_GST_FREE,
      };
    });

    if (lineItems.length === 0) {
      return NextResponse.json({ error: 'Order has no line items' }, { status: 400 });
    }

    // --- Get a valid Xero access token (refreshes automatically if expired) ---
    const accessToken = await getValidXeroToken();
    const tenantId = await redis.get('xero:tenant_id');

    // --- Find or create the Xero contact ---
    const customerName =
      `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim() ||
      order.billing_address?.name ||
      'Shopify Customer';
    const customerEmail = order.email || order.customer?.email || '';

    const contactId = await findOrCreateContact(accessToken, tenantId, customerName, customerEmail);

    // --- Create the invoice ---
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
          Reference: order.name || `#${order.order_number}`,
          Status: 'AUTHORISED',
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
      console.error('Xero invoice creation failed:', invoiceData);
      return NextResponse.json({ error: 'Xero invoice creation failed', details: invoiceData }, { status: 500 });
    }

    console.log(`✅ Created Xero invoice for order ${order.name}`);

    return NextResponse.json({
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
    });
  } catch (err) {
    console.error('Webhook processing error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
