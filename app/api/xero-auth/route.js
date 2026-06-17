import { NextResponse } from 'next/server';

// Visit this route once in your browser (e.g. https://your-app.vercel.app/api/xero-auth)
// to start the Xero login/consent flow. After you click "Allow access" in Xero,
// you'll be redirected to /api/xero-callback which saves the token.

export async function GET() {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      { error: 'Missing XERO_CLIENT_ID or XERO_REDIRECT_URI in environment variables' },
      { status: 500 }
    );
  }

  // Scopes needed: read/write invoices, read/write contacts, offline_access for refresh tokens
  // Updated for Xero's granular scopes (required for all apps created after March 2, 2026)
  const scopes = [
    'openid',
    'profile',
    'email',
    'accounting.contacts',
    'accounting.contacts.read',
    'accounting.invoices',
    'accounting.invoices.read',
    'offline_access',
  ].join(' ');

  const state = Math.random().toString(36).substring(2, 15); // basic anti-CSRF token

  const authUrl =
    'https://login.xero.com/identity/connect/authorize' +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}`;

  return NextResponse.redirect(authUrl);
}
