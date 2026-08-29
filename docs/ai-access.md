# AI access: how products call models without leaking tokens

Products in this repo are AI-powered, are open source, and their hosted demos run on the owner's AI subscription. Those three facts conflict unless the boundary is explicit. This doc is that boundary.

## The rule

**The repo knows *how* to talk to a model. It never knows *as whom*.**

Credentials (API keys, subscription OAuth tokens, gateway virtual keys) exist only in:

- `.dev.vars` on a developer's machine (gitignored), or
- Worker secrets set with `wrangler secret put`, or
- the private platform repo (the gateway that actually holds the owner's tokens).

See [SECURITY.md](../SECURITY.md) for the full list of things that must never be committed.

## Three run modes

Every product's AI calls go through one seam: `src/worker/ai.ts`. The mode is picked by env var — same code, three audiences:

| Mode | `AI_PROVIDER` | Who it's for | Credentials |
|---|---|---|---|
| **Mock** | `mock` (default) | Anyone cloning the repo; CI; UI development | None. Returns canned responses. |
| **BYOK** | `anthropic` | Forkers who want real AI on their own dime | `ANTHROPIC_API_KEY` — *your* key, from [platform.claude.com](https://platform.claude.com) |
| **Gateway** | `gateway` | The hosted demos on nanisle.com; anyone running their own proxy | `AI_GATEWAY_URL` + `AI_GATEWAY_KEY` |

### Env var matrix

| Var | Secret? | Default | Meaning |
|---|---|---|---|
| `AI_PROVIDER` | no | `mock` | `mock` \| `anthropic` \| `gateway` |
| `AI_MODEL` | no | `claude-opus-5` | Model ID passed on every request |
| `AI_MAX_OUTPUT_TOKENS` | no | `1024` | Hard per-request output cap (cost guard; raise per product if needed) |
| `AI_DISABLED` | no | unset | `1` = all AI endpoints return 503 (kill switch — flip and redeploy) |
| `ACCESS_CODE` | **yes** | unset | Comma-separated codes; when set, AI endpoints require header `x-access-code` |
| `ANTHROPIC_API_KEY` | **yes** | — | BYOK mode only |
| `AI_GATEWAY_URL` | no* | — | Base URL of an Anthropic-compatible endpoint (*kept out of the repo anyway to avoid targeting) |
| `AI_GATEWAY_KEY` | **yes** | — | Virtual key issued by the gateway; sent as `Authorization: Bearer` |

## The gateway contract

Gateway mode assumes nothing more than an **Anthropic-compatible Messages API**: `POST {AI_GATEWAY_URL}/v1/messages` accepting a Bearer token. That means:

- Forkers can point products at [LiteLLM Proxy](https://docs.litellm.ai/docs/proxy/virtual_keys), a Cloudflare AI Gateway, or their own shim — no code changes.
- The owner's actual gateway implementation lives in the **private platform repo** and is intentionally not described here beyond its interface.

## Anti-abuse design (why demos don't get farmed)

The threat model: a public demo whose backend spends the owner's tokens will be scripted and drained ("灰产刷 token"). Defenses live in two layers:

**Layer 1 — in every product (this repo, `src/worker/guard.ts`):**

- `ACCESS_CODE` gate on AI endpoints. A hosted instance is never exposed without one — the same rule the LobeChat/open-webui ecosystem converged on for "hosted app + owner's key" deployments.
- `AI_MAX_OUTPUT_TOKENS` caps every response.
- `AI_DISABLED` kill switch for incident response.
- No raw model errors or system prompts are echoed to clients.

**Layer 2 — at the private gateway (one place, covers all products):**

- One **virtual key per product**, so a leaked key is revoked without touching others.
- **Per-key budget** (daily/monthly spend ceiling) and **per-key RPM/TPM rate limits** — requests beyond them fail closed.
- Model allowlist (a stolen key can't call a pricier model).
- Request logging per key, so abuse is attributable and measurable.

Product code stays simple because the expensive controls are centralized at the gateway; the gateway stays private because that's where identity and money live. If you fork a product and host it publicly with your own key, replicate at least Layer 1 (`ACCESS_CODE`) — it's already built in; just set the secret.

## Owner lane (private subscription gateway)

The hosted instance can route **a fixed list of accounts** (in practice: the owner) to a different provider while everyone else stays on the default. It is configured entirely at deploy time — there is no UI for it — via `OWNER_AI_EMAILS`, `OWNER_AI_PROVIDER`, `OWNER_AI_MODEL`, `OWNER_FAST_AI_MODEL`, `OWNER_AI_GATEWAY_URL`, `OWNER_AI_GATEWAY_KEY` (all optional; unset `OWNER_AI_EMAILS` = no lane). Requests on the lane keep the default config as a fallback, so a broken lane degrades to the default provider instead of failing the user.

The owner's lane points at a gateway that fronts a headless official **Claude Code CLI** running with the owner's own `claude setup-token`; that gateway lives in the private platform repo. Two rules follow from Anthropic's 2026 policy on subscription OAuth tokens (server-side enforced since 2026-01-09, documented 2026-02-19):

- A Claude subscription OAuth token (`sk-ant-oat…`) **must not** be used by this repo's code directly (SDK, Agent SDK, or raw HTTP). The `anthropic` mode only accepts an API key.
- Only the official Claude Code client may spend subscription quota, and only for its owner. Do not build a "paste your setup token" feature for other users.
