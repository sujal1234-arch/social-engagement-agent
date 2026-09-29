/**
 * Google Sign-In (OpenID Connect).
 *
 * Real flow when GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET are set; otherwise the
 * app offers a clearly-labelled demo sign-in so the flow is demonstrable without
 * provider credentials. The same Google app also covers the YouTube connection,
 * since both use the Google OAuth client.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleAuthorizeUrl({ redirectUri, state }) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function googleExchangeCode({ code, redirectUri }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: HTTP ${res.status}`);
  return res.json();
}

export async function googleUserInfo(accessToken) {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google userinfo failed: HTTP ${res.status}`);
  const data = await res.json();
  return { email: data.email, name: data.name || data.email, sub: data.sub, picture: data.picture || '' };
}
