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
 * Performs an authenticated HTTPS GET against an LN OData endpoint.
 * Returns { statusCode, body } where body is the raw response text.
 */
function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);

    const req = https.request(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 20000,
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
      req.destroy(new Error('LN request timed out'));
    });
    req.on('error', reject);
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
async function lnGet(relativePath) {
  const token = await getAccessToken();
  const base = getBaseUrl();
  const url = `${base}${relativePath}`;

  const { statusCode, body } = await httpsGet(url, token);

  if (statusCode < 200 || statusCode >= 300) {
    const err = new Error(
      `LN API request failed with HTTP ${statusCode} for ${relativePath}`
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

module.exports = {
  lnGet,
  getAccessToken,
  getBaseUrl,
};
