# Architecture

Status: **as built through Phase 36 (USDC lane), deployed on Render (Phase 32, D-062); audited in Phase 35 (D-065).**

- Built components are marked **built**, with the evidence that proves them; the rest show their
  planned phase.
- Spike results and pivots: [`checkpoint.md`](checkpoint.md).

## One task through three ecosystems

```
                         ┌──────────────── Browser (Vite/React :5173) ───────────────┐
                         │ Task composer · Policy · Live timeline · Evidence panels  │
                         │ [localhost only] Privy 0G login → holder credit balance  │
                         └───────────────┬───────────────────────────────────────────┘
                                         │ HTTPS (REST + SSE), demo access code
┌────────────────────────────────────────▼──────────────────────────────────────────┐
│ apps/server (Node/TS)                                                              │
│  API ─► Orchestrator ─► Discovery(ENS) ─► Planner/Selector(0G) ─► FIREWALL ─►      │
│        x402 Client ─► Settlement Verifier(Mirror Node) ─► Fetch(net-guard) ─►      │
│        Analyst/Reporter(0G) ─► Store(SQLite) ─► [P1] HCS audit                     │
│  Scheduler (daily after 00:00 UTC) ─► Orchestrator                                 │
└───────┬───────────────────┬──────────────────────┬──────────────────────┬─────────┘
        │ eth_call/getLogs  │ OpenAI-compatible    │ x402 HTTP            │ REST
        ▼                   ▼                      ▼                      ▼
  Sepolia ENSv2      0G Router (Private      apps/providers (x402)   Hedera Mirror Node
  Universal Resolver  Computer, TEE)         payTo = ENS-declared ──► Facilitator ──► Hedera testnet
  chirag126.eth  ✔    testnet ✔ (deposit)    Hedera account           (Blocky402 ✔ / x402.org)
  subregistry ✔       mainnet: credits       kev ping route ✔
  kev.chirag126.eth ✔ pending (G1)
```

1. **Plan (0G):** task + watchlist → required capabilities.
2. **Discover (ENSv2):** labels from our subregistry's `LabelRegistered` logs; status, resolver and
   records via the Universal Resolver, all at one pinned block (**built**, Phase 13, D-035).
3. **Select (0G):** candidate records (as delimited untrusted data) → ranked choice + rationale.
4. **Authorise (firewall):** deterministic checks; the model cannot override them.
5. **Pay (x402 → Hedera):** 402 quote → signed TransferTransaction → facilitator verify/settle.
6. **Verify (Mirror Node):** status `SUCCESS`, correct payee and amount → `SETTLED`.
7. **Fetch:** paid data through the SSRF-safe client with size and time limits. Providers answer
   one normalised `IntelResponse` shape and never settle on failure (**built**, Phase 14).
8. **Analyse and report (0G):** findings → brief; all evidence persisted and shown.

## Components

| Component            | Responsibility                                                                                                                                                                                                                                                                                 | Status / phase                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/core`      | Env spec and validation; zod domain model (`./domain`)                                                                                                                                                                                                                                         | **built** (Phase 9)                                                       |
| `packages/hedera`    | Mirror Node client, facilitator discovery, payment guard, settlement verification, **x402 client and shared server module** (`x402-server.ts`, D-037)                                                                                                                                          | **built**, verified on Hedera testnet (H1); state machine 18–20           |
| `packages/zg`        | 0G Router client (plain `fetch`, no retries), cost/balance checks, credit-vs-deposit funding, structured JSON outputs (D-038), daily-cap accounting and usage parsing (D-040)                                                                                                                  | **built**, verified on 0G testnet                                         |
| `packages/ens`       | ENSv2 constants and ABIs (from the deployed source), registration, subname and provisioning planners, agent record schema and manifest                                                                                                                                                         | **built**, verified on Sepolia (E1); discovery and permission proof 12–13 |
| `apps/providers`     | x402-protected threat-intel services: KEV, NVD CVE, OSV (D-036)                                                                                                                                                                                                                                | **built** (Phase 14)                                                      |
| `apps/holder-probe`  | Privy holder-lane probe, localhost:5173, read-only                                                                                                                                                                                                                                             | **built**; real test needs 0G's app ID                                    |
| `packages/policy`    | Spending firewall: pure `authorize()`, quote bound to ENS records, run/day budgets, 24 reason codes (D-041)                                                                                                                                                                                    | **built** (Phase 18)                                                      |
| `packages/net-guard` | SSRF-safe fetch: https only, every resolved address public, socket pinned, no redirects, time and byte caps (D-045)                                                                                                                                                                            | **built** (Phase 22)                                                      |
| `apps/server`        | Fail-fast config and SQLite persistence (Phase 9); inference ledger (Phase 17, D-040); payment state machine, buyer, verifier (19–21); **orchestrator** with append-only run events (Phase 23, D-046); API and the daily-brief scheduler (D-056)                                               | **built** (scheduler: Phase 27, live runs pending)                        |
| `apps/web`           | Web app (Vite + React 19): control-center overview, task composer and budget, live trail with proofs, runs judged by the server apart from development evidence, activity log, providers with ENS proof, payments, 0G ledger, editable spending rules with a kill switch (D-051, D-052, D-053) | **built** (Phase 26)                                                      |

## Cross-system decisions

- **ENS ↔ Hedera identity.** No trustless cross-chain identity is claimed. Each agent's resolver
  publishes its Hedera payout account. The firewall rejects any x402 quote whose `payTo`,
  network or asset differs from the ENS records. What is cryptographic: who can write those
  records (ENSv2 Enhanced Access Control) and the signed Hedera transfer. What is application
  level: the claim that the endpoint's server belongs to the record holder. The payTo binding
  means an impostor server cannot redirect funds.
- **Per-agent Permissioned Resolver.** ENSv2 resolver roles are scoped per resolver, not per name,
  so each agent gets its own resolver instance. An operator can edit only its own agent's
  delegated keys. Payout keys stay admin-only. `pnpm ens:provision` (D-033) grants each agent's
  operator `ROLE_SET_TEXT` per delegated key with `grantSetterRoles`, and revokes anything more.
  `pnpm ens:permissions` (D-034) proves it on Sepolia with mined transactions and reverts.
- **Provisioning is declarative and chain-derived.** The agent manifest
  (`packages/ens/src/agents.ts`) plus env (`HEDERA_PROVIDER_ACCOUNTS`, `X402_*`,
  `ENS_AGENT_ENDPOINT_BASE`) define the desired state; predicted proxy addresses, role reads and
  record reads define the current state. The verified result is committed as
  `deployments/sepolia.json` (no timestamps, so a rerun leaves it unchanged).
- **Discovery without hard-coding.** ENSv2 cannot enumerate names on-chain, so we index the events
  of our own subregistry (a single contract) and resolve each label at runtime
  (`packages/ens/src/discovery.ts` over a `DiscoveryChain` interface; viem adapter in
  `discovery-viem.ts`). The only input is the parent name.
- **0G credits vs Hedera payments.** Separate ledgers, separate caps, shown separately.
- **Every 0G call is a ledger row first (D-040).** `ledgeredStructuredCall` checks the per-call
  cap, then reserves the worst case under the daily cap (PENDING row), sends one call, and settles
  the row from the Router's own billing. Unknown outcomes stay counted at the worst case. The
  Router's usage history (the dashboard's Usage page) is the reconciliation source; balance
  snapshots are evidence only (the Router balance is a float, D-039).
- **0G funding is labelled, never assumed.** Every inference records the Router's own
  `credit_used` / `deposit_used` split. "Credit-funded" is shown only when `credit_used > 0`.
  Until team or iAI credits exist, development runs on 0G testnet, deposit-funded, and says so
  (checkpoint pivot).
- **Settlement and resolution are always re-read independently.** Hedera payments count as
  settled only from the Mirror Node. ENS records count as set only from the Universal Resolver
  (viem `getEnsText`). Never trust a write's own return value.
- **Chain writes are planned, simulated and resumable.** Every on-chain workflow (ENS today, the
  payment state machine later) uses:
  - a pure planner over live facts
  - simulation before sending
  - transaction hashes saved as soon as they are sent
- **Privy localhost constraint.** The public deployment uses the server-side agent lane (API key
  funded by team credits). The holder lane (Privy sign-in) runs only on localhost:5173.

## Deployment (Phase 32, D-062)

Render's **free plan**, two web services (`render.yaml`, guide in [`deployment.md`](deployment.md)):

- `threat-intel-agent` (`https://threat-intel-agent-czg2.onrender.com`): the API, the scheduler and
  the built web app on one origin, under an app CSP.
- `threat-intel-providers` (`https://threat-intel-providers.onrender.com`): kev, cve and osv. The
  ENS records point here; the service refuses to start if its prices or payees differ from ENS.

There is **no disk and no Postgres** (this replaces D-031's plan): SQLite is wiped on every
restart or sleep. What keeps that safe:

- today's spend is re-read from the Mirror Node before every run, fail closed (`SPEND_UNVERIFIED`);
- `X402_PAYMENTS_PAUSED` is a pause no restart can lift;
- the daily brief is recreated from `DAILY_BRIEF_*` at start, with a 120-minute catch-up window;
- proof never depends on the database: payments are on Hedera and run digests on the HCS topic.

Secrets are entered in Render's dashboard (`sync: false`). The ENS admin key and the 0G management
key are never deployed. The 0G holder lane (Privy) stays localhost-only.

## Provider service startup (built, Phase 15)

```
pnpm providers:start
  1. facilitators from env  ── probe /supported: primary, then fallback ──► bound = first that supports exact on hedera:testnet
  2. live ENS records        ── discovery at one block ──► compare price · payTo · network · asset · endpoint per agent
                                                            any difference ──► EnsMismatchError, exit before listening
  3. createPaymentLayer + resourceServer.initialize()  ──► listen on 127.0.0.1:<PROVIDERS_PORT>
```

## Inference ledger (built, Phase 17)

```
ledgeredStructuredCall
  1. plan     catalog price + per-call cap + JSON capability ── fail ──► REFUSED row (nothing sent)
  2. reserve  BEGIN IMMEDIATE: spent today (UTC) + worst case ≤ daily cap ── fail ──► REFUSED row
              else PENDING row holding the worst case
  3. call     one chat completion, never retried
  4. settle   SUCCEEDED (billed, valid) · FAILED (billed invalid / Router error, unbilled) · UNKNOWN

pnpm ledger:reconcile   usage history (≤50 entries) ⇄ rows by request ID: cost, tokens, provider, model
pnpm ledger:snapshot    /account/balance → zg_balance_snapshots (job: every ZG_SNAPSHOT_INTERVAL_MIN)
```

## Spending firewall (built, Phase 18)

```
authorize({ intent, quote, requestUrl, providers, snapshot, state, policy, now })   pure, no I/O
  policy valid?                       ── no ──► POLICY_INVALID
  intent = strict {provider, capability, rationale}   (model output; extra keys refused, rationale never read)
  snapshot fresh? provider in ENS snapshot?           ── SNAPSHOT_STALE / PROVIDER_UNKNOWN
  then every rule, all violations collected:
    lists · capability published · URL under ENS endpoint
    quote == ENS: price · payTo · network · asset · scheme exact · fee payer not a party
    budgets: duplicate · payments/run · per payment · run committed · day committed
  ──► ALLOW {amount, committed after}  or  DENY {code = first by priority, violations[]}
```

## Payment state machine (built, Phase 19)

```
open (idempotency key)        CREATED ──firewall──► AUTHORIZED ──record tx ID──► SIGNED ──before sending──► SUBMITTED
                                 └──────────────► REFUSED (reason code)              │                         │
                              AUTHORIZED/SIGNED ──never sent──► FAILED               ▼                         ▼
                              SUBMITTED/UNKNOWN ──Mirror Node──► SETTLED | FAILED   (no re-sign: tx ID immutable,
                              no verdict in time ──► UNKNOWN (counted as spent;      UNKNOWN → SIGNED refused in
                                                    reconciled, never retried)       code and database)
```

## Autonomous x402 buyer (built, Phase 20)

```
buyWithFirewall(intent from the model, url)
  GET url ──402──► decode requirements ──► open intent (idempotent: existing ⇒ return, never re-pay)
  authorize(intent, THIS quote, ENS snapshot, persisted spend) ── deny ──► REFUSED (code), nothing signed
  sign exactly that requirement (hook refuses any other; x402 cap; payment guard with ENS payees)
  persist tx ID (SIGNED) ─► persist SUBMITTED ─► GET url + PAYMENT-SIGNATURE
  Mirror Node (≤45 s): match ⇒ SETTLED · failed/expired ⇒ FAILED · none/mismatch ⇒ UNKNOWN (reconciled later)
```

## Settlement verifier (built, Phase 21)

```
SettlementVerifier (Mirror Node only; facilitator "success" and HTTP 200 never consulted)
  awaitSettlement   poll ≤45 s ─► reconcile ─► SETTLED | FAILED | else UNKNOWN (never retried)
  reconcileOpen     every SUBMITTED / UNKNOWN once
  audit             every SETTLED re-read now; confirmed or reported (never un-settled)
checks: network · HBAR · exact tx ID (all entries) · SUCCESS · CRYPTOTRANSFER · no token transfers
        · payee +amount exactly · payer −amount exactly · consensus ≥ valid start
every reading ─► settlement_verifications (append-only); DB trigger: SETTLED needs a SETTLED
verification of the payment's own transaction ID
```

## Net-guard (built, Phase 22)

```
guardedRequest(url)                          used by the buyer (ENS URLs) and the provider feeds
  URL: https only (http → loopback only in dev mode) · no user:pass · port 443
  DNS: resolve once (time-capped) → EVERY address public (classifyIp, incl. IPv4 inside IPv6)
  connect to the checked address (custom lookup; TLS/SNI/Host = hostname)  ← rebinding-proof
  3xx → REDIRECT_REFUSED · total time cap · byte cap (Content-Length and streamed)
```

## Orchestrator (built, Phase 23)

```
queue(watchlist) → execute(run)                                   every arrow appends a run event
  discover (ENS, pinned block) ─► PROVIDERS_DISCOVERED
  GET <endpoint> per provider (net-guard, 64 KiB) ─► checked against ENS ─► CATALOG_READ
  0G PLAN (ledger) ─► PurchasePlan (untrusted) ─► INFERENCE_CALLED, PLAN_CREATED
  per purchase: URL from the catalog (not the model) ─► buyer: 402 → firewall → sign →
      tx ID persisted → send → Mirror Node ─► PAYMENT_* ; data only if SETTLED + schema ─► DATA_*
  0G ANALYZE on ≤30 deduplicated items (ledger) ─► IDs must be the given ones ─► ANALYSIS_COMPLETED
  report from recorded data (model output labelled) ─► REPORT_WRITTEN ─► RUN_FINISHED | RUN_FAILED
```

The database refuses event edits, deletes, sequence gaps, events on a finished run, and illegal run
transitions (migration 5). `recoverInterrupted()` closes crashed runs and leaves payments to the
Mirror Node reconciler.

## Live end-to-end run (built, Phase 24)

`pnpm agent:run` is the production wiring of the orchestrator:

- viem discovery on Sepolia (pinned block);
- the Hedera signer, with the payee allowlist set to the ENS payees;
- the net-guard fetch;
- the Mirror Node verifier;
- the 0G Router through the ledger.

The analysis prompt is sized from the live model price so that the call fits
`ZG_MAX_CALL_COST_NEURON`. A run counts as verified only when `agentRunChecks` passes on the stored
records (D-047).

## API and live event stream (built, Phase 25)

```
browser / script ──HTTP──► node:http API (apps/server/src/api)          public reads, rate limited
  POST /api/session {code} → HttpOnly cookie │ POST /api/tasks needs the code (bearer or cookie)
  POST /api/tasks ─► TaskRunner (one at a time, ≤3 waiting) ─► Orchestrator (wiring.ts: live)
  POST /api/voice (audio) ─► VoiceService ─► 0G /audio/transcriptions (ledgered TRANSCRIBE call)
       └─ text back to the form; POST /api/tasks {voiceCallId} attaches the call to the run (D-076)
  GET /api/tasks/:id/stream ◄── SSE: polls run_events, id = seq, replay from Last-Event-ID, `end`
  GET /api/tasks/:id · /events · /report · /api/providers · /api/evidence[/track/file]
```

Limits per client: 120 requests a minute, 5 tasks an hour, 20 voice clips an hour, 10 wrong codes
per 15 minutes, 4 streams. The client address comes from the socket, or from `X-Forwarded-For` behind
`API_TRUST_PROXY_HOPS` trusted proxies. The planner's advisory IDs must be grounded in the
watchlist or in data already bought (D-049).

## Web app (built, Phase 26)

```
browser ── /api (same origin; Vite proxy in dev) ──► agent API
  Overview · New task · Task (live trail: step │ proof) · Providers · Payments · 0G usage ·
  Spending rules · Evidence
  status labels ◄── GET /api/evidence (explicit result flags; never asserted by the UI)
  live trail    ◄── GET /api/tasks/:id/events, then SSE /stream?after=N (resumes by event ID)
```
