# Social Media Engagement Agent (Hindsight memory)

[![Live landing page](https://img.shields.io/badge/landing%20page-GitHub%20Pages-6ea8fe)](https://sujal1234-arch.github.io/social-engagement-agent/)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/sujal1234-arch/social-engagement-agent)

An AI-powered social media engagement agent built for the Hindsight hackathon. It uses **Hindsight** (Vectorize) as its persistent memory layer to learn which posts, hooks, and reply styles work for your audience — then recommends hooks, captions, hashtags, and posting times, runs A/B tests, suggests comment replies, and **writes winning tactics back into memory** so recommendations improve over time.

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

The header pills in the UI show which mode is active (`memory: hindsight` vs `memory: fallback`).

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
| `GET /api/ab-results/:id` | Simulated metrics + winner; writes winner back to Hindsight |
| `POST /api/reply-suggest` | `{comment}` → `{reply, tag}` (recall-augmented) |
| `GET /api/memory` | Memory panel: stored posts, comments, top hooks |
| `GET /api/health` | Memory mode + LLM provider status |

A/B metrics are a deterministic simulation (memory-informed variant lands at ~5–6.4% CTR vs ~1.5–2.1% control, matching the real distribution in the seed data) so the demo is stable and reproducible.

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

- Hindsight is the memory layer (retain/recall of post performance, comment issues, and winning hooks) — required by the hackathon brief, used end-to-end.
- Human-in-the-loop: nothing is scheduled without the approval checkbox.
- Provenance: every recommendation shows which memory entries (post ids + CTR) produced it.
- Swap the mock scheduler for LinkedIn/Twitter APIs later; the A/B + memory loop is integration-agnostic.
