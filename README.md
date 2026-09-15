# Intelligent Order Workspace

A high-fidelity Infor LN workspace prototype for an Intelligent Order
Acceptance & Adaptive Capacity Resequencing scenario, with a lightweight
Node.js backend that pulls **live data from Infor LN** for several widgets.

## What's live vs. mocked

| Widget | Data source |
|---|---|
| Widget 1 — New Order Review | **Live** — most recent Sales Order via `tdapi.slsSalesOrder` |
| Widget 4 — Customer Insight (name, tier, revenue) | **Live** — `tcapi.comBusinessPartner` |
| Customer Claims & Cstat (open claims count) | **Live** — `tsapi.cmmCustomerClaim` |
| Widget 2 — Commitment Risk Summary | Mocked (narrative/AI-generated content) |
| Widget 3 — Recommended Recovery Scenario | Mocked (no LN API generates scenario options) |
| Widget 5 — Capacity Utilization | Mocked — see note below |
| Widget 6 — Existing Commitments at Risk | Mocked (no single API for cross-order risk) |

If any live call fails or the backend isn't running, every widget falls back
to its original illustrative mock values automatically — the workspace
never breaks or shows blank fields.

### Note on Widget 5 (Capacity Utilization)

The correct live data source is `plaps.PlannerPlus` → `ResourceUtilizationDatas`,
which has pre-computed `Utilization`, `Overload`, `Available`, and `Used`
fields. On this tenant that endpoint currently returns zero rows (Advanced
Planning/Scheduling doesn't appear to have been run with data here yet), so
Widget 5 remains mocked until that data exists.

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
