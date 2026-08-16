# 001 · Daily Brief

A **finite, feedback-aware daily brief**. It reads your sources once a day, picks at most ~8 items into three value sections, and for each one answers a single question — *"why is this worth 10 minutes of your time?"* — with the original link attached. It is a router to the originals, never a replacement for them.

Built after a previous digest tool failed the only test that matters: its own author stopped reading it. The design decisions (finiteness, original links, per-item feedback, an accountability section showing what was filtered out) come from researching why that happens — see [docs/01-产品方案.md](docs/01-产品方案.md) (Chinese) for the full design doc with sources.

## How it works

```
pipeline/generate.ts (run anywhere: laptop, cron, CI)
  → fetch sources.yaml feeds (rules filter first — cheap)
  → LLM editorial pass (reads focus.yaml, picks ≤3+3+2 items, writes "why click")
  → brief.json → POST /api/ingest
Cloudflare Worker
  → serves the reading page (React) from KV
  → collects feedback (👍/👎/free text/"I wanted that one") into KV
  → /go/:date/:id redirect logs every click — the implicit signal
```

Sections: **今日大事** (don't miss it) · **项目弹药** (ammo for what you're building — every item must name which focus entry it relates to) · **教我新东西** (teach me something) · plus a collapsed **已替你筛掉** list so "saving you time" is a visible, auditable number.

Anti-fabrication by construction: the model only returns candidate ids and text derived from fetched excerpts; every URL comes from a feed or the HN API.

## Run it

```bash
npm install
npm run dev        # reading page at localhost:5173 with a built-in sample brief (mock, zero keys)
npm run generate   # fetch real feeds → pipeline/out/brief-<date>.json (mock editorial without a key)
```

For a real editorial pass, copy `.dev.vars.example` to `.dev.vars` and set `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` (or `gateway`, see [docs/ai-access.md](../../docs/ai-access.md)). Copy `focus.example.yaml` to `focus.yaml` (gitignored) and write down what you're actually working on — the ammo section is built from it.

To host: `wrangler kv namespace create BRIEFS`, paste the id into `wrangler.jsonc`, set secrets (`ACCESS_CODE` — the brief mirrors your focus list, keep it private; `INGEST_TOKEN`), then `npm run deploy`. Schedule `npm run generate` daily anywhere with `INGEST_URL` + `INGEST_TOKEN` set.

## Env vars

Everything the product reads is listed in [.dev.vars.example](.dev.vars.example) — worker vars (AI seam, `ACCESS_CODE`, `INGEST_TOKEN`) and pipeline vars (`INGEST_URL`, `BRIEF_TZ`, `FOCUS_FILE`).

## Status / roadmap

v1 (this): generation quality + original links + feedback collection. v2: feedback echo ("less X today, you asked"), AI source recommendation with human review, push digest. v3: transcript sources (Bilibili/podcasts via whisper), macro-indicator tracking. The v1 acceptance test is honest: the author reads it five days straight and clicks at least two originals a day — otherwise fix content, not features.
