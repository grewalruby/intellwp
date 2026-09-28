# Intelligent Order Workspace

A high-fidelity Infor LN workspace prototype for an Intelligent Order
Acceptance & Adaptive Capacity Resequencing scenario, with a lightweight
Node.js backend that pulls **live data from Infor LN** for several widgets.

## What's live vs. mocked

| Widget | Data source |
|---|---|
| KPI bar (open orders, at risk, revenue exposure, confidence) | **Live** — open lines from `tdapi.slsSalesOrder` |
| New Order Review | **Live** — `tdapi.slsSalesOrder` (latest order, or `?salesOrder=`) |
| Customer Insight | **Live** — `tcapi.comBusinessPartner` + 12-month delivery history |
| Customer Claims & Cstat | **Live** — `tsapi.cmmCustomerClaim`; Cstat computed server-side |
| Capacity Utilization | **Live work centers** — `tiapi.sfcProductionOrder`, `txest.ProductionWorkCenter` (load adjusted by demo layer) |
| Existing Commitments at Risk | **Live** — open lines planned later than requested |
| Commitment Risk Summary, Recovery Scenarios, Recommendation | **Infor GenAI**, grounded in the live data above, with a rule-based fallback |

If the backend is unreachable, the page keeps its built-in sample content.

### Demo data layer

Demo tenants have thin data, so by default the server fills gaps with
believable, consistent values (real LN values always win):

- Customer tier and annual revenue, where LN has none, derived from the customer's order volume.
- Constraint work center load of 105–118% against the weekly capacity stand-in.

Set `DEMO_ENRICH=false` to show raw LN data only.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `DEMO_ENRICH` | `true` | Demo data layer on/off |
| `WC_WEEKLY_CAPACITY_HOURS` | `80` | Available hours per work center per week |
| `RISK_WINDOW_PAST_DAYS` / `RISK_WINDOW_FUTURE_DAYS` | `30` / `90` | Requested-date window for "at risk" |
| `GENAI_MODEL_VERSION`, `GENAI_LOGICAL_ID_PREFIX` | service default / `lid://infor.ln` | GenAI call settings |

## Running it

```
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

### Credentials setup

The server needs an Infor ION API service account credentials file
(`.ionapi`) to call live LN data. See `config/README.md` for setup —
in short:

1. Place your `.ionapi` file at `config/credentials.ionapi`, **or**
2. Set the `IONAPI_PATH` environment variable to point to it wherever it is.

This file is never committed to git (`.gitignore` excludes all `*.ionapi`
files) and is never sent to the browser — only the Node.js server reads it.

### Health check

`GET /api/health` reports whether the server successfully loaded LN
credentials, without exposing any secret values.

## Project structure

```
index.html              Workspace UI (source of truth for editing)
Intelligent-Order-Workspace.html   Single-file portable copy (fully mocked,
                                    no backend — for sharing without setup)
css/styles.css           All styling
js/app.js                 UI interactivity (buttons, scenario selection, toasts)
js/live-data.js           Fetches live LN data and updates the DOM in place
server.js                Express server + API routes
lnClient.js               LN OAuth token handling + generic OData GET helper
config/                  Credentials folder (git-ignored contents)
```

## Sharing without the backend

If you just need to hand someone a file to open directly in a browser (no
`npm install`, no server), send **`Intelligent-Order-Workspace.html`** —
it's fully self-contained with mocked data and works standalone.
