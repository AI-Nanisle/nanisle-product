# 领域拆解 Weekly Teardown

One sentence: describe the technical field you're watching in one sentence — every Monday morning you get 5 candidate open-source projects and what changed since last week; click one and it runs a deep teardown with verbatim quotes and permanent links back to the exact lines.

**[Story & context](https://nanisle.com/products/weekly-teardown)** · Week 003 of [nanisle](https://nanisle.com)

> **Status: feature-complete, not deployed.** Phases 1-9 of 10 are in: scaffold, main-site mount, SSO handoff, the D1 schema with per-account/per-IP quota and a $3/day global spend cap, the dossier (one sentence in, four editable sections out), the discovery layer (dual-route GitHub search → rule filter → ledger), the first screen with its exclusion list and search ledger, the deep teardown over SSE with verbatim anchoring, the Monday cron with its doorbell email, the week-over-week recheck, and the email subscription switch. What is left is phase 10: deploying it and living with it for a week. Plan and every landing record: [`docs/02-技术方案.md`](docs/02-技术方案.md).

## Why I built this

Keeping up with a fast-moving field is a weekly chore that never converges: you search GitHub, skim stars, open a few READMEs, and a week later you can't remember which of them you already dismissed and why. One-shot research tools re-do that work from zero every time — the state *between* weeks is the thing nobody keeps.

So the product keeps it. Your dossier (the sentence, what you care about, what you don't, the search queries) is editable and versioned; every weekly scan is stored with the exact queries it ran and a ledger of how many repos came back, were admitted, were excluded and why. The second week is where it earns its keep: you see the diff, not another cold list.

The second half is about trust. A weekly digest that quietly makes things up is worse than no digest. So every judgement in a teardown must hang off a verbatim quote that the code — not the model — has string-matched back into the source it claims to come from, with a permalink pinned to a commit SHA. Judgements whose evidence didn't anchor are **dropped**, not greyed out, and the drop rate is printed on the page.

## What it does

- **A dossier, not a search box.** One sentence in, a structured, editable definition out: domain, what you care about (≤5), what you don't (≤5), and 5–8 search queries. Your original sentence is never rewritten by the model.
- **Weekly scan, almost zero LLM.** Every Monday cron runs each dossier's queries twice — sorted by stars *and* by recency, because star-ranking systematically hides exactly the new projects a weekly digest exists to surface. Filtering (archived / stale / license / too small) is a pure function over GitHub's own REST fields; the model never touches it. The model is asked exactly one question per scan — one batched call describing the shape of the ≤ 5 admitted repos — and it is a *description*, not a judgement: it decides nothing about who is in the list.
- **A ledger, not a claim of completeness.** The page states the whole funnel in numbers computed by code — queries sent (verbatim), repos returned, admitted, excluded, failed to fetch — next to a non-collapsible note that GitHub's search API caps every query at 1000 results, so this is provably not the whole field. Excluded repos are listed with their reasons, colour-split by whether a rule or the model excluded them, and you can appeal one back in.
- **Deep teardown on demand.** Click a row and it spends 60–120 seconds building two sections: how the project got here (history, pinned to changelog / HN / GitHub fields) and what's worth stealing from the source (takeaways, each pinned to quoted lines with a commit-pinned permalink). Streamed over SSE so you watch it happen.
- **A recheck, because dying is silent.** An archived repo gets filtered out by the rules, so it never reaches the candidate list — meaning "the project you were reading last week just got archived" would simply *vanish* from the list rather than be reported. So after each weekly scan the cron re-fetches `GET /repos` for every repo that was on **last week's** list, whether or not it is still on this week's, and reports three things: it got archived, it changed license, or it is gone (404). A 404 and a 503 are never merged into one column — the first is a death worth reporting, the second only means GitHub didn't answer, and the email says which is which and how many of each ("rechecked 5, 2 changed, 1 couldn't be reached").
- **A doorbell you can switch off — and back on.** Monday's email carries the list, the diff, and one link back to the web. The unsubscribe link in the email and the switch on the dossier screen write the *same row of the same table*, so the two can't drift. Unsubscribing kills the email only: the scan still runs weekly and the site still holds every list and every exclusion reason. Deleting your dossier deliberately does **not** clear the opt-out — otherwise "delete and rebuild" would become an accidental re-subscribe path.

## How it works

```text
Browser (React, src/react-app/)
   │
   ▼
Cloudflare Worker (Hono, src/worker/)  ── the whole product; no AWS compute
   ├─ path A  dossier edit      1 flash call        3–5 s
   ├─ path B  weekly scan       1 batched flash call  GitHub Search ×2 routes → REST → rules → ledger
   └─ path C  deep teardown     2 pro calls         SSE + 10 s heartbeat, 60–120 s
        │
        ▼
   Cloudflare D1 (TEARDOWN_DB) — dossiers, scans, candidates, exclusions, reports,
                                 inflight, quotas, daily spend, mail ledger, opt-outs,
                                 week-over-week changes, appeal ledger, candidate opens

Cron (Mon 08:00 UTC), serial, one shared GitHub rate budget:
   for each dossier ─► weekly scan ─► recheck last week's repos (≤10 × GET /repos)
                    ─► diff vs the previous week ─► **persist the diff** ─► SES v2 doorbell (once)
```

- **The week-over-week diff is written to D1 before the email goes out.** It used to
  exist only inside a letter that could fail to send, which meant one SES 403 threw away
  that week's conclusions — and left the site with no "look at last week" action at all,
  while cross-week state is the entire reason this is a site rather than a Claude Code skill.
  `GET /api/scan/changes?weekOf=…` reads back exactly what the email said; nothing
  recomputes the diff a second time.
- Opting out silences the **email**, nothing else: the scan runs, the recheck runs, and the
  diff is still recorded — you just stop getting mail. The unsubscribe switch and the
  one-click link in the footer write the same row.
- Three signals are being accumulated from day one because you cannot backfill history:
  each candidate's GitHub `topics`, a permanent appeal ledger (`scan_appeal`, which also
  makes a re-run restore the repos you pulled back in), and one row per teardown opened
  (`candidate_open`, written on a cache hit too — clicking the same repo again is the
  strongest demand signal there is).

- All AI calls go through the seam in `src/shared/ai.ts` (mock / deepseek / anthropic / gateway), physically copied from product 002. No credentials exist in this repo.
- Three independent budget gates, because the three paths differ by three orders of magnitude in cost: account quota, egress-IP quota, and a global **$3/day** spend fuse. Hitting the fuse returns 429 and says so on the page — printing the cost ceiling on the product's face is the most honest demo of finiteness there is.
- The only AWS dependency is SES for the doorbell email, called over plain HTTP with SigV4. No Lambda, no DynamoDB, no CDK stack. Without those credentials the cron prints the letter it would have sent and everything else keeps working.
- The cron is **serial on purpose**. GitHub's PAT bucket is per *account*, not per user, and one process going wide gets the whole site throttled — so all users in a run share one `RateState`, and a 403 stops the loop rather than earning a longer penalty window.

## Run it yourself

Requires Node.js ≥ 22.

```bash
npm install
npx wrangler d1 migrations apply nanisle-weekly-teardown --local   # create the tables
npm run dev        # http://localhost:5201 — mock AI, zero keys
```

The migration step is not optional: `--local` keeps its own SQLite file under `.wrangler/`, and without it every request that touches storage fails with `no such table`. Re-running it is safe — wrangler tracks which migrations have been applied.

Zero-config mode is stronger here than in 001/002: their `AI_PROVIDER=mock` replays a fixed sample, whereas here **everything except the wording is real**. Under `AI_PROVIDER=mock` and with no key of any kind:

- the weekly scan runs the real dual-route GitHub search, the real rule filter, the real `GET /repos` liveness gate and the real ledger arithmetic;
- a teardown resolves a **real commit SHA**, pulls the real release/HN timeline, fetches real source files from `raw.githubusercontent.com`, and runs the real anchoring — evidence that doesn't string-match back into the source is still dropped, and the anchored ratio is still computed;
- the Monday cron runs the real recheck against real GitHub;
- the *only* fabricated values are each candidate's one-line shape description and the teardown's takeaway sentences, both prefixed `[mock]` so nobody has to guess months later.

Verified end to end on 2026-09-01 on `wrangler dev --local` with no `.dev.vars` at all: `/api/health` reported `{"provider":"mock","hasPat":false,"hasDb":true}`; the scan returned 144 repos, admitted 5, excluded 139 and honestly recorded `stopped: "GitHub 配额要等 57 秒,超过这趟的预算"` (that is the anonymous tier working as designed, see below); the teardown pinned commit `91934f25`, read 5 real source files and reported `anchoredRatio: 1`.

Without `GITHUB_PAT` you're on the anonymous 60 requests/hour tier — and that tier caps searches at 10/minute, so **an anonymous manual run is normally truncated, not merely slow**: eight query terms × two sort routes needs ~112 s of backoff (measured), while `SCAN_BUDGET_MS` defaults to 75 s because the edge proxy cuts a byte-less response at ~100 s. The run then stops early and says so — `weekly_scan.stopped` carries the reason, the ledger's query count is the number of terms that actually came back, and the page shows a red notice above the honesty statement. That is the honest outcome, not a broken one; **but a production instance should set `GITHUB_PAT`**, which lifts the ceiling to 5000/hour (30 searches/minute) and lets a full run finish. `rate.waitedMs` in the response tells you how much of the wall clock went into backoff.

### Checking recall for real

The discovery layer's one make-or-break question is whether it finds what a human would. `npm run recall-check` answers it against a fixed benchmark — the five projects product 002 found by hand at kickoff — using a dossier built for that domain and hitting real GitHub:

```bash
npm run recall-check                      # anonymous tier; takes ~2 min with backoff
GITHUB_PAT=ghp_... npm run recall-check   # ~15 s
```

It is deliberately **not** part of `npm test`: it needs network access to GitHub, so it would be red on CI and on any fork, and a test that is always red is a test nobody runs. It *is* type-checked, though — `tsconfig.scripts.json` puts `scripts/` under `tsc -b` with Node's types, so the one script that decides whether the whole approach holds up can't quietly rot (before phase 9 it was the only code in the repo outside the type gate).

### Triggering the Monday cron locally

```bash
npx wrangler dev --local --test-scheduled
curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled?cron=0+8+*+*+1"
```

**Not `/__scheduled`.** This Worker serves assets, so that path is swallowed by the asset layer's SPA fallback and you get `index.html` with a 200 — it looks like it worked and the cron never ran. With no SES credentials configured the cron prints the entire email it *would* have sent into the log, so you can read Monday's letter without sending one.

Real AI with your own key: `cp .dev.vars.example .dev.vars`, then set

```ini
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-your-own-key
```

## Env vars

Full list with defaults in [`.dev.vars.example`](.dev.vars.example); types and "what happens if unset" in [`src/worker/env.ts`](src/worker/env.ts). Secrets are never files — `wrangler secret put <NAME>` for a hosted instance, `.dev.vars` (gitignored) locally.

| Var | Required? | Unset means |
|---|---|---|
| `AI_PROVIDER` / `AI_MODEL` / `FAST_AI_MODEL` / `AI_MAX_OUTPUT_TOKENS` | no | `mock`, zero keys |
| `DEEPSEEK_API_KEY` | for real AI | falls back to mock automatically |
| `GITHUB_PAT` | no | anonymous 60 req/h — **still real network, real data** |
| `SCAN_BUDGET_MS` | no | 75 s wall-clock budget for one scan; on expiry it stops early and says so in `stopped` |
| `REPORT_BUDGET_MS` / `REPORT_PING_MS` | no | 180 s budget per teardown; 10 s SSE heartbeat. The heartbeat knob exists only so a test can prove the heartbeat still fires — an unverified heartbeat looks exactly like no heartbeat |
| `ACCESS_CODE` | hosted | diagnostic endpoints (`/api/__spike`) are open |
| `NANISLE_SSO_SECRET` | hosted | no login gate; everything runs as `DEV_EMAIL` (default `dev@local`) |
| `EMAIL_UNSUB_SECRET` + `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | no doorbell email; everything else works |
| `AI_DISABLED=1` | no | kill switch — token-spending endpoints return 503, the rest stays up |
| `CRON_SCAN_BUDGET_MS` / `CRON_BUDGET_MS` | no | 5 min per user, 13 min per cron run; users not reached are counted, not silently cut |
| `DRAFT_BUDGET_MS` | no | 45 s for one "one sentence → dossier" call, retries included |
| `GITHUB_API_BASE` | **tests only** | points the whole GitHub side (API + raw + web) at a fake server; misconfiguring it in production would silently swap the data source, so `env.ts` validates it and falls back to the real api.github.com with an error log |
| `EMAIL_FROM` / `AWS_REGION` | no | `teardown@nanisle.com`, `us-east-1` |
| `APP_URL` / `NANISLE_URL` | hosted | `https://nanisle.com/products/weekly-teardown` and `https://nanisle.com`. `APP_URL` is what the doorbell email's links are built from — get it wrong and the mail still sends, it just doesn't lead anywhere |
| `OWNER_AI_*` | no | no owner lane; every account uses the same provider |
| `FAST_AI_PROVIDER` | no | the light tier uses the same provider as the judging tier |
| `ANTHROPIC_API_KEY` / `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` | only for `AI_PROVIDER=anthropic` / `gateway` | unused on the default path |
| `DEV_EMAIL` | no | `dev@local`; read only when `NANISLE_SSO_SECRET` is unset |

That table is a summary; the authority is `.dev.vars.example`, and `npm test` has a case that reads **both** `src/worker/env.ts` and `.dev.vars.example` and fails if either one lists a variable the other doesn't. A missing env var doesn't throw — it just leaves a forker unable to discover a switch exists — so it needed a test rather than a habit.

## Deploy

**Not deployed yet** — phase 10. When it is: `wrangler d1 create nanisle-weekly-teardown` first and paste the returned id into `wrangler.jsonc` (the id checked in belongs to this project's own database; a fork's deploy will fail with "database not found" until you replace it — failing beats silently connecting to someone else's database). Then create the tables on the remote database with `wrangler d1 migrations apply nanisle-weekly-teardown --remote`, run `npm run deploy`, and set the secrets above with `wrangler secret put`.

## What I learned

Not published yet — this section gets written after the first real week of use. Two things are already worth writing down, though, and both are the same shape:

- **The thing this product exists to report was invisible to its own logic.** The rule layer filters out archived repos, which is correct — you don't want dead projects in a list of candidates. But it meant a repo that died *between two weeks* simply disappeared from the list instead of being reported, and a disappearance reads identically to "it slipped below the top 5". The product's stated fear (docs/01, risk 1: *being wrong quietly*) turned out to describe our own code first. The fix is the recheck, and the reason it works is that it doesn't ask "is this repo still on the list" — it asks GitHub directly.
- **Every honest count needs a denominator that survives failure.** The recheck reports "checked N, M changed, K unreachable", and N is deliberately *how many we should have checked*, not how many answered. With the other definition, the week GitHub is down prints "checked 0, 0 changed" — literally true, and it reads as "all clear".
