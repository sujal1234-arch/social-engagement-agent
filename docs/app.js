// Landing-page widget: talks to the live deployment of the agent.
// If the owner forks/redeploys elsewhere, change API_BASE below.
const API_BASE = 'https://social-engagement-agent.onrender.com';

const SAMPLE_AB = {
  hook: 'Cut your data sync from hours to seconds—see the results.',
  hook_b: 'We make data synchronization faster',
  caption: 'Case study: a leading enterprise cut ERP sync from 4 hours to under 2 minutes.',
  hashtags: ['#DataSync', '#APIEfficiency'],
  best_time: 'Tuesday 10:00',
  topic: 'sync',
  channel: 'linkedin',
};

let lastRec = null;
let lastAb = null;

const $ = (id) => document.getElementById(id);
const setBusy = (btn, busy, labelBusy, labelIdle) => {
  btn.disabled = busy;
  btn.textContent = busy ? labelBusy : labelIdle;
};

async function api(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function pingHealth() {
  const el = $('health');
  try {
    const data = await api('/api/health');
    const mode = data.memory_mode === 'hindsight' ? 'Hindsight Cloud' : (data.memory_mode || 'memory');
    el.innerHTML = `<span class="dot on"></span>API online · memory: ${mode} · llm: ${data.llm || 'groq'}`;
  } catch {
    el.innerHTML = '<span class="dot off"></span>API waking up (free tier sleeps) - try again in ~40s, or open the full app.';
  }
}

async function runRecommend() {
  const btn = $('btnRec');
  const out = $('recOut');
  setBusy(btn, true, 'Recalling from memory...', 'Generate recommendation');
  try {
    const q = new URLSearchParams({ channel: $('channel').value, topic: $('topic').value.trim() });
    const data = await api(`/api/recommend?${q}`);
    lastRec = data;
    const ex = (data.examples || []).slice(0, 3).map((e) => `• ${e.text} (${e.ctr}% CTR)`).join('\n');
    out.innerHTML = `
      <div class="box ok">${data.hook}</div>
      <div class="box">${data.caption}</div>
      <div class="prov">via ${data.source || 'memory + llm'}\nProvenance:\n${ex}</div>`;
    pingHealth();
  } catch (e) {
    out.innerHTML = `<div class="err">Failed: ${e.message}. The free tier may be waking - retry in a moment.</div>`;
  } finally {
    setBusy(btn, false, '', 'Generate recommendation');
  }
}

async function runAb() {
  const btn = $('btnAb');
  const out = $('abOut');
  setBusy(btn, true, 'Running A/B simulation...', 'Run A/B simulation');
  try {
    const body = {
      channel: (lastRec && lastRec.channel) || SAMPLE_AB.channel,
      topic: $('topic').value.trim() || SAMPLE_AB.topic,
      hook: (lastRec && lastRec.hook) || SAMPLE_AB.hook,
      hook_b: (lastRec && lastRec.hook_b) || SAMPLE_AB.hook_b,
      caption: (lastRec && lastRec.caption) || SAMPLE_AB.caption,
      hashtags: (lastRec && lastRec.hashtags) || SAMPLE_AB.hashtags,
      best_time: (lastRec && lastRec.best_time) || SAMPLE_AB.best_time,
    };
    const created = await api('/api/create-ab', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const abId = created.ab_id;
    await api('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ab_id: abId, variant: 'A', memory_informed: true }) });
    await api('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ab_id: abId, variant: 'B' }) });
    const res = await api(`/api/ab-results/${abId}`);
    lastAb = res;
    const win = res.results.winner;
    out.innerHTML = `
      <div class="box">A: ${res.variants.A.hook}\n   CTR ${res.results.A.ctr}%</div>
      <div class="box">B: ${res.variants.B.hook}\n   CTR ${res.results.B.ctr}%</div>
      <div class="ok">Winner: ${win} · ${res.results.uplift}× uplift${res.memory_writeback ? ' · written back to Hindsight ✓' : ''}</div>`;
    pingHealth();
  } catch (e) {
    out.innerHTML = `<div class="err">Failed: ${e.message}. Retry in a moment.</div>`;
  } finally {
    setBusy(btn, false, '', 'Run A/B simulation');
  }
}

async function runReply() {
  const btn = $('btnReply');
  const out = $('replyOut');
  const text = $('comment').value.trim();
  if (!text) { out.innerHTML = '<div class="err">Type a comment first.</div>'; return; }
  setBusy(btn, true, 'Recalling similar comments...', 'Suggest reply');
  try {
    const data = await api('/api/reply-suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: text }) });
    out.innerHTML = `
      <div class="box ok">${data.reply || data.suggested_reply || ''}</div>
      <div class="prov">tag: ${data.tag || '?'} · matched ${data.similar_count ?? 0} similar comments in memory</div>`;
    pingHealth();
  } catch (e) {
    out.innerHTML = `<div class="err">Failed: ${e.message}. Retry in a moment.</div>`;
  } finally {
    setBusy(btn, false, '', 'Suggest reply');
  }
}

$('btnRec').addEventListener('click', runRecommend);
$('btnAb').addEventListener('click', runAb);
$('btnReply').addEventListener('click', runReply);
pingHealth();
