# Deployment (Render, free plan)

Plan row 33 (repo Phase 32, D-062). The agent and its data providers run as two free Render web
services, described in [`render.yaml`](../render.yaml):

| Service                  | What it runs                                                  | Health check  |
| ------------------------ | ------------------------------------------------------------- | ------------- |
| `threat-intel-agent`     | The agent: API, scheduler, and the web app on the same origin | `/api/health` |
| `threat-intel-providers` | The x402 data providers kev, cve and osv                      | `/health`     |

**The holder lane is not deployed.** 0G's Privy app ID accepts sign-ins from `localhost:3000`,
`3001` and `5173` only, so it stays a local app (`pnpm holder:lane`). The deployed Holder lane page
says so.

## What the free plan means, and how the agent stays safe

| Free plan fact (render.com/docs/free)                                           | Consequence                                                                                      | What the agent does                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A service sleeps after 15 min without inbound traffic, and takes ~1 min to wake | The first visit waits about a minute. A sleeping provider host does not answer the agent at once | The web app wakes the provider host from the visitor's browser (`PROVIDER_WAKE_ORIGIN`, D-085): Render answered the agent's own requests with HTTP 429 and did not start the host. A run then retries a catalog for up to `PROVIDER_WAKE_SEC` (180 s), shared by the providers on one host. Catalog reads are free |
| No disk: the database is wiped on every restart, redeploy or sleep              | Run history, saved rules, schedules and today's spend count are lost                             | **Today's spend is re-read from the chain**: before any 0G call or payment, each run reads the payer's x402 transfers for the UTC day from the Hedera Mirror Node and counts those this database does not know. If the Mirror Node cannot be read, the run stops before spending (`SPEND_UNVERIFIED`)              |
| (same)                                                                          | A UI pause would be forgotten                                                                    | `X402_PAYMENTS_PAUSED=true` in the service's environment is a pause no restart can lift                                                                                                                                                                                                                            |
| (same)                                                                          | Schedules made on the Daily brief page are forgotten                                             | The daily brief comes from `DAILY_BRIEF_*` and is recreated at every start. It catches up only within 120 min of its time, so a visitor waking the service later that day does not run it again                                                                                                                    |
| An in-process timer stops while the service sleeps                              | The scheduler cannot fire by itself                                                              | A free external ping wakes the agent at the brief's time (step 6)                                                                                                                                                                                                                                                  |
| 750 free instance hours per month for the whole workspace                       | Two services awake 24/7 would need about 1,490 hours                                             | Neither is kept awake. The ping keeps the agent up for 2 h a day (about 60 h a month); visits and runs add the rest                                                                                                                                                                                                |

Proof of what happened never depends on the database: payments are on HashScan and the Mirror
Node, and each run's digest is on the HCS audit topic (`0.0.11201005`).

**What stays reset:**

- The run history on the Runs page; the committed evidence files remain.
- Rules saved in the UI.
- The 0G daily cap counter (`ZG_DAILY_CAP_NEURON`). The cap holds per process lifetime only; the
  Router balance (testnet) is the outer bound.

## Steps

You need:

- a Render account with GitHub connected;
- your Infura Sepolia URL, Hedera payer key and 0G API key, ready to paste into Render. Never paste
  them in chat or commit them;
- a strong `DEMO_ACCESS_CODE` (12+ characters). It guards every paid action on the public URL.

### 1. Create the services from the Blueprint

1. Render dashboard → **New** → **Blueprint** → pick this repository, branch `main`.
2. Render reads `render.yaml` and asks for each secret (`sync: false`):

   | Variable                   | Service   | Value                                                                         |
   | -------------------------- | --------- | ----------------------------------------------------------------------------- |
   | `DEMO_ACCESS_CODE`         | agent     | your access code                                                              |
   | `HEDERA_PAYER_PRIVATE_KEY` | agent     | the payer key from your `.env`                                                |
   | `ETH_RPC_URL`              | both      | your Infura Sepolia URL                                                       |
   | `ZG_API_KEY`               | agent     | your 0G key from `.env`                                                       |
   | `PROVIDERS_PUBLIC_URL`     | providers | `https://threat-intel-providers.onrender.com` (corrected in step 2 if needed) |
   | `NVD_API_KEY`              | providers | optional; leave empty if you have none                                        |

3. **Apply.** Expected:
   - **agent** deploys and its health check passes. Tasks fail with `NO_PROVIDERS` until step 3,
     because the ENS records still point at `http://127.0.0.1:4021`.
   - **providers** fails to start with `EnsMismatchError`, also until step 3. That is the startup
     check working: it refuses to serve prices or payees that differ from ENS.

If the build fails at `corepack enable`, change the build command's start to
`npm install -g pnpm@10.28.0 &&` instead of `corepack enable &&`.

### 2. Note the two URLs

At the top of each service's page. If the providers URL differs from what you entered, change
`PROVIDERS_PUBLIC_URL` to the exact URL, with no trailing slash.

### 3. Point the ENS records at the deployed providers (from your PC)

The agent finds providers only through ENS, and in production it refuses `http://` endpoints.

1. In your local `.env`: `ENS_AGENT_ENDPOINT_BASE=https://<providers URL>`.
2. Dry run, which sends nothing:

   ```cmd
   pnpm ens:provision
   ```

   The plan should change only `agent.endpoint` and `agent-endpoint[x402]` for kev, cve and osv.

3. Send (Sepolia gas only):

   ```cmd
   pnpm ens:provision -- --confirm --save-evidence
   ```

4. Check:

   ```cmd
   pnpm ens:resolve -- --name kev.chirag126.eth --agent
   ```

   The endpoint should be `https://<providers URL>/v1/kev`.

Attach the evidence file and the updated `deployments/sepolia.json` in chat (don't commit them).

### 4. Redeploy the providers

providers → **Manual Deploy** → **Deploy latest commit**. The log should show `ENS check OK: kev,
cve, osv match their live records`, then `listening on http://0.0.0.0:10000`.

### 5. Check

```cmd
curl -i https://<agent URL>/api/health
curl -i https://<providers URL>/health
```

Both should answer `200` (the first call may take a minute while the service wakes). The agent's
response carries `content-security-policy`. Then open `https://<agent URL>/` in the browser and
look at the Overview page. The task run itself is plan row 34.

### 6. Wake the agent for the daily brief

The brief is due at 00:15 UTC (05:45 IST). Create a free job at [cron-job.org](https://cron-job.org):

- URL: `https://<agent URL>/api/health`, method GET.
- Schedule: every 10 minutes from 00:00 to 01:59 UTC.

That wakes the agent before the brief and keeps it awake while the brief runs.

## After the switch, locally

- The ENS records now name the Render providers. A local `pnpm api:start` buys from them over
  https; `--allow-local-http` is no longer needed.
- A local `pnpm providers:start` now fails its ENS check, because the records point elsewhere. Use
  it with `--skip-ens-check` (development only) or point ENS back to it.

## Stopping payments

Render → agent → **Environment** → add `X402_PAYMENTS_PAUSED` = `true` → **Save**, which
redeploys. Every payment is refused and no task starts until you remove it. The pause on the
Spending rules page also works, but only until the next restart.
