# nanisle-product

**English** | [中文](README.zh-CN.md)

**One small product every week, open source.** Each product validates one real need, ships in ≤8 hours, and lives at [nanisle.com](https://nanisle.com) — every product is an island on the chart.

## Products

| # | Product | One-liner | Demo | Source |
|---|---------|-----------|------|--------|
| 001 | Daily Brief | A finite daily brief that routes you to originals — never replaces them | _soon_ | [products/001-daily-brief](products/001-daily-brief/) |
| 002 | Watch Router | AI watches the hour-long video first: verdict, verified key points, and a chapter map back to the good minutes | _building_ | [products/002-watch-router](products/002-watch-router/) |

## Principles

1. **Take it and run.** Every product is a self-contained folder. Copy it out of this repo, `npm install`, `npm run dev` — it works immediately in mock mode with zero keys, and works with **your own** Anthropic API key for real AI. Fork-friendly is the point.
2. **Smallest thing that works.** First version ships in ≤8 hours and solves the author's own need. Expect MVPs, not platforms.
3. **No tokens in here, ever.** Hosted demos run on the owner's AI subscription behind a private gateway with budgets and rate limits. This repo contains zero credentials and zero private infrastructure — see [docs/ai-access.md](docs/ai-access.md) and [SECURITY.md](SECURITY.md).

## Repository layout

```text
products/           one folder per weekly product: NNN-slug/ (self-contained, no shared code)
templates/
  web-app/          the starting template: React + Hono on Cloudflare Workers, AI seam included
docs/
  conventions.md    how a product gets built and shipped each week
  ai-access.md      how products talk to AI: mock / your own key / gateway, and anti-abuse design
```

Products deliberately do **not** share a workspace or import each other. Duplication is fine; coupling is not — it keeps every folder independently copyable.

## Run any product

```bash
cd products/NNN-whatever   # or templates/web-app
npm install                # Node.js ≥ 22
npm run dev                # mock AI mode — no keys needed
```

Want real AI? Put your own key in `.dev.vars` (copy from `.dev.vars.example`):

```ini
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-own-key
```

Deploy your own copy to Cloudflare Workers (free tier is fine):

```bash
npx wrangler login
npm run deploy
```

Full details, including pointing a product at any Anthropic-compatible gateway (e.g. [LiteLLM](https://docs.litellm.ai/docs/proxy/virtual_keys)): [docs/ai-access.md](docs/ai-access.md).

## Why the hosted demos ask for an access code

The demos on nanisle.com run on the owner's AI subscription. To keep them alive (and not farmed by bots), AI endpoints are gated by an access code and hard-capped by a private gateway. Running your own copy with your own key has no such gate.

## License

[MIT](LICENSE). Use it, fork it, sell it — attribution appreciated, not required.
