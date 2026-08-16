# Security Policy

## No secrets in this repository — ever

This repository is public. The following must never be committed, in any file, in any commit:

- API keys (`sk-ant-...`, OpenAI keys, etc.)
- OAuth tokens or session tokens of any kind (including Claude Code / Codex subscription tokens)
- Gateway virtual keys (`AI_GATEWAY_KEY` values)
- Access codes used by hosted demos
- Customer data, email lists, analytics exports
- Deploy credentials (`wrangler` OAuth state, cloud provider credentials)

All of the above live outside the repo:

| Where | What |
|---|---|
| `.dev.vars` (gitignored) | Local development secrets |
| `wrangler secret put` | Production secrets for deployed Workers |
| The private platform repo | Gateway implementation, budgets, key issuance, analytics |

Every product ships a `.dev.vars.example` with placeholder values only. The root `.gitignore` blocks `.env*` and `.dev.vars*` as a safety net, but treat that as the last line of defense, not the first.

## If a secret leaks

1. Revoke/rotate the credential immediately (rotation beats history-rewriting — assume anything pushed to a public repo has already been scraped).
2. Then clean the git history (`git filter-repo`) and force-push.
3. If it was a gateway virtual key, also check the gateway's spend logs for abuse.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting ("Report a vulnerability" under the Security tab) instead of opening a public issue. Reports about token exposure or abuse of hosted demos are especially welcome.
