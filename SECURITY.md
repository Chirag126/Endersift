# Security

This application makes autonomous payments, so it is treated as a financial system.

## Secrets

| Secret                     | Where it may live                                     | Never                        |
| -------------------------- | ----------------------------------------------------- | ---------------------------- |
| `HEDERA_PAYER_PRIVATE_KEY` | Local `.env`; server host secret store                | Browser bundle, logs, Git    |
| `ZG_API_KEY`               | Local `.env`; server host secret store                | Browser bundle, logs, Git    |
| `ZG_MANAGEMENT_KEY`        | Local `.env` on the operator's machine                | **Any deployed environment** |
| `ETH_RPC_URL`              | Local `.env`; server host secret store                | Browser bundle, logs, Git    |
| `ENS_ADMIN_PRIVATE_KEY`    | Local `.env` on the operator's machine                | **Any deployed environment** |
| ENS commitment secret      | `.secrets/ens-registration-*.json` (gitignored, 0600) | Git, logs, evidence          |
| `DEMO_ACCESS_CODE`         | Local `.env`; server host secret store                | Git                          |

Enforced by:

- `ENV_SPEC` rules checked in CI: secrets must be blank in `.env.example`, must not have
  defaults, and must never use the browser-exposed `VITE_` prefix.
- Pre-commit hook (`pnpm secrets:scan:staged`) that blocks staged secrets, cross-platform.
- gitleaks over the full git history in CI, with project-specific rules (Hedera DER keys, `sk-`/`mk-` 0G keys, JWTs, RPC URLs).
- GitHub secret scanning with push protection: not available while the repository is private;
  the owner enables both when it is made public (`docs/security-checklist.md`).
- Env validation errors print variable names and reasons only, never values.

**If a secret is ever committed or pushed:** rotate it immediately (new Hedera key / new 0G key /
new RPC key). Rewriting history is not sufficient on its own.

## Payment safety

- A deterministic spending firewall authorises every payment. Model output can only recommend.
- The payee in an x402 quote must match the Hedera account published in the provider's ENS
  records, and the network and asset must match configuration.
- Per-task budget, per-provider cap, per-transaction maximum and an ENS-namespace allowlist apply.
- Idempotency keys prevent duplicate payments. A payment in an unknown state is reconciled on the
  Mirror Node by its transaction ID. It is never blindly re-signed.
- Settlement is accepted only after Mirror Node confirmation, never on HTTP 200 alone.

## Untrusted input

ENS records, provider responses and model output are untrusted. Endpoints are fetched over https
only, with private/loopback/metadata IP ranges blocked, DNS pinning, no redirects, and size and
time limits. Provider content is passed to the model as delimited data, never as instructions.

## API boundary (D-053, D-054, D-060)

- Text that came from outside (events, errors, payment URLs, provider records, the brief) is
  redacted on the way out; the server's console is redacted too.
- Every response carries `nosniff`, `no-store` and a deny-all CSP. Errors never echo input.
- CORS allows one configured origin. Cross-site POST, PUT and DELETE requests are refused before any
  handler runs.

Deployed on Render (D-062): secrets are entered in the Render dashboard (`sync: false` in
`render.yaml`, checked in CI), the web app shares the API's origin under a strict CSP, and
`X402_PAYMENTS_PAUSED=true` stops every payment regardless of the database.

The full list, with the test for each item and the latest audit results, is in
[`docs/security-checklist.md`](docs/security-checklist.md).

## Reporting

Open a private security advisory on the GitHub repository.
