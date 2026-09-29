import crypto from 'node:crypto';

/**
 * Zero-dependency auth utilities:
 *  - scrypt password hashing
 *  - JWT (HS256) sign/verify via node:crypto
 *  - AES-256-GCM encryption for stored platform access tokens
 *
 * Secrets are read lazily from env so dotenv ordering never matters.
 */

export function authSecret() {
  return process.env.AUTH_SECRET || process.env.HINDSIGHT_API_KEY || 'dev-only-insecure-secret-change-me';
}

/** Which secret is signing sessions — surfaced by /api/health (never the value). */
export function authSecretSource() {
  if (process.env.AUTH_SECRET) return 'explicit';
  if (process.env.HINDSIGHT_API_KEY) return 'derived-from-hindsight-key';
  return 'dev-fallback';
}

/* ---------------- password hashing ---------------- */

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    if (!salt || !hash) return false;
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/* ---------------- JWT (HS256) ---------------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function signJwt(payload, { expiresIn = '7d' } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof expiresIn === 'string' && expiresIn.endsWith('d')
    ? now + Number(expiresIn.slice(0, -1)) * 86400
    : now + 7 * 86400;
  const body = { ...payload, iat: now, exp };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', authSecret()).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

export function verifyJwt(token) {
  try {
    const [h, p, sig] = String(token || '').split('.');
    if (!h || !p || !sig) return null;
    const expected = crypto.createHmac('sha256', authSecret()).update(`${h}.${p}`).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/* ---------------- token encryption (AES-256-GCM) ---------------- */

function encKey() {
  return crypto.createHash('sha256').update(`enc:${authSecret()}`).digest();
}

export function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptToken(stored) {
  try {
    const [iv, enc, tag] = String(stored).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/* ---------------- express middleware ---------------- */

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyJwt(token);
  if (!payload?.sub) {
    return res.status(401).json({ error: 'Sign in required' });
  }
  req.user = { id: payload.sub, email: payload.email, name: payload.name };
  next();
}

export function authOptional(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyJwt(token);
  if (payload?.sub) req.user = { id: payload.sub, email: payload.email, name: payload.name };
  next();
}

/* ---------------- rate limiting (in-memory sliding window) ---------------- */

const buckets = new Map();

/**
 * Simple per-key rate limiter for auth endpoints.
 * keyFn decides the bucket (email, IP, or both).
 */
export function rateLimit({ windowMs = 15 * 60_000, max = 10, keyFn } = {}) {
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : `${req.ip}:${req.path}`) || 'anon';
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      const retry = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `Too many attempts. Try again in ${retry}s.` });
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

/* ---------------- refresh + password-reset tokens ---------------- */

/** Opaque random token; only its SHA-256 hash is persisted. */
export function newOpaqueToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(`tok:${raw}`).digest('hex');
}
