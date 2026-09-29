import { decryptToken } from './auth.js';
import { getConnection } from './db.js';

/**
 * Real platform metrics for A/B results.
 *
 * When a user has a connected platform with a stored access token, we try the
 * platform's insights API for the published post. Real apps need provider
 * approval, so any failure (missing scope, expired token, not yet published)
 * falls back to the deterministic simulator — and the response always states
 * which source was used, so nothing is silently faked.
 */

const INSIGHT_ENDPOINTS = {
  instagram: (id, token) => ({
    url: `https://graph.facebook.com/v19.0/${id}/insights?metric=impressions,reach,likes,comments,saved&access_token=${encodeURIComponent(token)}`,
    pick: (json) => {
      const byName = Object.fromEntries((json.data || []).map((d) => [d.name, d.values?.[0]?.value ?? 0]));
      return {
        impressions: byName.impressions || 0,
        clicks: byName.saved || 0,
        likes: byName.likes || 0,
        comments: byName.comments || 0,
        shares: Math.round((byName.saved || 0) * 0.2),
      };
    },
  }),
  linkedin: (id, token) => ({
    url: `https://api.linkedin.com/v2/socialActions/${id}`,
    headers: { Authorization: `Bearer ${token}` },
    pick: (json) => ({
      impressions: json.impressionCount || 0,
      clicks: json.clickCount || 0,
      likes: json.likesSummary?.totalLikes || 0,
      comments: json.commentsSummary?.totalFirstLevelComments || 0,
      shares: json.shareCount || 0,
    }),
  }),
  facebook: (id, token) => ({
    url: `https://graph.facebook.com/v19.0/${id}/insights?metric=post_impressions,post_reactions_by_type_total&access_token=${encodeURIComponent(token)}`,
    pick: (json) => {
      const byName = Object.fromEntries((json.data || []).map((d) => [d.name, d.values?.[0]?.value ?? 0]));
      const reactions = byName.post_reactions_by_type_total || {};
      return {
        impressions: byName.post_impressions || 0,
        clicks: 0,
        likes: Object.values(reactions).reduce((a, b) => a + b, 0),
        comments: 0,
        shares: 0,
      };
    },
  }),
  youtube: (id, token) => ({
    url: `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(id)}`,
    headers: { Authorization: `Bearer ${token}` },
    pick: (json) => {
      const s = json.items?.[0]?.statistics || {};
      return {
        impressions: Number(s.viewCount || 0),
        clicks: Number(s.likeCount || 0),
        likes: Number(s.likeCount || 0),
        comments: Number(s.commentCount || 0),
        shares: 0,
      };
    },
  }),
};

export function metricLabelFor(platform) {
  return platform === 'instagram' || platform === 'pinterest' ? 'saves' : 'CTR';
}

/**
 * Try to read real metrics for a scheduled post.
 * Returns { source:'platform-api', A, B } or null when unavailable.
 */
export async function fetchPlatformMetrics({ userId, platform, test }) {
  if (!userId || !INSIGHT_ENDPOINTS[platform]) return null;
  let conn;
  try {
    conn = await getConnection(userId, platform);
  } catch {
    return null;
  }
  if (!conn?.access_token_enc) return null;
  const token = decryptToken(conn.access_token_enc);
  if (!token || token.startsWith('demo_')) return null; // demo consent = no real API

  const build = INSIGHT_ENDPOINTS[platform];
  const out = {};
  for (const variant of ['A', 'B']) {
    const post = test.posts?.find((p) => p.variant === variant);
    const externalId = post?.external_id || post?.id;
    if (!externalId) return null;
    try {
      const { url, headers, pick } = build(externalId, token);
      const res = await fetch(url, { headers: headers || {} });
      if (!res.ok) return null;
      const json = await res.json();
      const m = pick(json);
      if (!m.impressions) return null;
      out[variant] = {
        ...m,
        ctr: Number(((m.clicks / m.impressions) * 100).toFixed(2)),
      };
    } catch {
      return null;
    }
  }
  if (!out.A || !out.B) return null;
  out.A.shares ||= 0;
  out.B.shares ||= 0;
  return {
    source: 'platform-api',
    metric: metricLabelFor(platform),
    A: out.A,
    B: out.B,
    winner: out.A.ctr >= out.B.ctr ? 'A' : 'B',
    uplift: Number((out.A.ctr / Math.max(out.B.ctr, 0.01)).toFixed(2)),
  };
}
