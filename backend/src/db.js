import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Persistence for users, connected accounts and one-time tokens.
 *
 * Engine order:
 *   1. Postgres  — when DATABASE_URL is set (Render/Neon/Supabase). This is what
 *      makes accounts survive redeploys on hosts with an ephemeral disk.
 *   2. SQLite    — node:sqlite, local development default.
 *   3. JSON file — last-resort fallback so the demo always runs.
 *
 * Platform access tokens are stored AES-256-GCM encrypted by auth.js; only
 * hashes of refresh/reset tokens are stored here.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');

let engine = 'json'; // 'postgres' | 'sqlite' | 'json'
let pg = null;       // { pool }
let sq = null;       // sqlite DatabaseSync
let json = null;     // { users, connections, tokens }

export function dbEngine() {
  return engine;
}

async function createTablesPg(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      platform_user_id TEXT,
      platform_username TEXT,
      scopes TEXT,
      access_token_enc TEXT,
      connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(user_id, platform)
    );
    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
  `);
}

async function tryInitPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    const { default: pgLib } = await import('pg');
    const pool = new pgLib.Pool({
      connectionString: url,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await createTablesPg(pool);
    return { pool };
  } catch (err) {
    console.error(`[db] Postgres unavailable (${err.message}) — falling back`);
    return null;
  }
}

async function tryInitSqlite() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(DATA_DIR, 'agent.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    d.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT,
        password_hash TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, platform TEXT NOT NULL,
        platform_user_id TEXT, platform_username TEXT, scopes TEXT,
        access_token_enc TEXT, connected_at TEXT NOT NULL,
        UNIQUE(user_id, platform)
      );
      CREATE TABLE IF NOT EXISTS tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
        expires_at TEXT NOT NULL, used_at TEXT
      );
    `);
    return d;
  } catch {
    return null;
  }
}

function loadJson() {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath(), 'utf8'));
    data.tokens ||= [];
    return data;
  } catch {
    return { users: [], connections: [], tokens: [] };
  }
}

function jsonPath() {
  return path.join(DATA_DIR, 'users-fallback.json');
}

function saveJson() {
  fs.mkdirSync(path.dirname(jsonPath()), { recursive: true });
  fs.writeFileSync(jsonPath(), JSON.stringify(json, null, 2));
}

export async function initDb() {
  pg = await tryInitPostgres();
  if (pg) {
    engine = 'postgres';
    return { engine };
  }
  sq = await tryInitSqlite();
  if (sq) {
    engine = 'sqlite';
    return { engine };
  }
  json = loadJson();
  engine = 'json';
  return { engine };
}

const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ---------------- users ---------------- */

export async function findUserByEmail(email) {
  const e = String(email || '').toLowerCase();
  if (engine === 'postgres') return (await pg.pool.query('SELECT * FROM users WHERE email = $1', [e])).rows[0] || null;
  if (engine === 'sqlite') return sq.prepare('SELECT * FROM users WHERE email = ?').get(e) || null;
  return json.users.find((u) => u.email === e) || null;
}

export async function createUser({ email, name, passwordHash }) {
  const id = newId('u');
  const e = String(email).toLowerCase();
  const created = new Date().toISOString();
  if (engine === 'postgres') {
    await pg.pool.query(
      'INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, e, name || '', passwordHash, created]
    );
  } else if (engine === 'sqlite') {
    sq.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, e, name || '', passwordHash, created);
  } else {
    json.users.push({ id, email: e, name: name || '', password_hash: passwordHash, created_at: created });
    saveJson();
  }
  return { id, email: e, name: name || '', created_at: created };
}

export async function getUser(id) {
  if (engine === 'postgres') return (await pg.pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0] || null;
  if (engine === 'sqlite') return sq.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  return json.users.find((u) => u.id === id) || null;
}

export async function setUserPassword(userId, passwordHash) {
  if (engine === 'postgres') {
    await pg.pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
  } else if (engine === 'sqlite') {
    sq.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  } else {
    const u = json.users.find((x) => x.id === userId);
    if (u) {
      u.password_hash = passwordHash;
      saveJson();
    }
  }
  return { ok: true };
}

/* ------------- connections ------------- */

export async function listConnections(userId) {
  const cols = 'user_id, platform, platform_user_id, platform_username, scopes, connected_at';
  if (engine === 'postgres') {
    return (await pg.pool.query(`SELECT ${cols} FROM connections WHERE user_id = $1`, [userId])).rows;
  }
  if (engine === 'sqlite') {
    return sq.prepare(`SELECT ${cols} FROM connections WHERE user_id = ?`).all(userId);
  }
  return json.connections.filter((c) => c.user_id === userId);
}

export async function getConnection(userId, platform) {
  if (engine === 'postgres') {
    return (await pg.pool.query('SELECT * FROM connections WHERE user_id = $1 AND platform = $2', [userId, platform])).rows[0] || null;
  }
  if (engine === 'sqlite') {
    return sq.prepare('SELECT * FROM connections WHERE user_id = ? AND platform = ?').get(userId, platform) || null;
  }
  return json.connections.find((c) => c.user_id === userId && c.platform === platform) || null;
}

export async function upsertConnection({ userId, platform, platformUserId, platformUsername, scopes, accessTokenEnc }) {
  const now = new Date().toISOString();
  const vals = [platformUserId || '', platformUsername || '', scopes || '', accessTokenEnc, now];
  if (engine === 'postgres') {
    await pg.pool.query(
      `INSERT INTO connections (id, user_id, platform, platform_user_id, platform_username, scopes, access_token_enc, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, platform) DO UPDATE SET
         platform_user_id = EXCLUDED.platform_user_id,
         platform_username = EXCLUDED.platform_username,
         scopes = EXCLUDED.scopes,
         access_token_enc = EXCLUDED.access_token_enc,
         connected_at = EXCLUDED.connected_at`,
      [newId('c'), userId, platform, ...vals]
    );
  } else if (engine === 'sqlite') {
    sq.prepare(
      `INSERT INTO connections (id, user_id, platform, platform_user_id, platform_username, scopes, access_token_enc, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, platform) DO UPDATE SET
         platform_user_id = excluded.platform_user_id,
         platform_username = excluded.platform_username,
         scopes = excluded.scopes,
         access_token_enc = excluded.access_token_enc,
         connected_at = excluded.connected_at`
    ).run(newId('c'), userId, platform, ...vals);
  } else {
    const existing = json.connections.find((c) => c.user_id === userId && c.platform === platform);
    const rec = {
      id: existing?.id || newId('c'),
      user_id: userId,
      platform,
      platform_user_id: vals[0],
      platform_username: vals[1],
      scopes: vals[2],
      access_token_enc: vals[3],
      connected_at: vals[4],
    };
    if (existing) Object.assign(existing, rec);
    else json.connections.push(rec);
    saveJson();
  }
  return { ok: true };
}

export async function deleteConnection(userId, platform) {
  if (engine === 'postgres') await pg.pool.query('DELETE FROM connections WHERE user_id = $1 AND platform = $2', [userId, platform]);
  else if (engine === 'sqlite') sq.prepare('DELETE FROM connections WHERE user_id = ? AND platform = ?').run(userId, platform);
  else {
    json.connections = json.connections.filter((c) => !(c.user_id === userId && c.platform === platform));
    saveJson();
  }
  return { ok: true };
}

export async function getConnectionToken(userId, platform) {
  const c = await getConnection(userId, platform);
  return c?.access_token_enc || null;
}

/* ------------- one-time tokens (refresh / password reset) ------------- */

export async function saveToken({ tokenHash, userId, kind, expiresAt }) {
  if (engine === 'postgres') {
    await pg.pool.query('INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES ($1, $2, $3, $4)', [tokenHash, userId, kind, expiresAt]);
  } else if (engine === 'sqlite') {
    sq.prepare('INSERT INTO tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, kind, expiresAt);
  } else {
    json.tokens.push({ token_hash: tokenHash, user_id: userId, kind, expires_at: expiresAt, used_at: null });
    saveJson();
  }
  return { ok: true };
}

export async function consumeToken({ tokenHash, kind }) {
  const now = new Date().toISOString();
  if (engine === 'postgres') {
    const r = await pg.pool.query(
      `UPDATE tokens SET used_at = $3
       WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > $3
       RETURNING user_id`,
      [tokenHash, kind, now]
    );
    return r.rows[0]?.user_id || null;
  }
  if (engine === 'sqlite') {
    const row = sq.prepare('SELECT * FROM tokens WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?')
      .get(tokenHash, kind, now);
    if (!row) return null;
    sq.prepare('UPDATE tokens SET used_at = ? WHERE token_hash = ?').run(now, tokenHash);
    return row.user_id;
  }
  const row = json.tokens.find((t) => t.token_hash === tokenHash && t.kind === kind && !t.used_at && t.expires_at > now);
  if (!row) return null;
  row.used_at = now;
  saveJson();
  return row.user_id;
}

export async function revokeTokensForUser(userId, kind) {
  const now = new Date().toISOString();
  if (engine === 'postgres') await pg.pool.query('UPDATE tokens SET used_at = $3 WHERE user_id = $1 AND kind = $2 AND used_at IS NULL', [userId, kind, now]);
  else if (engine === 'sqlite') sq.prepare('UPDATE tokens SET used_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL').run(now, userId, kind);
  else {
    for (const t of json.tokens) if (t.user_id === userId && t.kind === kind && !t.used_at) t.used_at = now;
    saveJson();
  }
  return { ok: true };
}
