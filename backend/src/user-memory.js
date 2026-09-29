import { retain, recall } from './hindsight.js';

/**
 * Per-user memory scoping.
 *
 * All memories for a user carry tags `user:<userId>` and `platform:<platform>`,
 * so recall can filter to exactly one user's history. The bank stays shared
 * (one Hindsight bank), but scoping is enforced at the tag level — the same
 * pattern Hindsight recommends for multi-tenant banks.
 */

export function userTags(userId, platform) {
  const tags = [`user:${userId}`];
  if (platform) tags.push(`platform:${platform}`);
  return tags;
}

export function scopedRecall(userId, platform, query, opts = {}) {
  return recall(query, { ...opts, tags: userTags(userId, platform) });
}

/**
 * Sample content retained when a platform is connected in demo mode, so
 * recommendations immediately have per-user, per-platform provenance.
 * In production these rows come from the platform's insights API instead.
 */
export function samplePostsFor(platform, userId) {
  const catalog = {
    instagram: [
      { id: 'reel_12', kind: 'Reel', text: 'Before/after: our dashboard redesign cut onboarding from 9 minutes to 40 seconds', saves: 810, reach: 12400, rate: 8.0 },
      { id: 'reel_07', kind: 'Reel', text: '3 API mistakes that silently double your latency (fix #2 today)', saves: 640, reach: 9800, rate: 6.5 },
      { id: 'post_03', kind: 'Carousel', text: 'We open-sourced our integration test kit — here is what is inside', saves: 430, reach: 7600, rate: 5.1 },
    ],
    linkedin: [
      { id: 'post_11', kind: 'Post', text: 'Before/after: legacy ERP sync went from 4 hours to 90 seconds', impressions: 18400, clicks: 1288, ctr: 7.0 },
      { id: 'post_13', kind: 'Post', text: 'Free template: the API audit checklist our enterprise clients pay for', impressions: 15200, clicks: 1064, ctr: 7.0 },
      { id: 'post_01', kind: 'Post', text: 'Acme cut integration time by 60% using our API', impressions: 12800, clicks: 768, ctr: 6.0 },
    ],
    tiktok: [
      { id: 'clip_05', kind: 'Clip', text: 'POV: your CI pipeline finishes before your coffee brews', saves: 1200, reach: 31000, rate: 9.2 },
      { id: 'clip_02', kind: 'Clip', text: 'Watch me refactor a 400-line function into 12 lines live', saves: 900, reach: 22000, rate: 7.4 },
    ],
    youtube: [
      { id: 'vid_09', kind: 'Video', text: 'I rebuilt our sync engine in Rust — 40x faster, full benchmark', views: 42000, watch_pct: 58, rate: 7.8 },
      { id: 'vid_04', kind: 'Video', text: 'The API design mistake every team makes (and the 10-line fix)', views: 28000, watch_pct: 52, rate: 6.3 },
    ],
  };
  const rows = catalog[platform] || [
    { id: `${platform}_01`, kind: 'Post', text: 'Before/after: we cut sync time from hours to seconds', impressions: 9800, clicks: 560, ctr: 5.7 },
    { id: `${platform}_02`, kind: 'Post', text: 'Checklist: the 7 integration tests every team should run', impressions: 7400, clicks: 380, ctr: 5.1 },
  ];
  return rows.map((r) => ({
    content: `${p(platform)} ${r.kind} (${r.id}): "${r.text}". Performance: ${describe(r)} — one of this account's top performers.`,
    context: `${platform} content performance`,
    timestamp: new Date(Date.now() - Math.floor(Math.random() * 40) * 86400000).toISOString(),
    document_id: `userpost_${userId}_${r.id}`,
    tags: ['post', 'user_content', `platform:${platform}`, `user:${userId}`, r.rate >= 6 ? 'top_performer' : 'solid'],
    metadata: {
      kind: 'post',
      post_id: r.id,
      content_kind: r.kind,
      platform,
      user_id: userId,
      metric_name: r.ctr != null ? 'ctr_percent' : 'save_rate_percent',
      metric_value: String(r.rate),
      impressions: String(r.impressions || r.reach || r.views || ''),
      clicks: String(r.clicks || r.saves || ''),
      text: r.text,
    },
  }));

  function p(pl) {
    const labels = { instagram: 'Instagram', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube' };
    return labels[pl] || pl.charAt(0).toUpperCase() + pl.slice(1);
  }
  function describe(r) {
    if (r.ctr != null) return `impressions ${r.impressions}, clicks ${r.clicks}, CTR ${r.ctr}%`;
    if (r.rate != null && r.reach != null) return `reach ${r.reach}, saves ${r.saves}, save-rate ${r.rate}%`;
    if (r.views != null) return `views ${r.views}, avg watch ${r.watch_pct}%, engagement ${r.rate}%`;
    return `metric ${r.rate}%`;
  }
}

export async function retainUserPosts(userId, platform) {
  const items = samplePostsFor(platform, userId);
  await retain(items);
  return items;
}

export async function retainWinnerForUser(userId, platform, topHookMemory) {
  topHookMemory.tags = [...(topHookMemory.tags || []), `user:${userId}`, ...(platform ? [`platform:${platform}`] : [])];
  topHookMemory.metadata = { ...(topHookMemory.metadata || {}), user_id: userId, platform };
  await retain([topHookMemory]);
  return topHookMemory;
}
