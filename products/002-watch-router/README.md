# 观影路由 Watch Router

One sentence: paste a video / podcast / article link — AI watches it first, tells you whether it's worth your time, what it says, and exactly which minutes (or paragraphs) to jump back to.

**[Story & context](https://nanisle.com/products/watch-router)** · Week 002 of [nanisle](https://nanisle.com)

## Why I built this

A daily brief (product 001) answers "is this link worth clicking". But when the link is a one-hour podcast or video, clicking is only the start of the cost. 002 answers the next question: **which minutes are worth it**. The summary and the map back to the original are two sides of one thing — this is a router to the good parts, not a replacement for them.

## What it does

- **One inbox for everything**: article URLs and pasted text get processed in seconds (streamed as they generate); videos and podcasts go through an async pipeline with live progress.
- **Three outputs per item**: a one-line verdict (worth it / partial / skip), key points — each pinned to a verbatim quote from the source, and a chapter map covering the whole timeline with low-value segments (ads, filler) greyed out.
- **Every quote is verified**: the model must cite the source verbatim; the worker string-matches each quote against the extracted text. Quotes that don't match are flagged "couldn't locate in source" instead of silently trusted.
- **Jump back precisely**: YouTube/Bilibili chapters link with `t=` timestamps; article chapters scroll to the exact paragraph.
- **Cached per content**: the second person (or the second URL form) of the same video gets the result instantly, free.

## How it works

```text
Browser (React, src/react-app/)
   │  POST /api/submit
   ▼
Cloudflare Worker (Hono, src/worker/)
   ├─ fast lane: extract (Defuddle → Readability → r.jina.ai) → one streamed
   │             DeepSeek call → quote anchoring → KV content cache
   └─ slow lane: DynamoDB task + SQS message ──► Lambda consumer (yt-dlp /
                 whisper, container image) ──► /api/queue/* callbacks ──► KV
```

- All AI calls go through the seam in `src/shared/ai.ts` (mock / deepseek / anthropic / gateway). No credentials exist in this repo.
- State split (docs/02 T6): KV holds only recomputable content cache; quotas, task state and user records live in DynamoDB; the queue is SQS. **Task state is only ever written by the Worker** — the consumer talks back through authenticated HTTP endpoints.
- The AWS side is defined in the maintainer's private infra repo (CDK). Fork mode needs none of it — see below.

## Run it yourself

Requires Node.js ≥ 22.

```bash
npm install
npm run dev        # http://localhost:5200 — mock AI, in-memory store, zero keys
```

Mock mode is a complete tour: fast lane returns a built-in sample result; the slow lane simulates the whole queue → progress → done lifecycle without any AWS.

Real AI with your own key: `cp .dev.vars.example .dev.vars`, then set

```ini
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-own-key
```

## Deploy

Two halves, **two commands — both are required for the slow lane** (the fast lane works with just the first):

```bash
# 1. Worker (this folder; free Cloudflare account is enough)
npx wrangler kv namespace create WATCH   # once; paste the id into wrangler.jsonc
npm run deploy

# 2. AWS side (maintainer's private infra repo; table + queue + consumer Lambda)
npx cdk deploy NanisleWatchRouter --profile <your-profile>
```

Worker secrets (`wrangler secret put`, never in files): `NANISLE_SSO_SECRET`, `ACCESS_CODE`, `CONSUMER_TOKEN`, `JINA_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `DEEPSEEK_API_KEY`.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `AI_PROVIDER` | no (`deepseek`, falls back to mock without key) | `mock` \| `deepseek` \| `anthropic` \| `gateway` |
| `DEEPSEEK_API_KEY` | deepseek mode | secret |
| `AI_MODEL` / `FAST_AI_MODEL` | no | edit call / per-user highlight call |
| `NANISLE_SSO_SECRET` | hosted | secret; login handoff from the main site |
| `CONSUMER_TOKEN` | slow lane | secret; auths `/api/queue/*` callbacks |
| `JINA_KEY` | no | r.jina.ai extraction fallback (anonymous tier works, tightly rate-limited) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | slow lane + quotas | secret; minimal-permission IAM user |
| `DDB_TABLE` / `AWS_REGION` / `QUEUE_URL` | slow lane + quotas | vars, see wrangler.jsonc |
| `AI_MAX_OUTPUT_TOKENS`, `AI_DISABLED`, `DEV_EMAIL` | no | cost cap / kill switch / local identity |

## Known constraints (read before opening access)

- **Invite-only by design for now.** Before opening registration, replicate 001's open-access guardrails (signup rate limiting, per-IP daily quotas, model tiering) — the storage/queue layer is already sized for it, the gate layer is not.
- **Lambda consumer limits**: 15-minute hard cap (a very long video + whisper fallback + slow proxy can breach it — the task then fails explicitly and the UI offers paste-a-transcript); account-level concurrency quota is still low pending an AWS limit increase, so the spending brake is the submit quota + a CloudWatch invocation alarm, not reserved concurrency.
- **Fast-lane success rate on hard-protected sites depends on r.jina.ai** (Workers egress IPs are datacenter IPs). The paste box is the guaranteed fallback and always will be.

## Tech

React 19 + Vite 7 + Tailwind 4 · Hono on Cloudflare Workers · linkedom + Defuddle + @mozilla/readability · aws4fetch (DynamoDB/SQS SigV4) · DeepSeek (streamed) · Groq whisper (slow lane)

## License

MIT, per the [repo root](../../LICENSE).
