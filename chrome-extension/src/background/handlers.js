/*
 * Responsibility: API request handlers for the background service worker message bus.
 * What it does: Implements message handlers invoked by content scripts and UI (moderation, config, logs, counters, timestamps).
 * Connections: Called by background.js runtime message listener; uses baseUrl.js and authRefresh.js for authenticated requests.
 */

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
        "flagged=",
        !!result.flagged,
        "action=",
        result.action,
        "category=",
        result.highest_category || "",
        "score=",
        result.highest_score || result.confidence || 0
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

