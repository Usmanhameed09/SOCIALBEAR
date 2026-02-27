/*
 * Responsibility: Background service worker entrypoint.
 * What it does: Boots the background runtime (side panel behavior + message routing) and loads implementation files.
 * Connections: Receives messages from content script + UI; delegates to handlers in src/background/*.js.
 */

importScripts(
  "background/authStorage.js",
  "background/jwt.js",
  "background/authRefresh.js",
  "background/baseUrl.js",
  "background/handlers.js"
);

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
