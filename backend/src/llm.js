import './load-env.js';

const GROQ_KEY = process.env.GROQ_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export function llmProviderName() {
  if (GROQ_KEY) return `groq:${GROQ_MODEL}`;
  if (OPENAI_KEY) return `openai:${OPENAI_MODEL}`;
  return 'template-fallback';
}

async function chatCompletion(messages, { temperature = 0.7, maxTokens = 400 } = {}) {
  if (GROQ_KEY) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, messages, temperature, max_tokens: maxTokens }),
    });
    if (!r.ok) throw new Error(`Groq error ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const msg = data.choices?.[0]?.message || {};
    // Reasoning models (e.g. openai/gpt-oss-*) may put the answer in `reasoning`
    // and leave `content` empty — take whichever actually has text.
    const text = [msg.content, msg.reasoning]
      .map((t) => (typeof t === 'string' ? t.trim() : ''))
      .filter(Boolean)
      .sort((a, b) => (b.includes('{') ? 1 : 0) - (a.includes('{') ? 1 : 0))[0];
    if (!text) throw new Error('Groq returned empty content/reasoning');
    return text;
  }
  if (OPENAI_KEY) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature, max_tokens: maxTokens }),
    });
    if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content ?? '';
  }
  return null; // no provider configured -> caller uses fallback
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '```').split('```').join('\n');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function excerpt(text, max = 90) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toList(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * Ask the LLM for strict JSON with one retry on unparseable output.
 */
async function askJson(messages, opts = {}) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const content = await chatCompletion(messages, opts);
    const json = extractJson(content);
    if (json) return json;
    console.warn(`[llm] attempt ${attempt}: unparseable output (${content.length} chars): ${content.slice(0, 120)}`);
  }
  return null;
}

/**
 * Memory-informed recommendation.
 * examples: [{ post_id, text, ctr, platform }] — top recalled Hindsight facts, ranked by CTR.
 * Returns { hook, hook_b, caption, hashtags, best_time, why, source }.
 */
export async function generateRecommendation({ channel = 'linkedin', topic = '', examples = [] }) {
  const exLines = examples
    .map((e) => `- (post_id ${e.post_id}, ${e.ctr}% CTR) "${excerpt(e.text, 140)}"`)
    .join('\n');

  const messages = [
    {
      role: 'system',
      content:
        'You are a concise B2B social media assistant. Reply with ONLY valid JSON, no prose, no markdown: ' +
        '{"hook":"one-line hook (memory-informed)","hook_b":"one-line generic/technical variant for A/B control","caption":"two-sentence caption",'+
        '"hashtags":["three hashtags starting with #"],"best_time":"Weekday + hour, e.g. Tuesday 10:00","why":"one short sentence citing the matched post CTR"} ' +
        'Match the tone and style of the requested channel (LinkedIn professional, X short and punchy, Instagram visual and benefit-led, Facebook community-focused, YouTube video-first with a hook for watching, Pinterest idea/pin style, Reddit authentic and non-salesy, Telegram concise announcement, WhatsApp short and personal).',
    },
    {
      role: 'user',
      content:
        `Top performing past posts from memory (retrieved via Hindsight recall, channel=${channel}${topic ? `, topic=${topic}` : ''}):\n` +
        `${exLines || '- (no examples yet: write a solid B2B hook about measurable product outcomes)'}\n\n` +
        'Suggest: 1) one-line hook, 2) a generic/technical control hook_b, 3) two-sentence caption, 4) three hashtags, 5) best posting time (weekday + hour). ' +
        'Finish with one short sentence: why this matches past winners.',
    },
  ];

  try {
    const json = await askJson(messages, { temperature: 0.8 });
    if (json && json.hook) {
      return {
        hook: String(json.hook),
        hook_b: String(json.hook_b || ''),
        caption: String(json.caption || ''),
        hashtags: toList(json.hashtags).slice(0, 3),
        best_time: String(json.best_time || 'Tuesday 10:00'),
        why: String(json.why || ''),
        source: `hindsight recall + ${llmProviderName()}`,
      };
    }
  } catch (err) {
    console.error('[llm] recommend generation failed, using template fallback:', err.message);
  }
  return templateRecommendation({ channel, examples });
}

function firstClause(text) {
  const t = String(text || '').trim();
  const cut = t.split(/[—:.!?]/)[0].trim();
  return cut.length > 8 ? cut : t;
}

export function templateRecommendation({ channel = 'linkedin', examples = [] }) {
  const top = examples[0];
  const hashtagSets = {
    x: ['#buildinpublic', '#APIs', '#SaaS'],
    instagram: ['#BuildInPublic', '#DevTools', '#TechTips'],
    facebook: ['#DevTools', '#BuildInPublic', '#Developers'],
    youtube: ['#DevTools', '#TechReview', '#HowTo'],
    pinterest: ['#TechTips', '#Productivity', '#DevTools'],
    reddit: ['#DevTools', '#APIs', '#BuildInPublic'],
    telegram: ['#DevTools', '#TechNews', '#Launch'],
    whatsapp: ['#DevTools', '#TechTips', '#Launch'],
  };
  const hashtags = hashtagSets[channel] || ['#B2BMarketing', '#CaseStudy', '#DevTools'];
  if (!top) {
    return {
      hook: 'We cut integration time by 60% — here is the exact playbook',
      hook_b: 'New API release: faster integrations and updated docs',
      caption: 'Teams using our API ship integrations in days, not weeks. Comment "playbook" and we will send the step-by-step checklist.',
      hashtags,
      best_time: 'Tuesday 10:00',
      why: 'No memory yet — this is the default playbook; import seed data to make it memory-driven.',
      source: `hindsight recall (empty) + template-fallback`,
    };
  }
  const hook = `${excerpt(top.text, 80)} — the exact playbook, step by step`;
  return {
    hook,
    hook_b: 'New API release notes: improved connectors and docs',
    caption: `${excerpt(top.text, 160)} We packaged the whole process into a short guide — comment "playbook" and we will send it over.`,
    hashtags,
    best_time: 'Tuesday 10:00',
    why: `Suggested because: matched post #${top.post_id} — ${top.ctr}% CTR ("${excerpt(top.text, 60)}")`,
    source: 'hindsight recall + template-fallback',
  };
}

/**
 * Comment reply suggestion.
 * similar: [{ text, user, post_id }] — recalled similar comments from Hindsight.
 * Returns { reply, tag, source }.
 */
export async function generateReply({ commentText, similar = [] }) {
  const tag = classifyComment(commentText);
  const simLines = similar.map((s) => `- "${excerpt(s.text, 100)}" (by ${s.user})`).join('\n');
  const messages = [
    {
      role: 'system',
      content:
        'You are a helpful, consultative brand voice. Reply with ONLY valid JSON: {"reply":"short reply (max 2 sentences)","tag":"short issue tag like pricing|auth-security|demo-request|bug|praise|feature-request"}',
    },
    {
      role: 'user',
      content:
        `A comment asks: "${commentText}".\nSimilar past comments from memory (Hindsight recall):\n${simLines || '- none'}\n\n` +
        'Provide a short reply (<=2 sentences) linking to pricing and offering a 15-minute call, plus a short tag for the recurring issue.',
    },
  ];
  try {
    const json = await askJson(messages, { temperature: 0.5, maxTokens: 200 });
    if (json && json.reply) {
      return { reply: String(json.reply), tag: String(json.tag || tag), source: `hindsight recall + ${llmProviderName()}` };
    }
  } catch (err) {
    console.error('[llm] reply generation failed, using template fallback:', err.message);
  }
  return { reply: templateReply(commentText, tag), tag, source: 'hindsight recall + template-fallback' };
}

export function classifyComment(text) {
  const t = String(text || '').toLowerCase();
  if (/(price|pricing|cost|plan|tier|trial)/.test(t)) return 'pricing';
  if (/(oauth|sso|saml|auth|security|token|pkce)/.test(t)) return 'auth-security';
  if (/(demo|walkthrough|see it|show|video)/.test(t)) return 'demo-request';
  if (/(broken|error|bug|flaky|fails|issue|not working)/.test(t)) return 'bug';
  if (/(love|great|nice|thanks|impressive|respect|helped|win)/.test(t)) return 'praise';
  if (/(support|integrat|handle|apply|work with|cover)/.test(t)) return 'feature-request';
  return 'general';
}

export function templateReply(commentText, tag) {
  switch (tag) {
    case 'pricing':
      return 'Full pricing is on our pricing page — plans scale with team size. Happy to walk you through the right tier on a quick 15-minute call: https://example.com/pricing';
    case 'auth-security':
      return 'Yes — OAuth 2.0, SSO/SAML and scoped tokens are supported out of the box. Want a 15-minute call to see the setup for your stack?';
    case 'demo-request':
      return 'Great to hear — a 90-second demo gives you the overview, and we can tailor a 15-minute walkthrough to your use case. When works for you?';
    case 'bug':
      return 'Sorry about that — we want this fixed fast. Could you DM the error details, or grab a 15-minute call with one of our engineers?';
    case 'praise':
      return 'Thank you! If you want the deeper details behind these numbers, our pricing page has the plans — and we are glad to hop on a 15-minute call anytime.';
    case 'feature-request':
      return 'Great question — it depends on your setup, and we support most major systems out of the box. A 15-minute call with our team would nail the specifics quickly.';
    default:
      return `Thanks for engaging with this! If it is useful, we can show how teams run this in production — happy to set up a quick 15-minute call. Pricing and plans: https://example.com/pricing`;
  }
}
