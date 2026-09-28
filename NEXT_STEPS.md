# Where things stand (handoff note)

_Delete this file before final submission if you prefer a clean repo — it is only a working note._

## Done and verified

- **App works end to end**: recommend → approve → A/B → winner → Hindsight memory writeback → comment reply.
- **Hindsight Cloud is live** (bank `social-engagement-agent`): 100 seed memories (50 posts + 50 comments), retain/recall/writeback verified.
- **Groq LLM is live** (`openai/gpt-oss-120b` — note: `llama-3.3-70b-versatile` was retired by Groq, default updated).
- **Demo video recorded**: `demo/demo-video.mp4` (2:45) + player at `demo/index.html`.
- **Repo pushed, public**: https://github.com/sujal1234-arch/social-engagement-agent
- **Production build fixed**: install/build use `--include=dev` so vite installs when `NODE_ENV=production` (this is what broke the first Render deploy).
- **Secrets stay local**: `backend/.env` is gitignored and not in the repo.

## Left to do

1. **Deploy the live website** (Render): Blueprint → **Manual sync**, or New + → Web Service:
   - Build: `npm run install:all && npm run build`
   - Start: `npm start`
   - Env: `HINDSIGHT_BASE_URL`, `HINDSIGHT_API_KEY`, `GROQ_API_KEY` (values in `backend/.env`)
2. **Verify the deployed URL**: check `/api/health`, run one recommend + A/B cycle, confirm writeback.
3. **Post to Microsoft Developer**: live URL + https://github.com/sujal1234-arch/social-engagement-agent + demo video.

## Local servers (restart after reboot)

```bash
npm run dev          # backend :4000 + frontend :5173
npm start            # production mode: one URL at :4000 (needs frontend/dist built)
npm run verify       # Hindsight Cloud connectivity smoke test
npm run import       # seed memory (idempotent)
```

Notes: memory lives in Hindsight Cloud, so recommendations and learned hooks survive redeploys.
On Render's free tier the service sleeps after ~15 min idle (~50s to wake) and local A/B records are ephemeral — the durable learning is in Hindsight by design.
