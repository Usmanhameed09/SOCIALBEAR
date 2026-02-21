

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
      return { success: false, error: "Failed to fetch config" };
    }

    const config = await response.json();
    // Cache config locally
    chrome.storage.local.set({ cachedConfig: config, configUpdatedAt: Date.now() });
    return { success: true, data: config };
  } catch (err) {
    // Return cached config if available
    return new Promise((resolve) => {
      chrome.storage.local.get(["cachedConfig"], (data) => {
        if (data.cachedConfig) {
          resolve({ success: true, data: data.cachedConfig, cached: true });
        } else {
          resolve({ success: false, error: err.message });
        }
      });
    });
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
