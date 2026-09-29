import './load-env.js';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readCsv, toInt } from './csv.js';
import { retain, recall, listMemories, hindsightMode, bankId, ensureBank } from './hindsight.js';
import {
  generateRecommendation,
  generateReply,
  classifyComment,
  templateReply,
  llmProviderName,
} from './llm.js';
import { createAb, addScheduledPost, getAb, listAbs, simulateResults, saveAb } from './ab.js';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  requireAuth,
  authOptional,
  encryptToken,
  decryptToken,
  rateLimit,
  newOpaqueToken,
  hashToken,
  authSecretSource,
} from './auth.js';
import {
  initDb,
  dbEngine,
  findUserByEmail,
  createUser,
  getUser,
  listConnections,
  getConnection,
  upsertConnection,
  deleteConnection,
  saveToken,
  consumeToken,
  revokeTokensForUser,
  setUserPassword,
  getShareScope,
  setShareScope,
} from './db.js';
import { PLATFORMS, platformList, platformConfigured, authorizeUrl, exchangeCode, demoIdentity } from './connections.js';
import { retainUserPosts, retainWinnerForUser, userTags } from './user-memory.js';
import { fetchPlatformMetrics, metricLabelFor } from './metrics.js';
import { googleConfigured, googleAuthorizeUrl, googleExchangeCode, googleUserInfo } from './google-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT) || 4000;
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');

function postsPath() {
  return process.env.POSTS_CSV || path.join(DATA_DIR, 'posts.csv');
}
function commentsPath() {
  return process.env.COMMENTS_CSV || path.join(DATA_DIR, 'comments.csv');
}

function ctrPercent(p) {
  const impressions = toInt(p.impressions, 0);
  if (!impressions) return 0;
  return Number(((toInt(p.clicks, 0) / impressions) * 100).toFixed(2));
}

function postMemory(p, extraTags = []) {
  const ctr = ctrPercent(p);
  const tags = [
    'post',
    `platform:${p.platform}`,
    ctr >= 5 ? 'top_performer' : ctr >= 3.5 ? 'solid' : 'low_performer',
    ...extraTags,
  ];
  const metrics = `Impressions ${toInt(p.impressions)}, clicks ${toInt(p.clicks)}, likes ${toInt(p.likes)}, comments ${toInt(p.comments)}, shares ${toInt(p.shares)} — CTR ${ctr}% (this is one of the account's ${ctr >= 5 ? 'best' : ctr >= 3.5 ? 'good' : 'weak'}) posts`;
  const content = `LinkedIn/X post (post_id ${p.post_id}): "${p.text}". Performance: ${metrics}.`;
  return {
    content,
    context: 'social post performance',
    timestamp: p.timestamp,
    document_id: `post_${p.post_id}`,
    tags,
    metadata: {
      kind: 'post',
      post_id: String(p.post_id),
      platform: p.platform,
      ctr_percent: String(ctr),
      impressions: String(toInt(p.impressions)),
      clicks: String(toInt(p.clicks)),
      text: String(p.text),
    },
  };
}

function commentMemory(c) {
  const tag = classifyComment(c.text);
  const content = `Comment on post_id ${c.post_id} by ${c.user}: "${c.text}" — recurring issue tag: ${tag}.`;
  return {
    content,
    context: 'social comment',
    timestamp: c.timestamp,
    document_id: `comment_${c.comment_id}`,
    tags: ['comment', `issue:${tag}`, `post:${c.post_id}`],
    metadata: {
      kind: 'comment',
      comment_id: String(c.comment_id),
      post_id: String(c.post_id),
      user: String(c.user),
      issue_tag: tag,
      text: String(c.text),
    },
  };
}

function topHookMemory({ hook, ab_id, ctr, uplift, platform, why }) {
  return {
    content: `Top hook that won an A/B test: "${hook}" — achieved ${ctr}% CTR, ${uplift}x uplift vs control. Why it works: ${why}`,
    context: 'A/B test winning hook',
    timestamp: new Date().toISOString(),
    document_id: `top_hook_${ab_id}`,
    tags: ['top_hook', `platform:${platform}`, 'ab_winner'],
    metadata: {
      kind: 'top_hook',
      hook: String(hook),
      ab_id: String(ab_id),
      ctr_percent: String(ctr),
      uplift: String(uplift),
      why: String(why || ''),
    },
  };
}

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    memory_mode: hindsightMode(),
    memory_bank: bankId(),
    llm: llmProviderName(),
    db: dbEngine(),
    auth: 'jwt',
    auth_secret: authSecretSource(),
  });
});
await initDb();

/* =================== AUTH =================== */

// POST /api/register { email, password, name } -> { token, refresh_token, user }
app.post(
  '/api/register',
  rateLimit({ windowMs: 60 * 60_000, max: 20, keyFn: (req) => `register:${req.ip}` }),
  async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (await findUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists' });
    const user = await createUser({ email, name, passwordHash: hashPassword(password) });
    const token = signJwt({ sub: user.id, email: user.email, name: user.name });
    const refresh_token = await issueRefreshToken(user);
    res.json({ ok: true, token, refresh_token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
);

/** Issue a 30-day refresh token; only its hash is stored. */
async function issueRefreshToken(user) {
  const { raw, hash } = newOpaqueToken();
  await saveToken({
    tokenHash: hash,
    userId: user.id,
    kind: 'refresh',
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  return raw;
}

// POST /api/refresh { refresh_token } -> new access token (rotates the refresh token)
app.post(
  '/api/refresh',
  rateLimit({ windowMs: 15 * 60_000, max: 60, keyFn: (req) => `refresh:${req.ip}` }),
  async (req, res) => {
    const raw = String(req.body?.refresh_token || '');
    if (!raw) return res.status(400).json({ error: 'refresh_token required' });
    const userId = await consumeToken({ tokenHash: hashToken(raw), kind: 'refresh' });
    if (!userId) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const user = await getUser(userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const token = signJwt({ sub: user.id, email: user.email, name: user.name });
    const refresh_token = await issueRefreshToken(user);
    res.json({ ok: true, token, refresh_token, user: { id: user.id, email: user.email, name: user.name } });
  }
);

// POST /api/logout — revoke every refresh token for the caller
app.post('/api/logout', requireAuth, async (req, res) => {
  await revokeTokensForUser(req.user.id, 'refresh');
  res.json({ ok: true });
});

// POST /api/password/reset-request { email }
// Answers identically whether or not the account exists (no enumeration).
// The token is returned only with AUTH_DEV_MODE=1 — wire SMTP to email it.
app.post(
  '/api/password/reset-request',
  rateLimit({ windowMs: 15 * 60_000, max: 5, keyFn: (req) => `reset:${req.ip}:${String(req.body?.email || '').toLowerCase()}` }),
  async (req, res) => {
    const email = String(req.body?.email || '').toLowerCase();
    const user = await findUserByEmail(email);
    const generic = { ok: true, message: 'If that account exists, a reset link has been sent.' };
    if (!user) return res.json(generic);
    const { raw, hash } = newOpaqueToken();
    await saveToken({
      tokenHash: hash,
      userId: user.id,
      kind: 'reset',
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    if (process.env.AUTH_DEV_MODE === '1') return res.json({ ...generic, dev_reset_token: raw });
    // TODO: deliver via SMTP when SMTP_HOST/SMTP_USER/SMTP_PASS are configured.
    res.json(generic);
  }
);

// POST /api/password/reset { token, password }
app.post('/api/password/reset', async (req, res) => {
  const raw = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const userId = await consumeToken({ tokenHash: hashToken(raw), kind: 'reset' });
  if (!userId) return res.status(400).json({ error: 'Invalid or expired reset token' });
  await setUserPassword(userId, hashPassword(password));
  await revokeTokensForUser(userId, 'refresh');
  res.json({ ok: true, message: 'Password updated — sign in again.' });
});

// POST /api/login { email, password } -> { token, refresh_token, user }
app.post(
  '/api/login',
  rateLimit({ windowMs: 15 * 60_000, max: 10, keyFn: (req) => `login:${req.ip}:${String(req.body?.email || '').toLowerCase()}` }),
  async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const token = signJwt({ sub: user.id, email: user.email, name: user.name });
    const refresh_token = await issueRefreshToken(user);
    res.json({ ok: true, token, refresh_token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
);

/* ============ GOOGLE SIGN-IN ============ */

// GET /api/auth/google/start — redirect to Google, or report demo mode
app.get('/api/auth/google/start', (req, res) => {
  if (!googleConfigured()) {
    return res.json({
      ok: true,
      demo: true,
      message: 'GOOGLE_CLIENT_ID/SECRET are not configured — using demo Google sign-in.',
    });
  }
  const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
  const state = crypto.randomBytes(16).toString('base64url');
  res.redirect(googleAuthorizeUrl({ redirectUri, state }));
});

// POST /api/auth/google/demo { email, name } — labelled demo sign-in
app.post(
  '/api/auth/google/demo',
  rateLimit({ windowMs: 15 * 60_000, max: 20, keyFn: (req) => `gdemo:${req.ip}` }),
  async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const name = String(req.body?.name || '').trim() || email.split('@')[0];
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
      const user = await findOrCreateOAuthUser({ email, name });
      const token = signJwt({ sub: user.id, email: user.email, name: user.name });
      const refresh_token = await issueRefreshToken(user);
      res.json({ ok: true, demo: true, token, refresh_token, user: { id: user.id, email: user.email, name: user.name } });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  }
);

// GET /api/auth/google/callback — real OAuth redirect from Google
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/auth/google/callback`;
    const tokens = await googleExchangeCode({ code: req.query.code, redirectUri });
    const profile = await googleUserInfo(tokens.access_token);
    if (!profile.email) throw new Error('Google did not return an email');
    const user = await findOrCreateOAuthUser({ email: profile.email, name: profile.name });
    // Hand the browser a short-lived signed code, never the session token itself.
    const code = signJwt({ sub: user.id, email: user.email, name: user.name, act: 'google' }, { expiresIn: '5m' });
    res.redirect(`/?google_auth=${encodeURIComponent(code)}`);
  } catch (err) {
    res.redirect(`/?google_error=${encodeURIComponent(String(err.message || err))}`);
  }
});

// POST /api/auth/google/exchange { code } — trade the redirect code for a session
app.post('/api/auth/google/exchange', async (req, res) => {
  const payload = verifyJwt(String(req.body?.code || ''));
  if (!payload?.act || payload.act !== 'google') return res.status(400).json({ error: 'Invalid or expired sign-in code' });
  const user = await getUser(payload.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = signJwt({ sub: user.id, email: user.email, name: user.name });
  const refresh_token = await issueRefreshToken(user);
  res.json({ ok: true, token, refresh_token, user: { id: user.id, email: user.email, name: user.name } });
});

/** Create the account on first Google sign-in; link to it afterwards. */
async function findOrCreateOAuthUser({ email, name }) {
  const existing = await findUserByEmail(email);
  if (existing) return existing;
  // No usable password for OAuth-only accounts (never guessable).
  const unusable = `oauth:${crypto.randomBytes(24).toString('base64url')}`;
  return createUser({ email, name, passwordHash: hashPassword(unusable) });
}

/* ============ PREFERENCES ============ */

// GET /api/preferences — memory sharing scope
app.get('/api/preferences', requireAuth, async (req, res) => {
  res.json({ share_scope: await getShareScope(req.user.id) });
});

// POST /api/preferences { share_scope: 'personal' | 'team' }
app.post('/api/preferences', requireAuth, async (req, res) => {
  const scope = await setShareScope(req.user.id, String(req.body?.share_scope || 'personal'));
  res.json({ ok: true, share_scope: scope });
});

// GET /api/me — current profile + connected accounts (auth required)
app.get('/api/me', requireAuth, async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const connections = await listConnections(req.user.id);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      created_at: user.created_at,
      share_scope: await getShareScope(user.id),
    },
    connections: connections.map((c) => ({
      platform: c.platform,
      username: c.platform_username,
      scopes: c.scopes ? c.scopes.split(/[, ]+/).filter(Boolean) : [],
      connected_at: c.connected_at,
    })),
  });
});

/* ============ CONNECTED ACCOUNTS ============ */

// GET /api/platforms — registry + per-platform OAuth configured?
app.get('/api/platforms', (_req, res) => {
  res.json({ platforms: platformList() });
});

// GET /api/connect/:platform/start — begin OAuth (redirects when configured)
app.get('/api/connect/:platform/start', requireAuth, (req, res) => {
  const platform = req.params.platform;
  if (!PLATFORMS[platform]) return res.status(400).json({ error: `Unknown platform ${platform}` });
  if (platformConfigured(platform) && PLATFORMS[platform].authUrl) {
    const state = Buffer.from(JSON.stringify({ uid: req.user.id, platform })).toString('base64url');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/connect/${platform}/callback`;
    return res.redirect(authorizeUrl(platform, { redirectUri, state }));
  }
  // Demo consent: no provider credentials configured on this deployment.
  res.json({
    ok: true,
    demo: true,
    platform,
    label: PLATFORMS[platform].label,
    scopes: PLATFORMS[platform].scopes,
    confirm_url: `/api/connect/${platform}/demo?token=${signJwt({ sub: req.user.id, email: req.user.email, name: req.user.name, act: 'connect', platform }, { expiresIn: '1h' })}`,
  });
});

// GET /api/connect/:platform/demo?token=... — confirm demo consent
app.get('/api/connect/:platform/demo', async (req, res) => {
  const payload = decryptJwtPayload(req.query.token);
  if (!payload?.act || payload.act !== 'connect') return res.status(400).json({ error: 'Invalid or expired consent token' });
  const platform = req.params.platform;
  if (!PLATFORMS[platform]) return res.status(400).json({ error: 'Unknown platform' });
  const identity = demoIdentity(platform, { id: payload.sub, email: payload.email, name: payload.name });
  await upsertConnection({
    userId: payload.sub,
    platform,
    platformUserId: identity.platform_user_id,
    platformUsername: identity.platform_username,
    scopes: identity.scopes.join(','),
    accessTokenEnc: encryptToken(identity.access_token),
  });
  await retainUserPosts(payload.sub, platform);
  res.json({ ok: true, demo: true, platform, username: identity.platform_username, message: `${PLATFORMS[platform].label} connected (demo consent) — sample posts retained to your memory` });
});

// GET /api/connect/:platform/callback — real OAuth callback
app.get('/api/connect/:platform/callback', async (req, res) => {
  try {
    const platform = req.params.platform;
    if (!PLATFORMS[platform]) return res.status(400).send('Unknown platform');
    const state = JSON.parse(Buffer.from(String(req.query.state || ''), 'base64url').toString('utf8'));
    const redirectUri = `${req.protocol}://${req.get('host')}/api/connect/${platform}/callback`;
    const tokens = await exchangeCode(platform, { code: req.query.code, redirectUri });
    await upsertConnection({
      userId: state.uid,
      platform,
      platformUserId: tokens.user_id || '',
      platformUsername: tokens.username || '',
      scopes: tokens.scope || PLATFORMS[platform].scopes.join(','),
      accessTokenEnc: encryptToken(tokens.access_token),
    });
    await retainUserPosts(state.uid, platform);
    res.send(`<html><body style="font-family:sans-serif;background:#0b0e14;color:#e8ecf4;text-align:center;padding-top:80px"><h2>✅ ${PLATFORMS[platform].label} connected</h2><p>Posts imported to your memory. You can close this tab.</p></body></html>`);
  } catch (err) {
    res.status(500).send(`OAuth callback failed: ${String(err.message || err)}`);
  }
});

// POST /api/disconnect { platform }
app.post('/api/disconnect', requireAuth, async (req, res) => {
  const platform = String(req.body?.platform || '');
  if (!PLATFORMS[platform]) return res.status(400).json({ error: 'Unknown platform' });
  await deleteConnection(req.user.id, platform);
  res.json({ ok: true, platform });
});

function decryptJwtPayload(token) {
  return verifyJwt(token);
}

// POST /api/import — seed Hindsight with posts + comments from CSVs
app.post('/api/import', async (_req, res) => {
  try {
    await ensureBank();
    const posts = readCsv(postsPath());
    const comments = readCsv(commentsPath());
    const postItems = posts.map((p) => postMemory(p));
    const commentItems = comments.map((c) => commentMemory(c));
    const r1 = await retain(postItems);
    const r2 = await retain(commentItems);
    res.json({
      ok: true,
      posts: postItems.length,
      comments: commentItems.length,
      memory_mode: r1.mode || r2.mode,
      bank: bankId(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/recommend?channel=linkedin&topic=... — memory-informed recommendation
// Signed-in users get recall scoped to their own memories (user:<id> + platform).
app.get('/api/recommend', authOptional, async (req, res) => {
  try {
    const channel = String(req.query.channel || 'linkedin');
    const topic = String(req.query.topic || '');
    const teamScope = req.user ? (await getShareScope(req.user.id)) === 'team' : false;
    const scopeTags = req.user
      ? userTags(req.user.id, await platformIfConnected(req.user.id, channel))
      : ['top_performer'];
    // 1. Recall high-CTR winners from Hindsight memory.
    let facts = [];
    try {
      facts = await recall(
        `highest CTR posts about integrations, demos, before/after results${topic ? `, topic ${topic}` : ''}`,
        { tags: req.user ? scopeTags.filter((t) => !t.startsWith('platform:') || t !== `platform:${channel}`) : scopeTags, limit: 8 }
      );
      // Personal scope: fall back to the shared pool only when the user's own
      // history is thin. Team scope: always blend both, so recall spans accounts.
      const wantShared = !req.user || teamScope || facts.length < 3;
      if (wantShared) {
        const more = await recall('posts with best click-through rate and engagement', { limit: 10 });
        const seen = new Set(facts.map((f) => f.metadata?.post_id));
        facts = facts.concat(more.filter((f) => !seen.has(f.metadata?.post_id)));
      }
    } catch (err) {
      console.error('[recommend] recall failed:', err.message);
    }
    // 2. Map facts back to a numeric score + metric label, then dedupe.
    //    Per-platform metrics differ (CTR on LinkedIn/X, save-rate on
    //    Instagram/Pinterest, engagement on TikTok/YouTube), so the label is
    //    carried through to the provenance line. Hindsight also derives
    //    'observation' facts from each post — dedupe by post_id.
    const seen = new Set();
    const examples = facts
      .map((f) => {
        const m = f.metadata || {};
        const metric = m.ctr_percent ? 'CTR' : m.metric_name === 'save_rate_percent' ? 'saves' : 'engagement';
        const value = Number(m.ctr_percent || m.metric_value || 0);
        return {
          post_id: m.post_id || '?',
          text: m.text || f.text,
          ctr: value,
          metric,
          platform: m.platform || channel,
        };
      })
      .filter((e) => {
        if (!e.text || !e.ctr) return false;
        const key = `${e.platform}:${e.post_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.ctr - a.ctr)
      .slice(0, 3);
    // 3. LLM generates hook/caption/hashtags/best_time + provenance line.
    const rec = await generateRecommendation({ channel, topic, examples });
    res.json({
      ...rec,
      channel,
      examples,
      memory_mode: hindsightMode(),
      scoped: Boolean(req.user),
      memory_scope: req.user ? (teamScope ? 'team' : 'personal') : 'shared-demo',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** platform tag only if the user actually connected that platform */
async function platformIfConnected(userId, platform) {
  const c = await getConnection(userId, platform);
  return c ? platform : null;
}

// POST /api/create-ab { channel, topic, hook, hook_b, caption, hashtags, best_time }
app.post('/api/create-ab', authOptional, (req, res) => {
  const { channel = 'linkedin', topic = '', hook = '', hook_b = '', caption = '', hashtags = [], best_time = '' } = req.body || {};
  if (!hook || !hook_b) return res.status(400).json({ error: 'hook and hook_b are required' });
  const test = createAb({
    channel,
    topic,
    variantA: { hook, caption, hashtags, best_time },
    variantB: { hook: hook_b, caption, hashtags, best_time },
  });
  test.user_id = req.user?.id || null;
  saveAb(test);
  res.json({ ok: true, ab_id: test.id, test });
});

// POST /api/schedule { ab_id, variant: "A"|"B", time? } — mock scheduler
app.post('/api/schedule', (req, res) => {
  const { ab_id, variant = 'A', time = '', memory_informed = false } = req.body || {};
  const test = getAb(ab_id);
  if (!test) return res.status(404).json({ error: `unknown ab_id ${ab_id}` });
  const post = {
    variant,
    time: time || new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    scheduled: true,
    memory_informed: Boolean(memory_informed),
  };
  const updated = addScheduledPost(ab_id, post);
  const complete = updated.posts.filter((p) => p.scheduled).length >= 2;
  res.json({ ok: true, ab_id, post, both_scheduled: complete, status: updated.status });
});

// GET /api/ab-results/:id — real platform metrics when the account is connected,
// otherwise the deterministic simulator. The response always reports the source.
app.get('/api/ab-results/:id', authOptional, async (req, res) => {
  try {
    const test = getAb(req.params.id);
    if (!test) return res.status(404).json({ error: `unknown ab_id ${req.params.id}` });
    let results = null;
    let metricsSource = 'simulated';
    if (test.user_id || req.user?.id) {
      const real = await fetchPlatformMetrics({ userId: test.user_id || req.user.id, platform: test.channel, test });
      if (real) {
        results = { A: real.A, B: real.B, winner: real.winner, uplift: real.uplift, metric: real.metric };
        metricsSource = real.source;
        test.results = results;
        test.status = 'complete';
        saveAb(test);
      }
    }
    if (!results) results = simulateResults(test);
    let writeback = test.writeback;
    if (results.winner === 'A' && !writeback) {
      const w = results.A;
      writeback = topHookMemory({
        hook: test.variants.A.hook,
        ab_id: test.id,
        ctr: w.ctr,
        uplift: results.uplift,
        platform: test.channel,
        why: test.variants.A.why || 'hook pattern matched the account top performers in memory',
      });
      if (test.user_id) {
        await retainWinnerForUser(test.user_id, test.channel, writeback);
      } else {
        await retain([writeback]);
      }
      test.writeback = writeback;
      saveAb(test);
    }
    res.json({
      ab_id: test.id,
      status: test.status,
      channel: test.channel,
      variants: { A: test.variants.A, B: test.variants.B },
      results,
      metrics_source: metricsSource,
      metrics_note:
        metricsSource === 'platform-api'
          ? `Read from the connected ${test.channel} insights API`
          : `Simulated 48h (connect ${test.channel} with provider credentials to read real insights)`,
      metric: metricLabelFor(test.channel),
      memory_writeback: test.writeback,
      memory_mode: hindsightMode(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/ab-tests — list all tests (dashboard convenience)
app.get('/api/ab-tests', (_req, res) => {
  res.json({ tests: listAbs() });
});

// POST /api/reply-suggest { comment } — reply template + tag, recall-augmented
app.post('/api/reply-suggest', authOptional, async (req, res) => {
  try {
    const comment = String(req.body?.comment || '').trim();
    if (!comment) return res.status(400).json({ error: 'comment text is required' });
    let similar = [];
    try {
      const tags = req.user ? userTags(req.user.id) : [];
      similar = await recall(`comments similar to: ${comment}`, { limit: 5, ...(tags.length ? { tags } : {}) });
    } catch (err) {
      console.error('[reply] recall failed:', err.message);
    }
    const out = await generateReply({
      commentText: comment,
      similar: similar.map((s) => ({ text: s.metadata?.text || s.text, user: s.metadata?.user || 'user', post_id: s.metadata?.post_id })),
    });
    res.json({ comment, ...out, similar_count: similar.length, memory_mode: hindsightMode() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/comments — seed comments for the reply modal
app.get('/api/comments', (_req, res) => {
  try {
    const comments = readCsv(commentsPath());
    const posts = readCsv(postsPath());
    const byId = Object.fromEntries(posts.map((p) => [p.post_id, p]));
    res.json({
      comments: comments.map((c) => ({
        ...c,
        tag: classifyComment(c.text),
        suggested_reply: templateReply(c.text, classifyComment(c.text)),
        post_text: byId[c.post_id]?.text || '',
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/memory — show what is stored in Hindsight (provenance / transparency panel)
// Signed-in users see only their own memories; anonymous callers see the shared demo pool.
app.get('/api/memory', authOptional, async (req, res) => {
  try {
    const all = await listMemories({ limit: 300 });
    const isUserTag = (m) => (m.tags || []).some((t) => t.startsWith('user:'));
    const shareTeam = req.user ? (await getShareScope(req.user.id)) === 'team' : false;
    const items = req.user
      ? all.filter((m) => (m.tags || []).includes(`user:${req.user.id}`) || (shareTeam && !isUserTag(m)))
      : all.filter((m) => !isUserTag(m));
    // Keep only primary top_hook memories (metadata.hook set). Hindsight also
    // derives 'observation' facts from them with empty metadata — good memory,
    // but noisy as UI rows.
    const hooks = items.filter((m) => m.tags.includes('top_hook') && m.metadata?.hook);
    const posts = items.filter((m) => m.tags.includes('post'));
    const comments = items.filter((m) => m.tags.includes('comment'));
    res.json({
      mode: hindsightMode(),
      bank: bankId(),
      scope: req.user ? `user:${req.user.id}` : 'shared-demo',
      share_scope: req.user ? (shareTeam ? 'team' : 'personal') : 'shared-demo',
      total: items.length,
      top_hooks: hooks,
      posts: posts.slice(0, 20),
      comments: comments.slice(0, 20),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Serve the built React app when present (production / hosted demo).
// Registered after all API routes so /api/* always wins.
const distDir = path.resolve(__dirname, '../../frontend/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Engagement agent backend on http://localhost:${PORT}`);
  console.log(`Memory: bank=${bankId()} (set HINDSIGHT_BASE_URL to use Hindsight; file fallback otherwise)`);
  console.log(`LLM: ${llmProviderName()} | DB: ${dbEngine()} | Auth: JWT (secret: ${authSecretSource()})`);
  if (authSecretSource() !== 'explicit') {
    console.warn(
      '[auth] WARNING: AUTH_SECRET is not set — sessions are signed with a fallback secret. ' +
      'Set AUTH_SECRET in the host\'s environment settings before real use.'
    );
  }
});
