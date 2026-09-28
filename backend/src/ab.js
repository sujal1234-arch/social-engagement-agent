import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'ab-tests.json');

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { tests: {} };
  }
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/** Deterministic PRNG so demo results are stable across refreshes. */
function seededRandom(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
}

export function createAb({ channel = 'linkedin', topic = '', variantA, variantB }) {
  const db = loadDb();
  const id = `ab_${Date.now().toString(36)}${Math.floor(Math.random() * 1e3).toString(36)}`;
  const test = {
    id,
    created_at: new Date().toISOString(),
    channel,
    topic,
    status: 'scheduled',
    variants: {
      A: { ...variantA, memory_informed: true },
      B: { ...variantB, memory_informed: false },
    },
    posts: [],
    results: null,
    writeback: null,
  };
  db.tests[id] = test;
  saveDb(db);
  return test;
}

export function addScheduledPost(id, post) {
  const db = loadDb();
  const test = db.tests[id];
  if (!test) return null;
  test.posts.push(post);
  const variants = new Set(test.posts.filter((p) => p.scheduled).map((p) => p.variant));
  if (variants.size >= 2) test.status = 'scheduled-complete';
  saveDb(db);
  return test;
}

export function getAb(id) {
  return loadDb().tests[id] || null;
}

export function listAbs() {
  const db = loadDb();
  return Object.values(db.tests).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function saveAb(test) {
  const db = loadDb();
  db.tests[test.id] = test;
  saveDb(db);
}

/**
 * Simulate 48h of metrics. The memory-informed variant (A) hits ~5-6% CTR
 * (matching the top stored posts in Hindsight) vs ~1.5-2% for control (B) -> ~3x uplift.
 */
export function simulateResults(test) {
  if (test.results) return test.results;
  const mk = (variant, base, spread) => {
    const rand = seededRandom(`${test.id}:${variant}`);
    const impressions = 1600 + Math.floor(rand() * 800);
    const ctr = base + rand() * spread;
    const clicks = Math.round(impressions * ctr);
    return {
      impressions,
      clicks,
      ctr: Number(((clicks / impressions) * 100).toFixed(2)),
      likes: Math.round(clicks * 2.1),
      comments: Math.round(clicks * 0.45),
      shares: Math.round(clicks * 0.2),
    };
  };
  const A = mk('A', 0.052, 0.012); // memory-informed: 5.2-6.4% CTR
  const B = mk('B', 0.015, 0.006); // control: 1.5-2.1% CTR
  test.results = {
    A,
    B,
    winner: A.ctr >= B.ctr ? 'A' : 'B',
    uplift: Number((A.ctr / Math.max(B.ctr, 0.01)).toFixed(2)),
  };
  test.status = 'complete';
  return test.results;
}
