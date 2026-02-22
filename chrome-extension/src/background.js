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
      resolve({
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.authToken || ""}`,
      });
    });
  });
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
    const headers = await getAuthHeaders();

    const response = await fetch(`${baseUrl}/api/moderate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        message_text: data.text,
        message_id: data.messageId,
        platform: data.platform || "unknown",
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { success: false, error: err.error || "API error" };
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
    const headers = await getAuthHeaders();

    const response = await fetch(`${baseUrl}/api/config`, { headers });

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
      try {
        var t = (headers.Authorization || "").replace("Bearer ", "");
        var uid = "default";
        if (t) { var p = JSON.parse(atob(t.split(".")[1])); uid = p.sub || "default"; }
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
      } catch (_) {
        return { success: false, error: errText };
      }
    }

    const config = await response.json();

    // Cache per-user as fallback only
    try {
      var t = (headers.Authorization || "").replace("Bearer ", "");
      var uid = "default";
      if (t) { var p = JSON.parse(atob(t.split(".")[1])); uid = p.sub || "default"; }
      chrome.storage.local.set({ ["cachedConfig_" + uid]: config });
    } catch (_) {}

    return { success: true, data: config };
  } catch (err) {
    // Network error - use cached config
    try {
      var h = await getAuthHeaders();
      var t2 = (h.Authorization || "").replace("Bearer ", "");
      var uid2 = "default";
      if (t2) { var p2 = JSON.parse(atob(t2.split(".")[1])); uid2 = p2.sub || "default"; }
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
    const headers = await getAuthHeaders();

    const response = await fetch(`${baseUrl}/api/logs`, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });

    return { success: response.ok };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function handleUpdateCounters(data) {
  try {
    const baseUrl = await getBaseUrl();
    const headers = await getAuthHeaders();
    const response = await fetch(`${baseUrl}/api/counters`, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
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
    const headers = await getAuthHeaders();

    const response = await fetch(`${baseUrl}/api/counters/last-timestamp`, {
      method: "GET",
      headers,
    });

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
    const headers = await getAuthHeaders();

    const response = await fetch(`${baseUrl}/api/counters/last-timestamp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ last_checked_timestamp: data.last_checked_timestamp }),
    });

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