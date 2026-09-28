import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '../../data');
const PATH = path.join(DATA_DIR, 'memory-fallback.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(PATH, 'utf8'));
  } catch {
    return { items: [] };
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(PATH), { recursive: true });
  fs.writeFileSync(PATH, JSON.stringify(db, null, 2));
}

/** Naive keyword scoring recall over the local memory store (fallback mode only). */
export function searchLocalMemory(query, { tags = [], limit = 8 } = {}) {
  const q = String(query || '').toLowerCase().split(/\W+/).filter(Boolean);
  const items = load().items.filter((m) => {
    if (!tags.length) return true;
    return m.tags.some((t) => tags.includes(t) || tags.some((tag) => t.startsWith(`${tag}:`)));
  });
  const scored = items
    .map((m) => {
      const text = `${m.text} ${m.metadata?.post_id ? `post ${m.metadata.post_id}` : ''}`.toLowerCase();
      let score = 0;
      for (const w of q) if (text.includes(w)) score += 1;
      // CTR boost so high performers surface like Hindsight's reranker would.
      const ctr = Number(m.metadata?.ctr_percent || 0);
      score += Math.min(ctr / 2, 3);
      if (m.tags?.some((t) => t === 'top_hook')) score += 1.5;
      return { ...m, _score: score };
    })
    .sort((a, b) => b._score - a._score);
  return scored.slice(0, limit).map(({ _score, ...m }) => m);
}

export function readLocalMemory() {
  return load().items;
}

/** Append items with a normalized shape; deduplicates by id when provided. */
export function writeLocalMemory(items) {
  const db = load();
  for (const it of items) {
    const memory = {
      id: it.document_id || `mem_${Math.random().toString(36).slice(2, 10)}`,
      text: it.content,
      tags: it.tags || [],
      metadata: it.metadata || {},
      context: it.context || '',
      occurredStart: it.timestamp || new Date().toISOString(),
      type: it.metadata?.kind === 'top_hook' ? 'world' : 'experience',
    };
    const idx = it.document_id ? db.items.findIndex((m) => m.id === it.document_id) : -1;
    if (idx >= 0) db.items[idx] = memory;
    else db.items.push(memory);
  }
  save(db);
  return db.items.length;
}
