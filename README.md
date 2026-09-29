# Social Media Engagement Agent (Hindsight memory)

[![Live landing page](https://img.shields.io/badge/landing%20page-GitHub%20Pages-6ea8fe)](https://sujal1234-arch.github.io/social-engagement-agent/)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sujal1234-arch/social-engagement-agent)

An AI-powered social media engagement agent. It uses **Hindsight** (Vectorize) as its persistent memory layer to learn which posts, hooks, and reply styles work for your audience — then recommends hooks, captions, hashtags, and posting times, runs A/B tests, suggests comment replies, and **writes winning tactics back into memory** so recommendations improve over time.

Demo story: generic post (low CTR) → agent recalls past winners from Hindsight → memory-informed hook + control hook scheduled as an A/B test → memory-informed variant wins ~3× CTR → winning hook is saved back to Hindsight as a `top_hook` memory.

**Try it now:** landing page with a live widget → https://sujal1234-arch.github.io/social-engagement-agent/ · full app → https://social-engagement-agent.onrender.com (free tier: ~40s wake on first visit).

## Quick start

```bash
# 1. Backend (port 4000)
cd backend
npm install
cp .env.example .env   # optional: add Hindsight + LLM keys
npm start

# 2. Import seed data into Hindsight memory (50 posts + 50 comments)
curl -X POST http://localhost:4000/api/import

# 3. Frontend (port 5173, proxies /api to :4000)
cd ../frontend
npm install
npm run dev
```

Open http://localhost:5173 and run the flow: **Recommend → approve → Create A/B → Schedule A + B → Fetch results**.

Or from the repo root: `npm run dev` starts both servers at once.

## Deploy (one URL for app + API)

The Express server also serves the built frontend from `frontend/dist`, so a single service hosts everything:

```bash
npm run install:all && npm run build && npm start   # http://localhost:4000
```

### Render (free)

1. Push this repo to GitHub.
2. In [Render](https://render.com) → **New → Blueprint**, pick the repo (`render.yaml` included), or create a Web Service with:
   - Build: `npm run install:all && npm run build`
   - Start: `npm start`
3. Add env vars: `HINDSIGHT_BASE_URL`, `HINDSIGHT_API_KEY`, `GROQ_API_KEY` (values from your `backend/.env`).
4. After the first deploy, seed memory once: `curl -X POST https://your-app.onrender.com/api/import`.

Note: the free tier sleeps after ~15 min idle (first visit wakes it in ~50s). A/B test records are ephemeral on free hosting — by design the *durable* memory lives in Hindsight Cloud, so recommendations and learned hooks survive redeploys.

## Configuration (backend/.env)

Everything is optional — the app degrades gracefully so the demo always runs:

| Setting | Purpose | Without it |
|---|---|---|
| `HINDSIGHT_BASE_URL` + `HINDSIGHT_API_KEY` | Hindsight Cloud (`https://api.hindsight.vectorize.io`) | JSON-file memory fallback (same retain/recall contract) |
| `HINDSIGHT_BASE_URL=http://localhost:8888` | Local Hindsight OSS server | same fallback |
| `GROQ_API_KEY` or `OPENAI_API_KEY` | LLM for hooks/captions/replies | deterministic template fallback |
| `HINDSIGHT_BANK_ID` | memory bank name | `social-engagement-agent` |
| `AUTH_SECRET` | JWT signing + AES-256-GCM token encryption | dev fallback secret (set this in production) |
| `DATABASE_URL` | Postgres for users + connected accounts (survives redeploys) | SQLite (`data/agent.db`), then a JSON file |
| `AUTH_DEV_MODE=1` | returns `dev_reset_token` from the reset-request endpoint (local testing) | token is not returned (wire SMTP to email it) |
| `<PLATFORM>_CLIENT_ID` / `_SECRET` (e.g. `LINKEDIN_`, `INSTAGRAM_`, `X_`, `FACEBOOK_`, `PINTEREST_`, `REDDIT_`) | real OAuth for connecting social accounts | clearly-labelled **demo consent** flow (same full connect → import → per-user memory path) |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | real **Google sign-in** (the same client also covers the YouTube connection) | labelled demo sign-in modal with the same account/personal-memory behavior |
| `TELEGRAM_BOT_TOKEN` | Telegram/WhatsApp channel | demo consent |

The header pills in the UI show which mode is active (`memory: hindsight` vs `memory: fallback`).

## Persistence

Accounts, connected platform tokens and one-time tokens are stored in the first store available:

1. **Postgres** (`DATABASE_URL`) — used on Render via the Blueprint's managed database, so logins survive redeploys. Free instances expire after ~30 days.
2. **SQLite** (`data/agent.db`, `node:sqlite`) — local default.
3. **JSON file** (`data/users-fallback.json`) — last resort.

`/api/health` reports which engine is active (`db: postgres|sqlite|json`). Content memory always lives in Hindsight, independent of this store.

## Auth hardening

- **Login/register rate limits** — 10 attempts / 15 min per IP+email; registration 20/hour per IP.
- **Refresh tokens** — 30-day, rotated on every use; reusing a rotated token is rejected. `POST /api/refresh` renews the 7-day access JWT.
- **Logout** — revokes all refresh tokens for the user.
- **Password reset** — `POST /api/password/reset-request` always answers the same way (no account enumeration); the single-use token expires in 30 min. Set `AUTH_DEV_MODE=1` to receive it directly, or wire SMTP to email it.
- Passwords use `scrypt` with per-user salts; platform tokens are AES-256-GCM encrypted at rest.

## Accounts, connections & per-user memory

Sign in with **Google** (real consent screen when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set, otherwise a labelled demo sign-in) or with email + password (`scrypt` hashed). Users and connected accounts live in the first store available (Postgres → SQLite → JSON); platform access tokens are stored AES-256-GCM encrypted.

Connecting a platform (`Connect Instagram`, …) stores the account and retains that platform's sample posts into memory tagged `user:<id>` + `platform:<platform>`. From then on `/api/recommend` recalls **only that user's** history for that platform, the A/B winner is written back into their personal memory, and `/api/memory` shows their own pool:

```
Provenance: • instagram reel_12 — 8% saves  • instagram reel_07 — 6.5% saves
```

Anonymous callers still get the shared demo pool, so the hosted demo and landing-page widget keep working without sign-in:

| Endpoint | Description |
|---|---|
| `POST /api/register` / `POST /api/login` | `{email, password, name?}` → `{token, refresh_token, user}` (JWT 7d, refresh 30d) |
| `GET /api/auth/google/start` | redirects to Google consent (or reports demo mode) |
| `POST /api/auth/google/exchange` | trades the redirect code for a session |
| `POST /api/auth/google/demo` | labelled demo sign-in → `{token, refresh_token, user}` |
| `POST /api/refresh` | `{refresh_token}` → rotated token pair |
| `POST /api/logout` | revoke the caller's refresh tokens |
| `POST /api/password/reset-request` / `POST /api/password/reset` | single-use reset token (30 min) |
| `GET /api/me` | profile + connected accounts |
| `GET /api/platforms` | platform registry (scopes, whether real OAuth is configured) |
| `GET /api/connect/:platform/start` | starts OAuth (redirect) or returns a demo-consent confirm URL |
| `GET /api/connect/:platform/callback` | real OAuth callback → stores encrypted token + imports posts |
| `POST /api/disconnect` | `{platform}` → revoke + forget |
| `GET/POST /api/preferences` | memory scope: `personal` (default) or `team` |

**Memory scope** — every account defaults to recalling only its own memories. The **My account** panel has a Personal-only / Team-wide toggle: team-wide widens recall to the shared pool (your posts + everyone's), so a team can share one agent brain. The choice is stored per user in the DB and applied server-side in `/api/recommend` and `/api/memory`.

## How Hindsight is used

- **Retain**: every seed post is stored as a memory with its performance facts (impressions, clicks, CTR) and tags (`post`, `platform:linkedin`, `top_performer` / `solid` / `low_performer`); every comment with an auto tag (`issue:pricing`, `issue:auth-security`, …). A/B winners are retained as `top_hook` memories with ab_id, CTR, uplift and the "why".
- **Recall**: `/api/recommend` recalls top-performer posts (4-strategy retrieval: semantic + keyword + graph + temporal, reranked by Hindsight) and passes the 3 best to the LLM as context. `/api/reply-suggest` recalls similar past comments.
- **Learn**: after an A/B test completes, the winning hook is written back with full provenance and shows up in the UI's memory panel — and influences future recommendations.

## API

| Endpoint | Description |
|---|---|
| `POST /api/import` | Seed Hindsight with posts + comments from CSVs |
| `GET /api/recommend?channel=linkedin&topic=` | `{hook, hook_b, caption, hashtags, best_time, why, examples}` |
| `POST /api/create-ab` | Create A/B test → `{ab_id}` |
| `POST /api/schedule` | Schedule a variant `{ab_id, variant, time?}` (mock scheduler) |
| `GET /api/ab-results/:id` | Real platform metrics when the account is connected, else the simulator; reports `metrics_source` + `metrics_note`; writes the winner back to Hindsight |
| `POST /api/reply-suggest` | `{comment}` → `{reply, tag}` (recall-augmented) |
| `GET /api/memory` (signed in) | only that user's retained posts / hooks |
| `GET /api/health` | Memory mode + LLM provider + DB engine status |

A/B metrics: when the signed-in user has a connected platform with a real access token, `/api/ab-results` reads that platform's insights API (Instagram Graph, LinkedIn socialActions, Facebook insights, YouTube statistics). Otherwise it falls back to a deterministic simulation (memory-informed variant lands at ~5–6.4% CTR vs ~1.5–2.1% control) — and the response always states which source was used, so nothing is silently faked.

### Turning on real OAuth per platform

Set the platform's client id/secret (e.g. `LINKEDIN_CLIENT_ID`, `INSTAGRAM_CLIENT_ID`) and register this redirect URI in the provider's developer console:

```
https://<your-host>/api/connect/<platform>/callback
```

Scopes are requested per platform (LinkedIn `r_liteprofile r_emailaddress w_member_social`; Instagram `instagram_basic instagram_manage_insights instagram_manage_comments`; others read + publish + insights). Until credentials are configured, connect buttons run a clearly-labelled **demo consent** flow so the whole connect → import → per-user memory path still works. Note that LinkedIn's `w_member_social` and Meta's insights scopes require app review before they work in production.

## 60-second demo script

1. **Problem (10s)** — "New API release notes" style post: 0.1% CTR. Generic content doesn't work.
2. **Agent action (20s)** — Click **Recommend**. The agent recalls top-CTR posts from Hindsight memory and returns Hook A + provenance: *"Suggested because: matched post #11 — 7% CTR"*. Tick **human approval**, **Create A/B test**, **Schedule A + B**.
3. **Result (20s)** — Click **Fetch A/B results**: memory-informed hook wins, e.g. 6.13% vs 1.94% CTR (**3.16× uplift**). The winning hook is written back to Hindsight and appears in the memory panel.
4. **Close (10s)** — Click a pricing comment: reply template + `pricing` tag suggested from memory. Approve & apply. Memory grows every cycle.

## Project structure

```
├── backend/            Express API
│   ├── src/server.js   endpoints (import/recommend/ab/reply/memory)
│   ├── src/hindsight.js Hindsight adapter (cloud/OSS + fallback)
│   ├── src/llm.js      Groq/OpenAI + template fallback
│   ├── src/ab.js       A/B store + deterministic simulator
│   └── src/local-memory.js  file fallback memory (same contract)
├── frontend/           React (Vite) single-page UI
│   └── src/App.jsx     composer · approval · scheduler · dashboard · memory panel · reply modal
├── data/posts.csv      50 seed posts (winners + losers)
├── data/comments.csv   50 seed comments
└── data/ab-tests.json  A/B test records (created at runtime)
```

## Notes for judges

- Hindsight is the memory layer (retain/recall of post performance, comment issues, and winning hooks), used end-to-end.
- Human-in-the-loop: nothing is scheduled without the approval checkbox.
- Provenance: every recommendation shows which memory entries (post ids + CTR) produced it.
- Swap the mock scheduler for LinkedIn/Twitter APIs later; the A/B + memory loop is integration-agnostic.
