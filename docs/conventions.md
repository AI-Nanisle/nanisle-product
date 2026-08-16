# Conventions: how a product ships each week

This doc is the weekly operating manual. It also explains the repo's structure to anyone forking it.

## The weekly loop

1. **Copy the template.** `templates/web-app/` → `products/NNN-slug/`. `NNN` is a zero-padded increasing number, `slug` matches the product page slug on nanisle.com (e.g. `001-reddit-gap-finder`).
2. **Rename.** In the new folder: `name` in `package.json` and `name` in `wrangler.jsonc` become `nanisle-NNN-slug` (the Worker name must be account-unique).
3. **Build the MVP — ≤8 hours for v1.** Replace the demo route and UI. Keep the AI seam (`src/worker/ai.ts`) and the guard (`src/worker/guard.ts`) intact so all three run modes keep working.
4. **Fill in the README** using the template's section skeleton: what it is, why, how it works, how to run it, env vars.
5. **Verify the fork path**: fresh clone of just this folder, `npm install && npm run dev` must work in mock mode with zero configuration. This is principle #1 and it is a release gate.
6. **Deploy** with `npm run deploy`. Hosted instances set secrets via `wrangler secret put` (never in files): `ACCESS_CODE` always; `AI_GATEWAY_KEY` + `AI_GATEWAY_URL` if the product uses AI.
7. **Publish**: add the row to the catalog tables in **both** root READMEs (`README.md` and `README.zh-CN.md`); add the product `.md` to the nanisle.com site (private platform repo) and deploy the site.

## Rules that keep the repo healthy

- **Self-contained folders.** A product never imports from another product or from `templates/`. Copy code instead of sharing it. If the same code has been copied 3+ times and hurts, that's the moment to consider a shared package — not before.
- **No root workspace.** There is intentionally no root `package.json`. Each folder installs and deploys on its own, so deleting or archiving a product is `git rm -r` and nothing else breaks.
- **Mock mode is mandatory.** Every AI-using product must run end-to-end with `AI_PROVIDER=mock` so that forks, demos-gone-broke, and CI never depend on live keys.
- **Secrets discipline** is defined in [SECURITY.md](../SECURITY.md) and [ai-access.md](ai-access.md). Short version: nothing secret is ever a file in this repo.
- **Failures ship too.** A product that didn't work still gets its folder, README ("what I learned"), and island on the chart.

## Definition of done (weekly checklist)

- [ ] v1 built in ≤8h, solves my own need this week
- [ ] Fresh-clone mock-mode run works with zero config
- [ ] README filled (what/why/run/env vars)
- [ ] `.dev.vars.example` lists every env var the product reads
- [ ] Hosted demo: `ACCESS_CODE` set, gateway key budgeted, kill switch understood (`AI_DISABLED=1` + redeploy)
- [ ] Catalog row added to both READMEs; nanisle.com page published

## Template stack (why these choices)

| Choice | Reason |
|---|---|
| Cloudflare Workers | Free tier, one-command deploy, `*.workers.dev` URL out of the box — a forker needs no paid infra |
| Vite + React 19 | `npm run dev` gives instant local dev; the official `@cloudflare/vite-plugin` runs the real Worker runtime locally |
| Hono | Tiny router for `/api/*`; the whole backend is three small files |
| Tailwind v4 | UI for a weekly MVP has a time budget of ~1 hour; utility CSS respects that |
| `@anthropic-ai/sdk` | One client covers both "your own key" and "gateway" modes via `baseURL`/`authToken` |

New product shapes (CLI tool, pure API, dataset) can add new templates later (`templates/cli/`, ...). Don't build a template until a real product needs it.
