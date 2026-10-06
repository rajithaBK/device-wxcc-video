// Shared OAuth token refresh for Webex Service Apps.
//
// WEBEX_* identifies the single Service App used for Meetings, WxCC Tasks, and
// RoomOS Cloud xAPI operations.
//
// Each Service App's long-lived refresh token (from env) is exchanged for a
// short-lived access token via the standard Webex token endpoint, then cached
// in module memory and re-refreshed shortly BEFORE it expires (skew). This is
// the reliable pattern for serverless: every request lazily gets a valid token,
// and the optional cron warm endpoint (api/refresh.js) keeps them fresh and the
// refresh tokens alive.
//
// SECURITY: client secrets + refresh tokens come ONLY from env vars — never
// hardcoded, never committed.

const TOKEN_URL = "https://webexapis.com/v1/access_token";
const SKEW_MS = 5 * 60 * 1000; // refresh 5 min before expiry

// One cache entry per credential set, keyed by env-var prefix.
const cache = new Map();

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Returns a valid access token for the given env-var prefix (e.g. "WEBEX" or
 * "WXCC"), refreshing from `${prefix}_CLIENT_ID/_CLIENT_SECRET/_REFRESH_TOKEN`
 * when the cached token is missing or within the skew window of expiry.
 */
export async function getAccessToken(prefix) {
  const cached = cache.get(prefix);
  if (cached && Date.now() < cached.expiresAtMs - SKEW_MS) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: requiredEnv(`${prefix}_CLIENT_ID`),
    client_secret: requiredEnv(`${prefix}_CLIENT_SECRET`),
    refresh_token: requiredEnv(`${prefix}_REFRESH_TOKEN`),
  });

  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed for ${prefix} (${resp.status}): ${text}`);
  }

  const json = await resp.json();
  cache.set(prefix, {
    accessToken: json.access_token,
    expiresAtMs: Date.now() + json.expires_in * 1000,
  });
  return json.access_token;
}

/**
 * Proactively refresh a list of prefixes (used by the cron warm endpoint).
 * Never throws — returns a per-prefix status map so one failure doesn't hide
 * the others.
 */
export async function refreshAll(prefixes) {
  const results = {};
  for (const prefix of prefixes) {
    try {
      await getAccessToken(prefix);
      results[prefix] = "ok";
    } catch (e) {
      results[prefix] = `failed: ${e.message || e}`;
    }
  }
  return results;
}
