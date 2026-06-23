import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { processOrderToXeroInvoice } from '@/lib/processOrder';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function checkAuth(request) {
  const providedSecret =
    request.headers.get('x-admin-secret') || new URL(request.url).searchParams.get('secret');
  return providedSecret === process.env.ADMIN_RETRY_SECRET;
}

// ============================================================
// GET — list all failed orders (does not retry anything)
// ============================================================
export async function GET(request) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const keys = await redis.lrange('failed_orders_list', 0, -1);
    const uniqueKeys = [...new Set(keys)];

    const records = await Promise.all(
      uniqueKeys.map(async (key) => {
        const data = await redis.get(key);
        if (!data) return null;
        const parsed = typeof data === 'string' ? JSON.parse(data) : data;
        return { key, ...parsed };
      })
    );

    const validRecords = records.filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return NextResponse.json({ count: validRecords.length, failures: validRecords });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ============================================================
// POST — retry one specific failed order, or all of them
// Body: { key: "failed_order:..." } to retry one
// Body: { retryAll: true } to retry every unretried failure
// ============================================================
export async function POST(request) {
  if (!checkAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const results = [];

  try {
    let keysToRetry = [];

    if (body.key) {
      keysToRetry = [body.key];
    } else if (body.retryAll) {
      const allKeys = await redis.lrange('failed_orders_list', 0, -1);
      keysToRetry = [...new Set(allKeys)];
    } else {
      return NextResponse.json({ error: 'Provide either "key" or "retryAll": true' }, { status: 400 });
    }

    for (const key of keysToRetry) {
      const data = await redis.get(key);
      if (!data) {
        results.push({ key, success: false, error: 'Record not found in Redis' });
        continue;
      }

      const record = typeof data === 'string' ? JSON.parse(data) : data;

      // Skip ones already successfully retried
      if (record.retried === true) {
        results.push({ key, success: true, skipped: true, message: 'Already retried' });
        continue;
      }

      try {
        const invoiceResult = await processOrderToXeroInvoice(record.orderData);

        // Mark as retried successfully
        record.retried = true;
        record.retriedAt = new Date().toISOString();
        record.xeroInvoiceId = invoiceResult.xeroInvoiceId;
        await redis.set(key, JSON.stringify(record));

        results.push({ key, success: true, orderName: record.orderNumber, xeroInvoiceId: invoiceResult.xeroInvoiceId });
      } catch (retryErr) {
        results.push({ key, success: false, orderName: record.orderNumber, error: retryErr.message });
      }
    }

    return NextResponse.json({
      totalAttempted: results.length,
      succeeded: results.filter((r) => r.success && !r.skipped).length,
      skipped: results.filter((r) => r.skipped).length,
      failed: results.filter((r) => !r.success).length,
      results,
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
