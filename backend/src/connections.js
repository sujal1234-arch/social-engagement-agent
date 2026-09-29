/**
 * Social account connection layer.
 *
 * Per platform we support two modes:
 *  - real OAuth2: when LINKEDIN_CLIENT_ID / INSTAGRAM_CLIENT_ID / etc. are set,
 *    /api/connect/:platform/start redirects to the provider consent screen and
 *    /callback exchanges the code for a real access token.
 *  - demo consent: when credentials are not configured, a local consent screen
 *    (clearly labeled "demo consent") issues a simulated token + account so the
 *    full connect -> scope -> import -> per-user memory flow works today.
 *
 * Every imported memory is tagged `user:<id>` + `platform:<platform>`; recall
 * filters on those tags so users only ever see their own history.
 */

export const PLATFORMS = {
  linkedin: {
    label: 'LinkedIn',
    scopes: ['r_liteprofile', 'r_emailaddress', 'w_member_social'],
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    env: { clientId: 'LINKEDIN_CLIENT_ID', clientSecret: 'LINKEDIN_CLIENT_SECRET' },
  },
  instagram: {
    label: 'Instagram',
    scopes: ['instagram_basic', 'instagram_manage_insights', 'instagram_manage_comments'],
    authUrl: 'https://api.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    env: { clientId: 'INSTAGRAM_CLIENT_ID', clientSecret: 'INSTAGRAM_CLIENT_SECRET' },
  },
  tiktok: {
    label: 'TikTok',
    scopes: ['user.info.basic', 'video.list', 'video.publish'],
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    env: { clientId: 'TIKTOK_CLIENT_KEY', clientSecret: 'TIKTOK_CLIENT_SECRET' },
  },
  youtube: {
    label: 'YouTube',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    env: { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET' },
  },
  x: {
    label: 'X (Twitter)',
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    env: { clientId: 'X_CLIENT_ID', clientSecret: 'X_CLIENT_SECRET' },
  },
  facebook: {
    label: 'Facebook',
    scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    authUrl: 'https://www.facebook.com/v19.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v19.0/oauth/access_token',
    env: { clientId: 'FACEBOOK_CLIENT_ID', clientSecret: 'FACEBOOK_CLIENT_SECRET' },
  },
  pinterest: {
    label: 'Pinterest',
    scopes: ['boards:read', 'pins:read', 'pins:write', 'user_accounts:read'],
    authUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    env: { clientId: 'PINTEREST_CLIENT_ID', clientSecret: 'PINTEREST_CLIENT_SECRET' },
  },
  reddit: {
    label: 'Reddit',
    scopes: ['identity', 'read', 'submit'],
    authUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    env: { clientId: 'REDDIT_CLIENT_ID', clientSecret: 'REDDIT_CLIENT_SECRET' },
  },
  telegram: {
    label: 'Telegram / WhatsApp',
    scopes: [],
    authUrl: null, // bot-token / QR based, no browser OAuth
    tokenUrl: null,
    env: { clientId: 'TELEGRAM_BOT_TOKEN', clientSecret: null },
  },
};

export function platformList() {
  return Object.entries(PLATFORMS).map(([id, p]) => ({
    id,
    label: p.label,
    scopes: p.scopes,
    oauthConfigured: Boolean(process.env[p.env.clientId]),
    supported: true,
  }));
}

export function platformConfigured(platform) {
  const p = PLATFORMS[platform];
  return Boolean(p && process.env[p.env.clientId]);
}

export function authorizeUrl(platform, { redirectUri, state }) {
  const p = PLATFORMS[platform];
  if (!p?.authUrl) return null;
  const url = new URL(p.authUrl);
  const clientId = process.env[p.env.clientId];
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  if (p.scopes.length) url.searchParams.set('scope', p.scopes.join(p.id === 'reddit' ? ' ' : ','));
  url.searchParams.set('state', state);
  if (p.id === 'x') {
    url.searchParams.set('code_challenge', 'challenge');
    url.searchParams.set('code_challenge_method', 'plain');
  }
  return url.toString();
}

/** Exchange an OAuth code for a real access token (used when configured). */
export async function exchangeCode(platform, { code, redirectUri }) {
  const p = PLATFORMS[platform];
  const body = new URLSearchParams({
    code,
    client_id: process.env[p.env.clientId],
    client_secret: process.env[p.env.clientSecret] || '',
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  const res = await fetch(p.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status}`);
  return res.json();
}

/** Demo-consent identity for a platform when real OAuth is not configured. */
export function demoIdentity(platform, user) {
  const p = PLATFORMS[platform];
  const handle = (user.name || user.email.split('@')[0]).toLowerCase().replace(/[^a-z0-9]/g, '');
  return {
    platform_user_id: `${platform}_${handle}`,
    platform_username: `@${handle}`,
    scopes: p.scopes,
    access_token: `demo_${platform}_${Math.random().toString(36).slice(2, 18)}`,
    mode: 'demo',
  };
}
