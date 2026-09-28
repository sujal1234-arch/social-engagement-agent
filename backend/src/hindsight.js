import { HindsightClient } from '@vectorize-io/hindsight-client';

/**
 * Hindsight adapter — the hackathon-required memory layer.
 *
 * Preferred: official @vectorize-io/hindsight-client SDK, speaking to either
 *   - Hindsight Cloud  (HINDSIGHT_BASE_URL=https://api.hindsight.vectorize.io + HINDSIGHT_API_KEY)
 *   - local OSS server (HINDSIGHT_BASE_URL=http://localhost:8888)
 * Fallback: a JSON-file memory store with the same retain/recall/list contract
 * so the demo always runs, even with no Hindsight instance reachable.
 *
 * Env vars are read lazily (at call time) so dotenv import ordering can never
 * leave this module with empty credentials.
 */

let client = null;
let mode = 'unknown';

function config() {
  return {
    baseUrl: process.env.HINDSIGHT_BASE_URL || '',
    apiKey: process.env.HINDSIGHT_API_KEY || '',
    bankId: process.env.HINDSIGHT_BANK_ID || 'social-engagement-agent',
  };
}

function getClient(baseUrl, apiKey) {
  if (!client) {
    client = new HindsightClient({ baseUrl, apiKey: apiKey || undefined });
  }
  return client;
}

export function hindsightMode() {
  return mode;
}

export function bankId() {
  return config().bankId;
}

async function fallbackList(tagPrefix) {
  const { readLocalMemory } = await import('./local-memory.js');
  const items = readLocalMemory();
  return items.filter((m) => !tagPrefix || m.tags.some((t) => t === tagPrefix || t.startsWith(`${tagPrefix}:`)));
}

async function fallbackRetain(items) {
  const { writeLocalMemory } = await import('./local-memory.js');
  writeLocalMemory(items);
  return { retained: items.length, mode: 'fallback' };
}

async function fallbackRecall(query, { tags = [], limit = 8 } = {}) {
  const { searchLocalMemory } = await import('./local-memory.js');
  return searchLocalMemory(query, { tags, limit });
}

/** Store memory items into Hindsight (or the file fallback). */
export async function retain(items) {
  const { baseUrl, apiKey, bankId } = config();
  if (!baseUrl) {
    mode = 'fallback';
    return fallbackRetain(items);
  }
  try {
    const c = getClient(baseUrl, apiKey);
    await c.retainBatch(
      bankId,
      items.map((it) => ({
        content: it.content,
        context: it.context,
        timestamp: it.timestamp || undefined,
        metadata: it.metadata,
        tags: it.tags,
        document_id: it.document_id || undefined,
      })),
      { async: false }
    );
    mode = 'hindsight';
    return { retained: items.length, mode: 'hindsight' };
  } catch (err) {
    console.error('[hindsight] retain failed, using file fallback:', err.message);
    mode = 'fallback';
    return fallbackRetain(items);
  }
}

/**
 * Recall memories. Returns normalized facts:
 * [{ text, tags, metadata, occurredStart, type }]
 */
export async function recall(query, { tags = [], limit = 8 } = {}) {
  const { baseUrl, apiKey, bankId } = config();
  if (!baseUrl) {
    mode = 'fallback';
    return fallbackRecall(query, { tags, limit });
  }
  try {
    const c = getClient(baseUrl, apiKey);
    const response = await c.recall(bankId, query, {
      types: ['world', 'experience'],
      maxTokens: 1200,
      budget: 'mid',
      ...(tags.length ? { tags } : {}),
    });
    mode = 'hindsight';
    const facts = (response.results || []).map((r) => ({
      text: r.text,
      tags: r.tags || [],
      metadata: r.metadata || {},
      occurredStart: r.occurredStart || r.occurred_start || null,
      type: r.type,
    }));
    return facts.slice(0, limit);
  } catch (err) {
    console.error('[hindsight] recall failed, using file fallback:', err.message);
    mode = 'fallback';
    return fallbackRecall(query, { tags, limit });
  }
}

/** List memories (used by the /api/memory panel; falls back to the file store). */
export async function listMemories({ tagPrefix = '', limit = 20 } = {}) {
  const { baseUrl, apiKey, bankId } = config();
  if (!baseUrl) {
    mode = 'fallback';
    return fallbackList(tagPrefix);
  }
  try {
    const c = getClient(baseUrl, apiKey);
    const response = await c.listMemories(bankId, { limit });
    mode = 'hindsight';
    const items = (response.items || response.results || []).map((r) => ({
      id: r.id,
      text: r.text,
      tags: r.tags || [],
      metadata: r.metadata || {},
      occurredStart: r.occurredStart || r.date || null,
      type: r.fact_type || r.type || 'world',
    }));
    return items.filter((m) => !tagPrefix || m.tags.some((t) => t === tagPrefix || t.startsWith(`${tagPrefix}:`)));
  } catch (err) {
    console.error('[hindsight] listMemories failed, using file fallback:', err.message);
    mode = 'fallback';
    return fallbackList(tagPrefix);
  }
}

/** Best-effort bank creation so a fresh cloud instance works on first run. */
export async function ensureBank() {
  const { baseUrl, apiKey, bankId } = config();
  if (!baseUrl) return { mode: 'fallback', bank: bankId };
  try {
    const c = getClient(baseUrl, apiKey);
    await c.createBank(bankId, {
      name: 'Social Media Engagement Agent',
      mission:
        'Remember which social posts, hooks and reply styles perform best. Store post metrics as facts so recall surfaces high-CTR winners, and write A/B winning hooks back as top_hook memories.',
    });
    return { mode: 'hindsight', bank: bankId };
  } catch (err) {
    // Bank likely already exists (409) or creation is unsupported — not fatal.
    console.log(`[hindsight] ensureBank: ${err.message}`);
    return { mode: 'hindsight', bank: bankId };
  }
}
