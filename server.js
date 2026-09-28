// server.js
//
// Express server serving the static Intelligent Order Workspace UI and
// proxying live LN + Infor GenAI data through a small set of routes. The
// ION API credentials are loaded and used exclusively server-side (see
// lnClient.js) — they are never exposed to the browser.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { getBaseUrl } = require('./lnClient');
const { getWorkspace, getAnalysis } = require('./workspace');

const app = express();
const PORT = process.env.PORT || 3000;

// Confirms the server is up and whether LN credentials loaded, without
// making a live call or exposing any secret values. Registered before the
// login check so hosting health checks keep working.
app.get('/api/health', (req, res) => {
  try {
    getBaseUrl();
    res.json({ status: 'ok', lnConfigLoaded: true });
  } catch (err) {
    res.json({ status: 'degraded', lnConfigLoaded: false, message: err.message });
  }
});

// Optional login (HTTP Basic auth). Enabled when both APP_USERNAME and
// APP_PASSWORD are set; otherwise the site is open.
const APP_USERNAME = process.env.APP_USERNAME;
const APP_PASSWORD = process.env.APP_PASSWORD;

function safeEqual(a, b) {
  // Hash first so the comparison is constant-time regardless of length.
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

if (APP_USERNAME && APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      const userOk = safeEqual(user, APP_USERNAME);
      const passOk = safeEqual(pass, APP_PASSWORD);
      if (sep !== -1 && userOk && passOk) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Intelligent Order Workspace", charset="UTF-8"');
    res.status(401).send('Sign in required.');
  });
} else {
  console.warn('[auth] APP_USERNAME / APP_PASSWORD not set — the workspace is open to anyone with the URL.');
}

// Serve only the public UI files — never the project root, which holds
// server code, notes, and the local credentials file.
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/Intelligent-Order-Workspace.html', (req, res) =>
  res.sendFile(path.join(__dirname, 'Intelligent-Order-Workspace.html')));
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js', express.static(path.join(__dirname, 'js')));

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

app.listen(PORT, () => {
  console.log(`Intelligent Order Workspace server running at http://localhost:${PORT}`);
});
