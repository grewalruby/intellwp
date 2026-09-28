// server.js
//
// Express server serving the static Intelligent Order Workspace UI and
// proxying live LN + Infor GenAI data through a small set of routes. The
// ION API credentials are loaded and used exclusively server-side (see
// lnClient.js) — they are never exposed to the browser.

const path = require('path');
const express = require('express');
const { getBaseUrl } = require('./lnClient');
const { getWorkspace, getAnalysis } = require('./workspace');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

/**
 * Wraps a route handler so LN/GenAI errors are logged server-side and
 * returned to the client as a clean JSON error the front end can fall back
 * on, without leaking credential details.
 */
function safeRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`[API ERROR] ${req.method} ${req.originalUrl}:`, err.message);
      const notFound = err.statusCode === 404;
      res.status(notFound ? 404 : 502).json({
        error: true,
        message: notFound
          ? 'Sales order not found in LN.'
          : 'Live LN data is currently unavailable. The workspace will fall back to sample data.',
      });
    }
  };
}

// Everything the workspace needs for one order, except GenAI output.
// GET /api/workspace?salesOrder=SO0009773  (omit salesOrder for most recent)
app.get('/api/workspace', safeRoute(async (req, res) => {
  const data = await getWorkspace(req.query.salesOrder || null);
  if (!data) return res.status(404).json({ error: true, message: 'Sales order not found in LN.' });
  res.json(data);
}));

// GenAI risk summary, recovery scenarios, and recommendation for one order.
// Slower than /api/workspace, so the UI loads it separately.
// GET /api/analysis?salesOrder=SO0009773
app.get('/api/analysis', safeRoute(async (req, res) => {
  const data = await getAnalysis(req.query.salesOrder || null);
  if (!data) return res.status(404).json({ error: true, message: 'Sales order not found in LN.' });
  res.json(data);
}));

// Confirms the server is up and whether LN credentials loaded, without
// making a live call or exposing any secret values.
app.get('/api/health', (req, res) => {
  try {
    getBaseUrl();
    res.json({ status: 'ok', lnConfigLoaded: true });
  } catch (err) {
    res.json({ status: 'degraded', lnConfigLoaded: false, message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Intelligent Order Workspace server running at http://localhost:${PORT}`);
});
