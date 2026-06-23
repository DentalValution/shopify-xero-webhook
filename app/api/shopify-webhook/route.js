import { NextResponse } from 'next/server';
import crypto from 'crypto';
import { processOrderToXeroInvoice, logFailure } from '@/lib/processOrder';

// ============================================================
// VERIFY SHOPIFY WEBHOOK SIGNATURE
// ============================================================
function verifyShopifyWebhook(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true; // skip verification if not configured yet
  const generatedHash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  return generatedHash === hmacHeader;
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
    const result = await processOrderToXeroInvoice(order);
    console.log(`✅ Created Xero invoice for order ${order.name}`);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Webhook processing error:', err);
    await logFailure(order, err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
