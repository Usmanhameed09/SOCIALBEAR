// Open side panel on icon click
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// Listen for messages from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "MODERATE_TEXT") {
    handleModeration(message.data).then(sendResponse);
    return true; // keep channel open for async
  }

  if (message.type === "FETCH_CONFIG") {
    handleFetchConfig().then(sendResponse);
    return true;
  }

  if (message.type === "UPDATE_LOG") {
    handleUpdateLog(message.data).then(sendResponse);
    return true;
  }
 
  if (message.type === "UPDATE_COUNTERS") {
    handleUpdateCounters(message.data)
      .then(sendResponse)
      .catch((err) => {
        console.error("[SproutMod] Counters handler error:", err);
        sendResponse({ success: false, error: err && err.message ? err.message : "Handler error" });
      });
    return true;
  }

  if (message.type === "GET_AUTH") {
    chrome.storage.local.get(["apiBaseUrl", "authToken"], (data) => {
      sendResponse(data);
    });
    return true;
  }

  // ─── NEW: Fetch last_checked_timestamp from server ───
  if (message.type === "GET_LAST_TIMESTAMP") {
    handleGetLastTimestamp().then(sendResponse);
    return true;
  }

  // ─── NEW: Save last_checked_timestamp to server ───
  if (message.type === "SAVE_LAST_TIMESTAMP") {
    handleSaveLastTimestamp(message.data).then(sendResponse);
    return true;
  }
});

async function getAuthHeaders() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken"], (data) => {
      const headers = { "Content-Type": "application/json" };
      if (data && data.authToken) {
        headers.Authorization = `Bearer ${data.authToken}`;
      }
      resolve(headers);
    });
  });
}

async function getAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken", "refreshToken"], (data) => {
      resolve({
        authToken: (data && data.authToken) || "",
        refreshToken: (data && data.refreshToken) || "",
      });
    });
  });
}

async function setAuthState({ authToken, refreshToken }) {
  return new Promise((resolve) => {
    const update = {};
    if (typeof authToken === "string") update.authToken = authToken;
    if (typeof refreshToken === "string") update.refreshToken = refreshToken;
    chrome.storage.local.set(update, resolve);
  });
}

async function clearAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["authToken", "refreshToken"], resolve);
  });
}

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

async function getBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiBaseUrl"], (data) => {
      resolve(data.apiBaseUrl || "http://localhost:3000");
    });
  });
}

async function handleModeration(data) {
  try {
    const baseUrl = await getBaseUrl();
    const response = await fetchWithAuthRetry(baseUrl, `${baseUrl}/api/moderate`, {
      method: "POST",
      body: JSON.stringify({
        message_text: data.text,
        message_id: data.messageId,
        platform: data.platform || "unknown",
      }),
    });

    if (!response || typeof response.json !== "function") {
      return { success: false, error: response && response.error ? response.error : "API error" };
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: err.error || `HTTP ${response.status}` };
    }

    const result = await response.json();
    try {
      console.log(
        "[SproutMod] Moderate result:",
        "flagged=", !!result.flagged,
        "action=", result.action,
        "category=", result.highest_category || "",
        "score=", result.highest_score || result.confidence || 0
      );
    } catch (_) {}
    return { success: true, data: result };
  } catch (err) {
    console.error("[SproutMod] Moderation error:", err);
    return { success: false, error: err.message };
  }
}

async function handleFetchConfig() {
  try {
    const baseUrl = await getBaseUrl();
    const auth = await getAuthState();
    if (!auth.authToken) {
      return { success: false, error: "Not connected" };
    }
    const response = await fetchWithAuthRetry(baseUrl, `${baseUrl}/api/config?ts=${Date.now()}`, { cache: "no-store" });

    if (!response || typeof response.json !== "function") {
      return { success: false, error: response && response.error ? response.error : "Failed to fetch config" };
    }

    if (!response.ok) {
      let errText = "Failed to fetch config";
      try {
        const ejson = await response.json();
        errText = ejson && ejson.error ? ejson.error : errText;
      } catch (_) {
        try {
          errText = await response.text();
        } catch (_) {}
      }
      const latestAuth = await getAuthState();
      const uid = getUidFromJwt(latestAuth.authToken || auth.authToken);
      return new Promise((resolve) => {
        chrome.storage.local.get(["cachedConfig_" + uid], (data) => {
          if (data["cachedConfig_" + uid]) {
            console.warn("[SproutMod] Using cached config (HTTP " + response.status + ")");
            resolve({ success: true, data: data["cachedConfig_" + uid], cached: true });
          } else {
            resolve({ success: false, error: errText });
          }
        });
      });
    }

    const config = await response.json();

    // Cache per-user as fallback only
    try {
      const latestAuth = await getAuthState();
      var uid = getUidFromJwt(latestAuth.authToken || auth.authToken);
      chrome.storage.local.set({ ["cachedConfig_" + uid]: config });
    } catch (_) {}

    return { success: true, data: config };
  } catch (err) {
    // Network error - use cached config
    try {
      const auth = await getAuthState();
      var uid2 = getUidFromJwt(auth.authToken);
      return new Promise((resolve) => {
        chrome.storage.local.get(["cachedConfig_" + uid2], (data) => {
          if (data["cachedConfig_" + uid2]) {
            console.warn("[SproutMod] Using cached config (network error)");
            resolve({ success: true, data: data["cachedConfig_" + uid2], cached: true });
          } else {
            resolve({ success: false, error: err.message });
          }
        });
      });
    } catch (_) {
      return { success: false, error: err.message };
    }
  }
}

async function handleUpdateLog(data) {
  try {
    const baseUrl = await getBaseUrl();
    const response = await fetchWithAuthRetry(baseUrl, `${baseUrl}/api/logs`, {
      method: "POST",
      body: JSON.stringify(data),
    });

    if (!response || typeof response.json !== "function") {
      return { success: false, error: response && response.error ? response.error : "API error" };
    }
    return { success: response.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleUpdateCounters(data) {
  try {
    const baseUrl = await getBaseUrl();
    const response = await fetchWithAuthRetry(baseUrl, `${baseUrl}/api/counters`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!response || typeof response.json !== "function") {
      return { success: false, error: response && response.error ? response.error : "API error" };
    }
    if (!response.ok) {
      let err = null;
      try {
        err = await response.json();
      } catch (_) {
        try {
          err = { error: await response.text() };
        } catch (_) {
          err = { error: "Unknown error" };
        }
      }
      console.error("[SproutMod] Counters API error:", response.status, err && err.error);
      return { success: false, error: err && err.error ? err.error : `HTTP ${response.status}` };
    }
    console.log("[SproutMod] Counters API success");
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── NEW: Fetch last_checked_timestamp from moderation_counters ───
async function handleGetLastTimestamp() {
  try {
    const baseUrl = await getBaseUrl();
    const response = await fetchWithAuthRetry(baseUrl, `${baseUrl}/api/counters/last-timestamp`, {
      method: "GET",
    });

    if (!response || typeof response.json !== "function") {
      return { success: false, error: response && response.error ? response.error : "API error" };
    }
    if (!response.ok) {
      console.warn("[SproutMod] Failed to fetch last_checked_timestamp, HTTP", response.status);
      return { success: false, error: "HTTP " + response.status };
    }

    const result = await response.json();
    console.log("[SproutMod] Fetched last_checked_timestamp:", result.last_checked_timestamp);
    return { success: true, last_checked_timestamp: result.last_checked_timestamp || 0 };
  } catch (err) {
    console.error("[SproutMod] Error fetching last_checked_timestamp:", err);
    return { success: false, error: err.message };
  }
}

// ─── NEW: Save last_checked_timestamp to moderation_counters ───
async function handleSaveLastTimestamp(data) {
  try {
    const baseUrl = await getBaseUrl();
    const response = await fetchWithAuthRetry(baseUrl, `${baseUrl}/api/counters/last-timestamp`, {
      method: "POST",
      body: JSON.stringify({ last_checked_timestamp: data.last_checked_timestamp }),
    });

    if (!response || typeof response.json !== "function") {
      return { success: false, error: response && response.error ? response.error : "API error" };
    }
    if (!response.ok) {
      console.warn("[SproutMod] Failed to save last_checked_timestamp, HTTP", response.status);
      return { success: false, error: "HTTP " + response.status };
    }

    console.log("[SproutMod] Saved last_checked_timestamp:", data.last_checked_timestamp);
    return { success: true };
  } catch (err) {
    console.error("[SproutMod] Error saving last_checked_timestamp:", err);
    return { success: false, error: err.message };
  }
}
