import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
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
  });
});

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
app.get('/api/recommend', async (req, res) => {
  try {
    const channel = String(req.query.channel || 'linkedin');
    const topic = String(req.query.topic || '');
    // 1. Recall high-CTR winners from Hindsight memory.
    let facts = [];
    try {
      facts = await recall(
        `highest CTR posts about integrations, demos, before/after results${topic ? `, topic ${topic}` : ''}`,
        { tags: ['top_performer'], limit: 8 }
      );
      if (facts.length < 3) {
        const more = await recall('posts with best click-through rate and engagement', { limit: 10 });
        const seen = new Set(facts.map((f) => f.metadata?.post_id));
        facts = facts.concat(more.filter((f) => !seen.has(f.metadata?.post_id)));
      }
    } catch (err) {
      console.error('[recommend] recall failed:', err.message);
    }
    // 2. Map facts back to numeric CTR and pick the top examples.
    const examples = facts
      .map((f) => ({
        post_id: f.metadata?.post_id || '?',
        text: f.metadata?.text || f.text,
        ctr: Number(f.metadata?.ctr_percent || 0),
        platform: f.metadata?.platform || channel,
      }))
      .filter((e) => e.text)
      .sort((a, b) => b.ctr - a.ctr)
      .slice(0, 3);
    // 3. LLM generates hook/caption/hashtags/best_time + provenance line.
    const rec = await generateRecommendation({ channel, topic, examples });
    res.json({ ...rec, channel, examples, memory_mode: hindsightMode() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// POST /api/create-ab { channel, topic, hook, hook_b, caption, hashtags, best_time }
app.post('/api/create-ab', (req, res) => {
  const { channel = 'linkedin', topic = '', hook = '', hook_b = '', caption = '', hashtags = [], best_time = '' } = req.body || {};
  if (!hook || !hook_b) return res.status(400).json({ error: 'hook and hook_b are required' });
  const test = createAb({
    channel,
    topic,
    variantA: { hook, caption, hashtags, best_time },
    variantB: { hook: hook_b, caption, hashtags, best_time },
  });
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

// GET /api/ab-results/:id — simulate metrics, pick winner, write winner back to Hindsight
app.get('/api/ab-results/:id', async (req, res) => {
  try {
    const test = getAb(req.params.id);
    if (!test) return res.status(404).json({ error: `unknown ab_id ${req.params.id}` });
    const results = simulateResults(test);
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
      await retain([writeback]);
      test.writeback = writeback;
      saveAb(test);
    }
    res.json({
      ab_id: test.id,
      status: test.status,
      channel: test.channel,
      variants: { A: test.variants.A, B: test.variants.B },
      results,
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
app.post('/api/reply-suggest', async (req, res) => {
  try {
    const comment = String(req.body?.comment || '').trim();
    if (!comment) return res.status(400).json({ error: 'comment text is required' });
    let similar = [];
    try {
      similar = await recall(`comments similar to: ${comment}`, { limit: 5 });
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
app.get('/api/memory', async (_req, res) => {
  try {
    const items = await listMemories({ limit: 100 });
    // Keep only primary top_hook memories (metadata.hook set). Hindsight also
    // derives 'observation' facts from them with empty metadata — good memory,
    // but noisy as UI rows.
    const hooks = items.filter((m) => m.tags.includes('top_hook') && m.metadata?.hook);
    const posts = items.filter((m) => m.tags.includes('post'));
    const comments = items.filter((m) => m.tags.includes('comment'));
    res.json({
      mode: hindsightMode(),
      bank: bankId(),
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
  console.log(`LLM: ${llmProviderName()}`);
});
