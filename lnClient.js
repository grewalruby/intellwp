// lnClient.js
//
// Server-side only. Loads the .ionapi credentials file, acquires and caches
// an OAuth2 access token from Infor's SSO endpoint, and provides a helper
// for making authenticated OData GET requests against LN Web APIs.
//
// IMPORTANT: Nothing in this file is ever sent to the browser. The Express
// routes in server.js call functions here and forward only the resulting
// JSON data (or a sanitized error) to the client.

const fs = require('fs');
const path = require('path');
const https = require('https');

const DEFAULT_IONAPI_PATH = path.join(__dirname, 'config', 'credentials.ionapi');

let cachedConfig = null;
let cachedToken = null;
let cachedTokenExpiresAt = 0;

/**
 * Loads LN credentials.
 *
 * Two supported sources, checked in this order:
 *   1. Environment variables (used on Render and other hosts where you
 *      don't want a credentials file on disk at all):
 *        LN_TI    -> ti   (tenant id)
 *        LN_CI    -> ci   (client id)
 *        LN_CS    -> cs   (client secret)
 *        LN_IU    -> iu   (ION API base URL)
 *        LN_PU    -> pu   (SSO base URL)
 *        LN_OT    -> ot   (token path)
 *        LN_SAAK  -> saak (service account access key)
 *        LN_SASK  -> sask (service account secret key)
 *   2. A .ionapi JSON file on disk (used for local development), at the
 *      path in IONAPI_PATH or config/credentials.ionapi by default.
 */
function loadConfig() {
  if (cachedConfig) return cachedConfig;

  const envConfig = {
    ti: process.env.LN_TI,
    ci: process.env.LN_CI,
    cs: process.env.LN_CS,
    iu: process.env.LN_IU,
    pu: process.env.LN_PU,
    ot: process.env.LN_OT,
    saak: process.env.LN_SAAK,
    sask: process.env.LN_SASK,
  };

  const required = ['ti', 'ci', 'cs', 'iu', 'pu', 'ot', 'saak', 'sask'];
  const envHasAllFields = required.every((key) => envConfig[key]);

  if (envHasAllFields) {
    cachedConfig = envConfig;
    return cachedConfig;
  }

  const ionapiPath = process.env.IONAPI_PATH || DEFAULT_IONAPI_PATH;

  if (!fs.existsSync(ionapiPath)) {
    throw new Error(
      `No LN credentials found. Either set the LN_TI, LN_CI, LN_CS, LN_IU, ` +
      `LN_PU, LN_OT, LN_SAAK, and LN_SASK environment variables, or place a ` +
      `.ionapi file at "${ionapiPath}" (or point IONAPI_PATH at one).`
    );
  }

  const raw = fs.readFileSync(ionapiPath, 'utf8');
  const parsed = JSON.parse(raw);

  for (const key of required) {
    if (!parsed[key]) {
      throw new Error(`LN credentials file is missing required field "${key}".`);
    }
  }

  cachedConfig = parsed;
  return cachedConfig;
}

/**
 * Performs an HTTPS POST with a form-urlencoded body and returns parsed JSON.
 */
function httpsPostForm(url, formFields) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(formFields).toString();
    const urlObj = new URL(url);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Failed to parse token response: ${e.message}`));
            }
          } else {
            reject(new Error(`Token request failed: HTTP ${res.statusCode} ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Performs an authenticated HTTPS request against an ION API endpoint.
 * Returns { statusCode, body } where body is the raw response text.
 */
function httpsRequest(method, url, token, { headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = body ? JSON.stringify(body) : null;

    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || 443,
        path: urlObj.pathname + urlObj.search,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...headers,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('ION API request timed out'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Acquires an OAuth2 access token using the service account credentials,
 * caching it in memory until shortly before it expires.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const cfg = loadConfig();
  const tokenUrl = cfg.pu + cfg.ot;

  const tokenResponse = await httpsPostForm(tokenUrl, {
    grant_type: 'password',
    username: cfg.saak,
    password: cfg.sask,
    client_id: cfg.ci,
    client_secret: cfg.cs,
  });

  if (!tokenResponse.access_token) {
    throw new Error('LN token response did not include an access_token.');
  }

  cachedToken = tokenResponse.access_token;
  // Refresh 60 seconds before actual expiry to avoid edge-of-window failures.
  const expiresInMs = (tokenResponse.expires_in || 3600) * 1000;
  cachedTokenExpiresAt = now + expiresInMs - 60000;

  return cachedToken;
}

/**
 * Builds the base LN Web API URL for this tenant, e.g.
 * https://mingle-ionapi.inforcloudsuite.com/{tenant}/LN/lnapi
 */
function getBaseUrl() {
  const cfg = loadConfig();
  return `${cfg.iu}/${cfg.ti}/LN/lnapi`;
}

/**
 * Performs an authenticated GET against an LN OData path (relative to the
 * lnapi base URL, e.g. "/odata/tdapi.slsSalesOrder/Orders?$top=5") and
 * returns the parsed JSON body.
 *
 * Throws a descriptive error if the LN backend returns a non-2xx status
 * (including the increasingly familiar 503 when the backend is unreachable).
 */
async function lnGet(relativePathOrUrl, { maxPageSize } = {}) {
  const token = await getAccessToken();
  const url = /^https?:\/\//i.test(relativePathOrUrl)
    ? relativePathOrUrl
    : `${getBaseUrl()}${relativePathOrUrl}`;

  const headers = maxPageSize ? { Prefer: `odata.maxpagesize=${maxPageSize}` } : {};
  const { statusCode, body } = await httpsRequest('GET', url, token, { headers });

  if (statusCode < 200 || statusCode >= 300) {
    const err = new Error(
      `LN API request failed with HTTP ${statusCode} for ${relativePathOrUrl}`
    );
    err.statusCode = statusCode;
    err.lnBody = body;
    throw err;
  }

  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`Failed to parse LN response as JSON: ${e.message}`);
  }
}

/**
 * Fetches all rows for an OData collection query, following @odata.nextLink
 * pages. LN pages at 25 rows by default, so this requests larger pages via
 * the Prefer header and stops at maxRows as a safety cap.
 * Returns { rows, truncated }.
 */
async function lnGetAll(relativePath, { maxRows = 5000, pageSize = 500 } = {}) {
  const rows = [];
  let next = relativePath;
  while (next && rows.length < maxRows) {
    const data = await lnGet(next, { maxPageSize: pageSize });
    rows.push(...(data.value || []));
    next = data['@odata.nextLink'] || null;
  }
  return { rows: rows.slice(0, maxRows), truncated: Boolean(next) || rows.length > maxRows };
}

/**
 * Calls the Infor GenAI LLM service (GENAI/llmsvc /api/v1/prompt) using the
 * same ION service account token as LN. Returns the model's text content.
 */
async function genaiPrompt(prompt, { maxResponse = 1500, temperature = 0.2, version } = {}) {
  const cfg = loadConfig();
  const token = await getAccessToken();
  const url = `${cfg.iu}/${cfg.ti}/GENAI/llmsvc/api/v1/prompt`;
  const logicalIdPrefix = process.env.GENAI_LOGICAL_ID_PREFIX || 'lid://infor.ln';

  const body = {
    model: process.env.GENAI_MODEL || 'CLAUDE',
    prompt,
    config: { max_response: maxResponse, temperature },
  };
  const modelVersion = version || process.env.GENAI_MODEL_VERSION;
  if (modelVersion) body.version = modelVersion;

  const { statusCode, body: raw } = await httpsRequest('POST', url, token, {
    headers: { 'x-infor-logicalidprefix': logicalIdPrefix },
    body,
    timeout: 90000,
  });

  if (statusCode < 200 || statusCode >= 300) {
    const err = new Error(`GenAI request failed with HTTP ${statusCode}`);
    err.statusCode = statusCode;
    err.lnBody = raw;
    throw err;
  }

  const parsed = JSON.parse(raw);
  return parsed.content || '';
}

module.exports = {
  lnGet,
  lnGetAll,
  genaiPrompt,
  getAccessToken,
  getBaseUrl,
};
