/*
 * Responsibility: Auth refresh and authenticated fetch helpers for the background service worker.
 * What it does: Refreshes access tokens using refresh_token and retries 401 requests once.
 * Connections: Used by API handlers in handlers.js; depends on authStorage.js and jwt.js.
 */

async function notifyAuthRequired(message) {
  try {
    chrome.runtime.sendMessage({ type: "AUTH_REQUIRED", message: message || "Please sign in again" });
  } catch (_) {}
}

async function refreshAccessToken(baseUrl) {
  const auth = await getAuthState();
  if (!auth.refreshToken) return { ok: false, error: "No refresh token" };

  let res;
  try {
    res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: auth.refreshToken }),
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : "Network error" };
  }

  if (!res.ok) {
    let errText = "Unable to refresh session";
    try {
      const e = await res.json();
      if (e && e.error) errText = e.error;
    } catch (_) {}
    return { ok: false, error: errText };
  }

  const data = await res.json().catch(() => ({}));
  if (!data || !data.access_token) return { ok: false, error: "Invalid refresh response" };
  await setAuthState({ authToken: data.access_token, refreshToken: data.refresh_token || "" });
  return { ok: true, accessToken: data.access_token };
}

async function fetchWithAuthRetry(baseUrl, url, options) {
  const auth = await getAuthState();
  if (!auth.authToken) {
    return { ok: false, status: 0, error: "Not connected" };
  }

  const expMs = getJwtExpMs(auth.authToken);
  if (expMs && expMs - Date.now() < 2 * 60 * 1000) {
    const refreshed0 = await refreshAccessToken(baseUrl);
    if (refreshed0.ok && refreshed0.accessToken) {
      const auth2 = await getAuthState();
      auth.authToken = auth2.authToken || refreshed0.accessToken;
    } else {
      await clearAuthState();
      await notifyAuthRequired("Session expired. Please sign in again.");
      return { ok: false, status: 401, error: refreshed0.error || "Session expired" };
    }
  }

  const headers = Object.assign(
    { "Content-Type": "application/json", Authorization: `Bearer ${auth.authToken}` },
    (options && options.headers) || {}
  );

  let response;
  try {
    response = await fetch(url, Object.assign({}, options || {}, { headers }));
  } catch (err) {
    return { ok: false, status: 0, error: err && err.message ? err.message : "Network error" };
  }

  if (response.status !== 401) {
    return response;
  }

  const refreshed = await refreshAccessToken(baseUrl);
  if (!refreshed.ok) {
    await clearAuthState();
    await notifyAuthRequired("Session expired. Please sign in again.");
    return response;
  }

  const retryHeaders = Object.assign(
    { "Content-Type": "application/json", Authorization: `Bearer ${refreshed.accessToken}` },
    (options && options.headers) || {}
  );
  try {
    return await fetch(url, Object.assign({}, options || {}, { headers: retryHeaders }));
  } catch (err) {
    return { ok: false, status: 0, error: err && err.message ? err.message : "Network error" };
  }
}

