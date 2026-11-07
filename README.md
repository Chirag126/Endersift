# Endersift

**An autonomous threat-intelligence agent that finds its data sellers on ENS, pays them with x402
on Hedera, and thinks on 0G Private Computer.**

You give Endersift a watchlist (the software you run, for example `OpenSSL` or
`lodash@4.17.21 (npm)`) and a budget. It finds paid security-data providers on ENS, decides with
0G what is worth buying, pays each provider per request in HBAR within your limits, checks every
payment on Hedera, and writes a brief: what to fix today, what can wait, and what changed since
the last brief.

|                    |                                                                                |
| ------------------ | ------------------------------------------------------------------------------ |
| **Live app**       | https://endersift.onrender.com                                                 |
| **x402 providers** | https://endersift-providers.onrender.com (`/health`)                           |
| **Networks**       | Hedera **testnet** · ENSv2 on **Sepolia** · 0G Private Computer on **mainnet** |
| **Licence**        | MIT                                                                            |

> The services run on Render's free plan and sleep when idle. Open the app and wait about a
> minute for **"Provider host ready"** in the top bar before starting a task.

---

## Contents

1. [What happens in one task](#what-happens-in-one-task)
2. [Architecture](#architecture)
3. [The payment flow (x402 on Hedera)](#the-payment-flow-x402-on-hedera)
4. [Hedera](#hedera)
5. [ENS](#ens)
6. [0G](#0g)
7. [Proof of a live run](#proof-of-a-live-run)
8. [Setup](#setup)
9. [Deploy on Render](#deploy-on-render)
10. [Repository layout](#repository-layout)
11. [Security](#security)
12. [Known limits](#known-limits)

---

## What happens in one task

1. **Discover (ENS).** The agent reads the subnames of `chirag126.eth` on Sepolia. Each provider
   (`kev`, `cve`, `osv`) publishes its endpoint, capabilities, price and Hedera payout account as
   ENS text records. Nothing about a provider is hard-coded.
2. **Plan (0G).** A model on 0G Private Computer reads the watchlist and each provider's catalog,
   and proposes what to buy within the budget.
3. **Authorise (spending firewall).** Plain code, never the model, checks every quote against the
   provider's ENS records and the per-payment, per-task and per-day limits.
4. **Pay (x402 on Hedera).** The agent pays each approved request with a signed HBAR transfer,
   settled through the Blocky402 facilitator.
5. **Verify (Hedera Mirror Node).** Data is used only after the Mirror Node shows the exact
   transaction with the right payee and amount.
6. **Analyse (0G).** 0G ranks the purchased advisories (P1 fix today, P2 this week, P3 watch).
7. **Brief and audit.** The brief cites every Hedera transaction ID and 0G request ID; each
   settlement and a task digest are posted to a Hedera Consensus Service topic.

A daily scheduled brief compares itself with the previous one, so there is always a reason to
come back tomorrow.

---

## Architecture

```
 Browser ──► endersift (agent: API · web app · scheduler · SQLite) ───────────────────────────┐
                │                                                                             │
   1 discover   ├──► Sepolia ENSv2: subregistry logs → Universal Resolver → agent records     │
   2 plan       ├──► 0G Router (Private Computer, TEE) ── model proposes purchases            │
   3 authorise  ├──► spending firewall (plain code): quote must equal ENS records + budgets   │
   4 pay        ├──► endersift-providers ── HTTP 402 quote                                    │
                │      signed HBAR transfer ──► Blocky402 facilitator ──► Hedera testnet      │
   5 verify     ├──► Hedera Mirror Node: exact tx, SUCCESS, payee and amount                  │
   6 analyse    ├──► 0G Router ── priorities P1 / P2 / P3 on the purchased advisories         │
   7 brief      └──► brief citing every tx ID and 0G request ID; messages to the HCS topic ◄──┘
```

| Part                                                                       | Code              | Runs on                      |
| -------------------------------------------------------------------------- | ----------------- | ---------------------------- |
| Agent: orchestrator, payments, inference ledger, scheduler, HCS audit, API | `apps/server`     | Render `endersift`           |
| Web app (three themes: Classic, Electric, EnderPay)                        | `apps/web`        | Served by the agent          |
| x402 sellers `kev` (CISA KEV), `cve` (NVD), `osv` (OSV.dev)                | `apps/providers`  | Render `endersift-providers` |
| ENS discovery, records, provisioning, permissions, ERC-8004                | `packages/ens`    | Sepolia                      |
| x402 client and server, Mirror Node checks, HCS                            | `packages/hedera` | Hedera testnet               |
| 0G Router client: catalog, structured output, cost caps                    | `packages/zg`     | 0G mainnet                   |
| Spending firewall                                                          | `packages/policy` | Inside the agent             |

More detail: [`docs/architecture.md`](docs/architecture.md).

---

## The payment flow (x402 on Hedera)

1. The agent requests a provider endpoint it found on ENS, for example
   `https://endersift-providers.onrender.com/v1/osv/query?...`.
2. The provider answers **HTTP 402 Payment Required** with an x402 quote: scheme `exact`, network
   `hedera:testnet`, asset `0.0.0` (HBAR), the amount in tinybars, `payTo`, and the facilitator's
   fee payer.
3. The **firewall** compares the quote with that provider's ENS records (`agent.price`,
   `x402.payTo`, `x402.network`, `x402.asset`, `agent.endpoint`) and with the budgets. Any
   difference is refused with a reason code before anything is signed.
4. The agent signs a Hedera transfer for exactly that amount. The **transaction ID is saved before
   sending**, so a crash can never pay twice.
5. The request is repeated with the signed payment. **Blocky402** verifies it, submits it to Hedera
   and pays the network fee; the provider returns the data.
6. The payment counts as **settled only when the Mirror Node shows** that exact transaction with
   `SUCCESS`, the payee credited and the payer debited the quoted amount. No answer in time means
   `UNKNOWN`: counted as spent, never paid again, reconciled later.

Try step 2 yourself (free, nothing is paid):

```cmd
curl -i https://endersift-providers.onrender.com/v1/kev/recent
```

---

## Hedera

**What Endersift uses:** x402 payments in HBAR, settled through **Blocky402** (a facilitator listed
in the Hedera docs); the **Mirror Node** to verify every settlement; and the **Hedera Consensus
Service** as a public audit trail.

### Settled x402 payment (requirement: an x402 endpoint settling on Hedera)

|                    |                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Endpoint           | `https://endersift-providers.onrender.com/v1/kev/ping` (x402-protected)                                                    |
| Facilitator        | Blocky402, `https://api.testnet.blocky402.com` (fee payer `0.0.7162784`)                                                   |
| Amount             | 100,000 tinybars (0.001 HBAR) to `0.0.11044329` (provider kev)                                                             |
| **Transaction ID** | **[`0.0.7162784@1794013845.097491617`](https://hashscan.io/testnet/transaction/0.0.7162784%401794013845.097491617)**       |
| Result             | HTTP 200, Mirror Node `SUCCESS`, payee and amount verified                                                                 |
| Evidence file      | [`docs/evidence/hedera/x402-settlement-20261107T011055Z.json`](docs/evidence/hedera/x402-settlement-20261107T011055Z.json) |

### Payments made by the agent on its own (no human approving)

From the live run on 2026-11-07 (see [Proof of a live run](#proof-of-a-live-run)):

| Provider                                 | Amount      | Transaction ID                                                                                                   |
| ---------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `osv.chirag126.eth` (npm lodash 4.17.21) | 0.0012 HBAR | [`0.0.7162784@1794013964.928530428`](https://hashscan.io/testnet/transaction/0.0.7162784%401794013964.928530428) |
| `osv.chirag126.eth` (OpenSSL)            | 0.0012 HBAR | [`0.0.7162784@1794013974.058062743`](https://hashscan.io/testnet/transaction/0.0.7162784%401794013974.058062743) |

Both were re-checked against the Mirror Node, together with deliberate wrong-payee,
wrong-amount and wrong-network probes:
[`docs/evidence/hedera/settlement-verifier-20261107T011532Z.json`](docs/evidence/hedera/settlement-verifier-20261107T011532Z.json).

### HCS audit trail

Every settlement and every task digest is posted to topic
[**`0.0.11201005`**](https://hashscan.io/testnet/topic/0.0.11201005). For the run above: messages
**#54** and **#55** (the two settlements) and **#56** (the task digest), each read back from the
Mirror Node and matched byte for byte with the agent's record:
[`docs/evidence/hcs/hcs-audit-20261107T011505Z.json`](docs/evidence/hcs/hcs-audit-20261107T011505Z.json).

### Hedera accounts (testnet, all public)

| Role                                            | Account                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Agent's payer                                   | [`0.0.11044318`](https://hashscan.io/testnet/account/0.0.11044318) |
| Provider `kev` payout                           | [`0.0.11044329`](https://hashscan.io/testnet/account/0.0.11044329) |
| Provider `cve` payout                           | [`0.0.11183141`](https://hashscan.io/testnet/account/0.0.11183141) |
| Provider `osv` payout                           | [`0.0.11183142`](https://hashscan.io/testnet/account/0.0.11183142) |
| Agent's earnings (it sells its brief over x402) | [`0.0.11059993`](https://hashscan.io/testnet/account/0.0.11059993) |
| HCS audit topic                                 | [`0.0.11201005`](https://hashscan.io/testnet/topic/0.0.11201005)   |

---

## ENS

**ENS is how the agent finds who to pay, and what it is allowed to pay them.** Without ENS the
agent has no providers: no endpoint, no price, no payee.

### Providers as ENSv2 subnames of `chirag126.eth` (Sepolia)

Each provider is an ENSv2 subname with **its own PermissionedResolver**:

| Name                | Capabilities                          | Price            | Hedera payout  | Resolver                                                                                             |
| ------------------- | ------------------------------------- | ---------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `kev.chirag126.eth` | known-exploited-vulns, ransomware-use | 100,000 tinybars | `0.0.11044329` | [`0x1993BB58…9261`](https://sepolia.etherscan.io/address/0x1993BB58708a630AF1CC01304Dd851BDEccF9261) |
| `cve.chirag126.eth` | cve-details, cvss-scores              | 150,000 tinybars | `0.0.11183141` | [`0xda1517cf…ECFb`](https://sepolia.etherscan.io/address/0xda1517cfB2e616E8cE8620B6E78c75d5C560ECFb) |
| `osv.chirag126.eth` | ecosystem-advisories, package-vulns   | 120,000 tinybars | `0.0.11183142` | [`0x806DB7F7…5Daa`](https://sepolia.etherscan.io/address/0x806DB7F7576D941833063aE49B987948e51A5Daa) |

Records each provider publishes (full list in [`docs/ens-records.md`](docs/ens-records.md)):
`agent.endpoint`, `agent.capabilities`, `agent.price`, `agent.status`, `agent-context`,
`agent-endpoint[x402]` (ENSIP-26 style), `description`, and the payout records `x402.payTo`,
`x402.network`, `x402.asset`.

### How the agent uses ENS

- **Discovery:** it scans the subregistry's registration logs, then reads every record through
  the ENSv2 **Universal Resolver** at one pinned block, so a task always works from a consistent
  snapshot.
- **Payment binding:** the spending firewall refuses any quote whose price, payee, network, asset
  or endpoint differs from these records. A provider cannot raise its price or change its payee
  without changing ENS.
- **The providers check ENS too:** the provider service refuses to start if what it serves
  disagrees with its own ENS records.

### Permissions (who can change what)

Each provider has an **operator** that may edit only its own descriptive records. The payout
records (`x402.payTo`, `x402.network`, `x402.asset`) can be changed by the admin alone. Proven
on Sepolia, 2026-11-07:

| Case                                        | Expected | Result    | Transaction                                                                                                         |
| ------------------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| kev's operator edits kev's `description`    | allowed  | succeeded | [`0x48094616…`](https://sepolia.etherscan.io/tx/0x480946160d7b0ba4d37d68e4532dad5c8f2609e812c6242e649f84f9b4d16db1) |
| kev's operator restores it                  | allowed  | succeeded | [`0x85200405…`](https://sepolia.etherscan.io/tx/0x8520040518f84884f07b50e6606c1454e450f3a9325aebdfaab85bdcef568ad8) |
| kev's operator edits **cve's** record       | denied   | reverted  | [`0x06be18b0…`](https://sepolia.etherscan.io/tx/0x06be18b0c9f0aa7824d705e5adb603a39250a7571adf769d7bd7eb64b3039a10) |
| kev's operator edits kev's **`x402.payTo`** | denied   | reverted  | [`0x266d2904…`](https://sepolia.etherscan.io/tx/0x266d29047ef372eddadf6ea77bd1b5a320a7c4586bda4c28530e2ccdbdaa1bc2) |
| admin revokes kev's operator                | allowed  | succeeded | [`0xefaf768a…`](https://sepolia.etherscan.io/tx/0xefaf768aa254303e24ec094bc4fac4df671cb4f3671f1e67511a939a587f07ad) |
| revoked operator tries again                | denied   | reverted  | [`0xcd675cde…`](https://sepolia.etherscan.io/tx/0xcd675cde57890a7d5f9c89f457a0200d6d3cb371786f4db129558efbef907636) |
| admin re-grants the operator                | allowed  | succeeded | [`0x33d4b62b…`](https://sepolia.etherscan.io/tx/0x33d4b62b6154429f05e0b6aa9fe110a2dd3faf51b655a58c87c917befb277061) |

Evidence file: [`docs/evidence/ens/permissions-20261107T012250Z.json`](docs/evidence/ens/permissions-20261107T012250Z.json).

### Change a record, change what the agent does

On 2026-11-07 the providers moved to a new host. Only the ENS records changed (the code did
not), and the next task paid the new host:

| Name                | Records changed                          | Transaction                                                                                                         |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `kev.chirag126.eth` | `agent.endpoint`, `agent-endpoint[x402]` | [`0x7d0a5e03…`](https://sepolia.etherscan.io/tx/0x7d0a5e03b9996fa6988c154f30d0045f7c4184ea35df03fc5bcdbf1c609002b6) |
| `cve.chirag126.eth` | `agent.endpoint`, `agent-endpoint[x402]` | [`0x15057fdb…`](https://sepolia.etherscan.io/tx/0x15057fdb83a6ece7d9164ac1327c6dba7b95e23293f45c9cf1496278d44fc23e) |
| `osv.chirag126.eth` | `agent.endpoint`, `agent-endpoint[x402]` | [`0x820ad010…`](https://sepolia.etherscan.io/tx/0x820ad0103f20d7ffe1e542ae4ea3f59c2aa5f556d47332099a047b47f86ff066) |

The live run that followed discovered `https://endersift-providers.onrender.com/v1/...` at ENS
block 12080326 and paid there.

### ERC-8004 agent identities

The three providers and the agent itself are registered in the ERC-8004 Identity Registry
[`0x8004A818…BD9e`](https://sepolia.etherscan.io/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
(Sepolia) as agents **11230** (kev), **11231** (cve), **11232** (osv) and **11233** (the
Endersift agent). Each points to its registration file on the provider service, for example
https://endersift-providers.onrender.com/.well-known/erc-8004/kev.json. Evidence file:
[`docs/evidence/identity/erc8004-register-20261107T012335Z.json`](docs/evidence/identity/erc8004-register-20261107T012335Z.json).

### ENSv2 contracts and addresses (Sepolia)

From [`deployments/sepolia.json`](deployments/sepolia.json):

| Item                                | Address                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Subregistry of `chirag126.eth`      | [`0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758`](https://sepolia.etherscan.io/address/0x3F54Fcd9ea71D96db6e66aaecCB5B20c3C003758) |
| ENS admin (owner)                   | [`0x66359fa8d11365B71bCB9e7324Bf73c5487a77F5`](https://sepolia.etherscan.io/address/0x66359fa8d11365B71bCB9e7324Bf73c5487a77F5) |
| ETHRegistry                         | `0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4`                                                                                    |
| Universal Resolver                  | `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`                                                                                    |
| VerifiableFactory                   | `0xda70306c98e97ece36f997a21368e53298572991`                                                                                    |
| UserRegistry implementation         | `0x9bd8a88719068d09ecee662f36c0e3856708366a`                                                                                    |
| PermissionedResolver implementation | `0x115eb53f0c60696633855f90b138178fb40b2b2c`                                                                                    |
| Operators (kev · cve · osv)         | `0x4CEB63E8…b1EC` · `0x615837b3…1226` · `0x974f20ee…9DC4`                                                                       |

---

## 0G

**0G Private Computer is the agent's brain.** Every task makes two calls to the 0G Router: one to
**plan** what to buy, one to **analyse** what was bought.

**What breaks without 0G:** nothing decides which ENS-listed providers are worth paying on Hedera,
and nothing turns what was bought into a brief, so every task would stop after discovery with
nothing paid and nothing to read.

### How the agent calls 0G

- **Structured output:** each call asks for JSON that must match a schema; anything else is
  rejected, never guessed.
- **Spending caps before every call:** the agent reserves the worst-case cost from the Router's
  catalog price, and refuses the call if it would exceed the per-call cap (0.005 0G) or the daily
  cap (0.1 0G). The real bill is recorded afterwards in an inference ledger.
- **Request IDs everywhere:** every call's 0G request ID is stored, shown on the task page under
  "0G usage", and printed in the brief.

### Calls on record (0G mainnet, model `qwen2.5-vl-72b-instruct`)

| Call                       | Request ID                             | Billed                 |
| -------------------------- | -------------------------------------- | ---------------------- |
| Live run: PLAN             | `2791d949-7722-4341-912d-c2d81a9a78ea` | 81 neuron              |
| Live run: ANALYZE          | `06d37e37-49a8-43fb-a215-cdb6737859c9` | 78 neuron              |
| Standalone structured call | `fe54d6b1-a697-400d-8f2e-525db938eb7a` | 64 neuron (0G credits) |

The agent's ledger was matched against the Router's own usage history by request ID (2 of 2
match): [`docs/evidence/zg/ledger-20261107T012434Z.json`](docs/evidence/zg/ledger-20261107T012434Z.json).
The standalone call, with its schema check and billing checks:
[`docs/evidence/zg/structured-20261107T012412Z.json`](docs/evidence/zg/structured-20261107T012412Z.json).

### 0G setup instructions

1. **Create a 0G API key** in the 0G Private Computer dashboard and fund the account (or use
   credits). The API key starts with `sk-`. A separate **management key** (`mk-…`) is only needed
   to read your balance and usage locally; never deploy it.
2. **Set these in `.env`:**

   ```
   ZG_NETWORK=mainnet
   ZG_ROUTER_BASE_URL=https://router-api.0g.ai/v1
   ZG_MODEL=qwen2.5-vl-72b-instruct
   ZG_API_KEY=sk-...
   ZG_MAX_CALL_COST_NEURON=5000000000000000
   ZG_DAILY_CAP_NEURON=100000000000000000
   # optional, local only:
   ZG_MANAGEMENT_KEY=mk-...
   ```

3. **Check the setup:**

   ```cmd
   pnpm zg:models -- --network mainnet
   pnpm zg:structured -- --dry-run
   pnpm zg:structured
   pnpm zg:balance
   ```

   - `zg:models` lists the models 0G serves right now; `ZG_MODEL` must be one of them.
   - `zg:structured -- --dry-run` checks the model, its JSON support and the cost cap without
     spending anything.
   - `zg:structured` makes one real call and prints its request ID.
   - `zg:balance` shows your balance (needs the management key).

   If the model is missing from the catalog, the server still starts, says so on the New task
   page, and checks again every minute.

**Voice input** (0G's `whisper-large-v3`) is built in but switched off (`ZG_STT_MODEL=off`)
while 0G's speech model is unavailable; set `ZG_STT_MODEL=whisper-large-v3` to turn it on.

---

## Proof of a live run

One complete task on the deployed services, 2026-11-07 01:11–01:13 UTC, watchlist
`OpenSSL, lodash@4.17.21 (npm)`, budget 0.003 HBAR. No human approved anything.

| Step              | Result                                                           | Proof                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ENS discovery     | 3 providers at Sepolia block 12080326; every catalog matched ENS | ENS records above                                                                                                                                                                                            |
| 0G plan           | 2 purchases planned                                              | request `2791d949-7722-4341-912d-c2d81a9a78ea`                                                                                                                                                               |
| x402 payments     | 2 approved by the firewall, 2 settled                            | [`…1794013964.928530428`](https://hashscan.io/testnet/transaction/0.0.7162784%401794013964.928530428), [`…1794013974.058062743`](https://hashscan.io/testnet/transaction/0.0.7162784%401794013974.058062743) |
| Mirror Node check | both verified before the data was used                           | settlement-verifier file                                                                                                                                                                                     |
| 0G analysis       | lodash GHSA-r5fr-rjxr-66jc ranked P1 (fix today)                 | request `06d37e37-49a8-43fb-a215-cdb6737859c9`                                                                                                                                                               |
| HCS audit         | messages #54, #55, #56 on `0.0.11201005`                         | [topic on HashScan](https://hashscan.io/testnet/topic/0.0.11201005)                                                                                                                                          |

Full record of the run (events, payments, 0G calls, the brief, and every check):
[`docs/evidence/e2e/agent-run-20261107T011322Z.json`](docs/evidence/e2e/agent-run-20261107T011322Z.json).

### All evidence files

| File                                                                                                                 | What it proves                                                |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`e2e/agent-run-20261107T011322Z.json`](docs/evidence/e2e/agent-run-20261107T011322Z.json)                           | The full task end to end                                      |
| [`hedera/x402-settlement-20261107T011055Z.json`](docs/evidence/hedera/x402-settlement-20261107T011055Z.json)         | One x402 payment settled via Blocky402 and verified           |
| [`hedera/settlement-verifier-20261107T011532Z.json`](docs/evidence/hedera/settlement-verifier-20261107T011532Z.json) | Payments re-verified; wrong payee, amount and network refused |
| [`hcs/hcs-audit-20261107T011505Z.json`](docs/evidence/hcs/hcs-audit-20261107T011505Z.json)                           | HCS messages match the agent's records                        |
| [`ens/permissions-20261107T012250Z.json`](docs/evidence/ens/permissions-20261107T012250Z.json)                       | ENS operator permissions, allowed and denied on chain         |
| [`identity/erc8004-register-20261107T012335Z.json`](docs/evidence/identity/erc8004-register-20261107T012335Z.json)   | ERC-8004 identities of the four agents                        |
| [`zg/structured-20261107T012412Z.json`](docs/evidence/zg/structured-20261107T012412Z.json)                           | A 0G call with schema-valid JSON and exact billing            |
| [`zg/ledger-20261107T012434Z.json`](docs/evidence/zg/ledger-20261107T012434Z.json)                                   | The agent's 0G ledger matches 0G's usage history              |
| [`net/net-guard-20261107T012453Z.json`](docs/evidence/net/net-guard-20261107T012453Z.json)                           | Provider URLs are fetched safely (SSRF guard)                 |

How each file is produced: [`docs/evidence/README.md`](docs/evidence/README.md).

---

## Setup

### Prerequisites

- **Node.js 22.18 or newer** (TypeScript runs directly with Node's type stripping; no build step
  for the server)
- **pnpm 10.28** (`corepack enable`, or `npx pnpm@10.28.0 …`)
- Git

### Install

```cmd
git clone https://github.com/Chirag126/Endersift.git
cd Endersift
pnpm install --frozen-lockfile
copy .env.example .env
pnpm env:check
```

`pnpm install` also installs a pre-commit hook that blocks commits containing secrets.
`pnpm env:check` lists what is missing in `.env` without printing any value. Every variable is
described in [`.env.example`](.env.example).

### Try it without spending anything

Fake ENS, providers, Hedera and 0G; nothing is paid (access code `mock-access-code`):

```cmd
pnpm web:mock-api
pnpm web:dev
```

Open http://localhost:5173.

### Run it against the real networks

Fill `.env` with a funded **Hedera testnet** payer account, a **Sepolia RPC URL** and a **0G API
key** (see [0G setup instructions](#0g-setup-instructions)), then:

```cmd
pnpm providers:start
pnpm api:start
pnpm web:dev
```

Or run one task from the terminal and save its evidence:

```cmd
pnpm agent:run "OpenSSL, lodash@4.17.21 (npm)" --budget 300000 --from-block 11999808 --save-evidence
```

### Useful commands

| Command                                                   | What it does                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm check`                                              | Everything CI runs: format, lint, typecheck, build, tests, env template, secret scan |
| `pnpm test`                                               | Unit and mock tests                                                                  |
| `pnpm agent:run "<watchlist>" --budget <tinybars>`        | One live task end to end (`--save-evidence` writes the run file)                     |
| `pnpm x402:pay -- --url <provider URL>`                   | Pay one x402 request and verify it on the Mirror Node                                |
| `pnpm hcs:check`                                          | Read a run's HCS messages back from the Mirror Node                                  |
| `pnpm firewall:check`                                     | The spending firewall against live quotes, without paying                            |
| `pnpm ens:discover`                                       | List the providers ENS publishes right now                                           |
| `pnpm ens:provision`                                      | Dry run of the provider ENS records (`-- --confirm` to write)                        |
| `pnpm zg:models`, `pnpm zg:structured`, `pnpm zg:balance` | 0G catalog, one test call, balance                                                   |
| `pnpm ledger:reconcile`                                   | Match the 0G ledger with 0G's usage history                                          |

---

## Deploy on Render

Two web services from this repository (free plan works):

| Service                       | Build command                                                                                             | Start command                                                        | Health check  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------- |
| `endersift` (agent + web app) | `corepack enable && pnpm install --frozen-lockfile --ignore-scripts --production=false && pnpm web:build` | `node --disable-warning=ExperimentalWarning apps/server/src/main.ts` | `/api/health` |
| `endersift-providers`         | `corepack enable && pnpm install --frozen-lockfile --ignore-scripts`                                      | `node apps/providers/src/server.ts`                                  | `/health`     |

- [`render.yaml`](render.yaml) lists every environment variable with its value. Secrets
  (`HEDERA_PAYER_PRIVATE_KEY`, `ZG_API_KEY`, `ETH_RPC_URL`, `DEMO_ACCESS_CODE`) are entered in the
  Render dashboard, never committed.
- The provider service checks its ENS records at start: `PROVIDERS_PUBLIC_URL` must equal the host
  in the providers' `agent.endpoint` records. To move it, set `ENS_AGENT_ENDPOINT_BASE` to the new
  URL in `.env`, run `pnpm ens:provision -- --confirm`, then `pnpm erc8004:register -- --confirm`.
- Deploy the providers first, then the agent.

More detail: [`docs/deployment.md`](docs/deployment.md).

---

## Repository layout

| Path                 | Purpose                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `apps/server`        | The agent: config, SQLite, orchestrator, payments, inference ledger, scheduler, HCS audit, API |
| `apps/web`           | The web app (Vite + React), served by the agent                                                |
| `apps/providers`     | The x402 sellers kev, cve, osv (Hono + `@x402/hono`)                                           |
| `apps/holder-probe`  | 0G holder sign-in lane (localhost only, bonus)                                                 |
| `packages/core`      | Environment specification and the domain model                                                 |
| `packages/ens`       | ENSv2 discovery, records, provisioning, permissions, ERC-8004                                  |
| `packages/hedera`    | x402 client and server, facilitators, Mirror Node, settlement checks, HCS                      |
| `packages/zg`        | 0G Router client: catalog, structured output, cost caps, usage                                 |
| `packages/policy`    | The spending firewall                                                                          |
| `packages/net-guard` | SSRF-safe fetching of provider URLs                                                            |
| `scripts/`           | Live checks and chain actions; each can save evidence                                          |
| `deployments/`       | The verified ENS and ERC-8004 deployments on Sepolia                                           |
| `docs/evidence/`     | Evidence files from real networks                                                              |

---

## Security

- Secrets live only in `.env` (local) or in the host's secret store. A pre-commit hook, gitleaks in
  CI and GitHub push protection keep them out of Git. See [`SECURITY.md`](SECURITY.md) and
  [`docs/security-checklist.md`](docs/security-checklist.md).
- The model never moves money: the spending firewall is plain code, and payment limits are
  enforced on the server.
- Provider URLs and records from ENS are treated as untrusted input.
- The ENS admin key and the 0G management key are used only on the owner's computer, never
  deployed.

---

## Known limits

- **Free hosting:** the services sleep after 15 minutes idle, and the agent's database starts
  empty after a restart. Payments, HCS messages and ENS records stay on-chain.
- **Voice input** is off while 0G's speech-to-text model is unavailable.
- **Holder sign-in** (0G Privy) runs on localhost only and needs 0G's Privy app ID.
- **USDC** payments are built, but there is no USDC settlement yet; every payment above is in HBAR.
- **Testnets:** Hedera and ENS run on testnets; 0G runs on mainnet.

---

## Licence

[MIT](LICENSE) © 2026 Chirag126
