import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * User + connected-accounts store.
 *
 * Prefers SQLite via node:sqlite (Node 22+). If unavailable, falls back to a
 * JSON file with the same async contract, so the demo always runs.
 *
 * Access tokens from connected platforms are stored AES-256-GCM encrypted
 * (AUTH_SECRET-derived key) — never plaintext at rest.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');

let db = null;
let usingSqlite = false;

async function tryOpenSqlite() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(DATA_DIR, 'agent.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const d = new DatabaseSync(file);
    d.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        platform_user_id TEXT,
        platform_username TEXT,
        scopes TEXT,
        access_token_enc TEXT,
        connected_at TEXT NOT NULL,
        UNIQUE(user_id, platform)
      );
    `);
    return d;
  } catch {
    return null;
  }
}

function jsonFile() {
  return path.join(DATA_DIR, 'users-fallback.json');
}

function loadJson() {
  try {
    return JSON.parse(fs.readFileSync(jsonFile(), 'utf8'));
  } catch {
    return { users: [], connections: [] };
  }
}

function saveJson(data) {
  fs.mkdirSync(path.dirname(jsonFile()), { recursive: true });
  fs.writeFileSync(jsonFile(), JSON.stringify(data, null, 2));
}

export async function initDb() {
  db = await tryOpenSqlite();
  usingSqlite = !!db;
  if (!db) {
    db = loadJson();
  }
  return { engine: usingSqlite ? 'sqlite' : 'json' };
}

export function dbEngine() {
  return usingSqlite ? 'sqlite' : 'json';
}

/* ---------------- users ---------------- */

export async function findUserByEmail(email) {
  const e = String(email || '').toLowerCase();
  if (usingSqlite) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(e) || null;
  }
  return db.users.find((u) => u.email === e) || null;
}

export async function createUser({ email, name, passwordHash }) {
  const id = `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const created = new Date().toISOString();
  if (usingSqlite) {
    db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id, String(email).toLowerCase(), name || '', passwordHash, created
    );
    return { id, email: String(email).toLowerCase(), name: name || '', created_at: created };
  }
  const user = { id, email: String(email).toLowerCase(), name: name || '', password_hash: passwordHash, created_at: created };
  db.users.push(user);
  saveJson(db);
  return user;
}

export async function getUser(id) {
  if (usingSqlite) return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  return db.users.find((u) => u.id === id) || null;
}

/* ------------- connections ------------- */

export async function listConnections(userId) {
  if (usingSqlite) {
    return db.prepare('SELECT id, user_id, platform, platform_user_id, platform_username, scopes, connected_at FROM connections WHERE user_id = ?').all(userId);
  }
  return db.connections
    .filter((c) => c.user_id === userId)
    .map(({ access_token_enc, ...rest }) => rest);
}

export async function getConnection(userId, platform) {
  if (usingSqlite) {
    return db.prepare('SELECT * FROM connections WHERE user_id = ? AND platform = ?').get(userId, platform) || null;
  }
  return db.connections.find((c) => c.user_id === userId && c.platform === platform) || null;
}

export async function upsertConnection({ userId, platform, platformUserId, platformUsername, scopes, accessTokenEnc }) {
  const existing = await getConnection(userId, platform);
  const now = new Date().toISOString();
  if (usingSqlite) {
    if (existing) {
      db.prepare('UPDATE connections SET platform_user_id=?, platform_username=?, scopes=?, access_token_enc=?, connected_at=? WHERE user_id=? AND platform=?')
        .run(platformUserId || '', platformUsername || '', scopes || '', accessTokenEnc, now, userId, platform);
    } else {
      db.prepare('INSERT INTO connections (id, user_id, platform, platform_user_id, platform_username, scopes, access_token_enc, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, userId, platform, platformUserId || '', platformUsername || '', scopes || '', accessTokenEnc, now);
    }
  } else {
    const rec = { id: existing?.id || `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, user_id: userId, platform, platform_user_id: platformUserId || '', platform_username: platformUsername || '', scopes: scopes || '', access_token_enc: accessTokenEnc, connected_at: now };
    if (existing) Object.assign(existing, rec);
    else db.connections.push(rec);
    saveJson(db);
  }
  return { ok: true };
}

export async function deleteConnection(userId, platform) {
  if (usingSqlite) {
    db.prepare('DELETE FROM connections WHERE user_id = ? AND platform = ?').run(userId, platform);
  } else {
    db.connections = db.connections.filter((c) => !(c.user_id === userId && c.platform === platform));
    saveJson(db);
  }
  return { ok: true };
}

export async function getConnectionToken(userId, platform) {
  const c = await getConnection(userId, platform);
  return c?.access_token_enc || null;
}
