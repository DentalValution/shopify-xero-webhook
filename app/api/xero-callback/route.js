import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const error = searchParams.get('error');

  if (error) {
    return NextResponse.json({ error: `Xero returned an error: ${error}` }, { status: 400 });
  }

  if (!code) {
    return NextResponse.json({ error: 'No authorization code received from Xero' }, { status: 400 });
  }

  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  try {
    // Exchange the authorization code for access + refresh tokens
    const tokenResponse = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok) {
      console.error('Xero token exchange failed:', tokenData);
      return NextResponse.json({ error: 'Token exchange failed', details: tokenData }, { status: 500 });
    }

    // Get the Xero "tenant" (organisation) ID — required for every future API call
    const connectionsResponse = await fetch('https://api.xero.com/connections', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const connections = await connectionsResponse.json();

    if (!connections || connections.length === 0) {
      return NextResponse.json({ error: 'No Xero organisation connected to this app' }, { status: 500 });
    }

    const tenantId = connections[0].tenantId;
    const tenantName = connections[0].tenantName;

    // Save everything to Redis so the webhook route can use it later
    await redis.set('xero:access_token', tokenData.access_token);
    await redis.set('xero:refresh_token', tokenData.refresh_token);
    await redis.set('xero:tenant_id', tenantId);
    await redis.set('xero:token_expires_at', Date.now() + tokenData.expires_in * 1000);

    return NextResponse.json({
      success: true,
      message: `Successfully connected to Xero organisation: ${tenantName}`,
      tenantId,
    });
  } catch (err) {
    console.error('Xero callback error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
