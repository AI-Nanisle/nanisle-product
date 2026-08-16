# Product Name

One sentence: what this does and for whom.

**[Live demo](https://nanisle-NNN-slug.pang-huadong0811.workers.dev)** · **[Story & context](https://nanisle.com/products/slug)** · Week NNN of [nanisle](https://nanisle.com)

> **Using this template?** Copy this folder to `products/NNN-slug/`, rename `name` in `package.json` and `wrangler.jsonc`, then follow [docs/conventions.md](../../docs/conventions.md). Keep the section skeleton below and fill it in.

## Why I built this

The need being validated this week, in 2–4 sentences. Include what turned out to be true or false.

## What it does

- Feature one
- Feature two

## How it works

```text
Browser (React, src/react-app/)
   │  fetch /api/*
   ▼
Cloudflare Worker (Hono, src/worker/)
   ├─ guard.ts   access code gate + kill switch
   └─ ai.ts      one seam, three modes: mock | your own key | gateway
```

All AI calls go through `src/worker/ai.ts`. No credentials exist in this repo — see [docs/ai-access.md](../../docs/ai-access.md).

## Run it yourself

Requires Node.js ≥ 22 (wrangler's minimum; `npm run dev` also works on 20.19+).

```bash
npm install
npm run dev        # http://localhost:5173 — mock AI, zero keys needed
```

Real AI with your own key: `cp .dev.vars.example .dev.vars`, then set

```ini
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-own-key
```

Deploy your own copy (free Cloudflare account is enough):

```bash
npx wrangler login
npm run deploy     # builds and ships to <name>.<your-subdomain>.workers.dev
```

For a hosted instance, set secrets with `wrangler secret put ACCESS_CODE` (and `AI_GATEWAY_KEY` / `ANTHROPIC_API_KEY` as applicable) — never in files.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `AI_PROVIDER` | no (`mock`) | `mock` \| `anthropic` \| `gateway` |
| `ANTHROPIC_API_KEY` | anthropic mode | secret |
| `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` | gateway mode | key is secret |
| `ACCESS_CODE` | public hosting | secret; gates `/api/demo` |
| `AI_MODEL`, `AI_MAX_OUTPUT_TOKENS`, `AI_DISABLED` | no | see [docs/ai-access.md](../../docs/ai-access.md) |

## Tech

React 19 + Vite 7 + Tailwind 4 · Hono on Cloudflare Workers ([`@cloudflare/vite-plugin`](https://developers.cloudflare.com/workers/vite-plugin/)) · `@anthropic-ai/sdk`

## License

MIT, per the [repo root](../../LICENSE).
