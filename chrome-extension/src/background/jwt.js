/*
 * Responsibility: JWT parsing helpers for the background service worker.
 * What it does: Extracts uid (sub) and exp timestamp from access tokens.
 * Connections: Used by config caching and auth refresh logic in handlers.js and authRefresh.js.
 */

function getUidFromJwt(token) {
  try {
    if (!token) return "default";
    const parts = token.split(".");
    if (parts.length !== 3) return "default";
    const payload = JSON.parse(atob(parts[1]));
    return payload && payload.sub ? payload.sub : "default";
  } catch (_) {
    return "default";
  }
}

function getJwtExpMs(token) {
  try {
    if (!token) return 0;
    const parts = token.split(".");
    if (parts.length !== 3) return 0;
    const payload = JSON.parse(atob(parts[1]));
    if (!payload || !payload.exp) return 0;
    return payload.exp * 1000;
  } catch (_) {
    return 0;
  }
}

