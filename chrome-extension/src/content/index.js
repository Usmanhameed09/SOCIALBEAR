/*
 * Responsibility: Content script entrypoint for the Sprout inbox page.
 * What it does: Wires runtime message handling (manual scan/reset/config refresh) and boots the scanner lifecycle.
 * Connections: Loaded last by manifest.json after src/content/*.js modules; relies on globals from state.js, scanner.js, config.js, and persistence.js.
 */

"use strict";

window.__sproutmod_modular_v53 = true;

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg.type === "GET_STATS") {
    sendResponse(stats);
    return true;
  }
  if (msg.type === "MANUAL_SCAN") {
    console.log("[SproutMod] Manual rescan");
    document.querySelectorAll("[" + PROCESSED_ATTR + "]").forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
    document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
    lastCheckedTimestamp = 0;
    timestampLoaded = false; // Re-fetch from server
    fullScanComplete = false;
    scan("full");
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "FULL_RESET") {
    console.log("[SproutMod] Full reset");
    actions = {};
    saveActions();
    document.querySelectorAll("[" + PROCESSED_ATTR + "]").forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
    document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
    lastCheckedTimestamp = 0;
    timestampLoaded = false; // Re-fetch from server
    fullScanComplete = false;
    scan("full");
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === "CONFIG_UPDATED") {
    loadConfig();
    sendResponse({ ok: true });
    return true;
  }
});

async function init() {
  console.log("[SproutMod] ========================================");
  console.log("[SproutMod]  Sprout Social AI Moderator v5.3");
  console.log("[SproutMod]  Timestamp-gated processing");
  console.log("[SproutMod] ========================================");

  await new Promise(function (resolve) {
    chrome.runtime.sendMessage({ type: "GET_AUTH" }, function (data) {
      if (chrome.runtime.lastError || !data) { resolve(); return; }
      if (data.authToken) {
        try {
          var parts = data.authToken.split(".");
          if (parts.length === 3) {
            var payload = JSON.parse(atob(parts[1]));
            currentUserId = payload.sub || null;
            console.log("[SproutMod] User ID:", currentUserId);
          }
        } catch (e) {
          console.warn("[SproutMod] Could not parse token for user ID");
        }
      }
      resolve();
    });
  });

  await loadActions();

  for (var i = 0; i < 30; i++) {
    if (document.querySelectorAll('[data-qa-inbox-list-row]').length > 0) break;
    await sleep(1000 + Math.random() * 500);
  }

  await loadConfig();

  if (config) {
    var cleaned = 0;
    var currentKeywords = {};
    if (config.keywords) {
      for (var ci = 0; ci < config.keywords.length; ci++) {
        currentKeywords[config.keywords[ci].keyword.toLowerCase()] = config.keywords[ci];
      }
    }
    for (var g in actions) {
      var a = actions[g];
      if (a && a.keyword && !currentKeywords[a.keyword.toLowerCase()]) {
        delete actions[g];
        cleaned++;
      }
    }
    if (cleaned > 0) {
      saveActions();
      console.log("[SproutMod] Cleaned", cleaned, "stale keyword actions");
    }
  }

  if (!config) {
    console.warn("[SproutMod] No config — log in via extension popup");
    stats.status = "no_config";
    broadcastStats();
    startObserver();
    startPolling();
    setInterval(async function () { if (!config) await loadConfig(); }, CONFIG_REFRESH_INTERVAL);
    return;
  }

  stats.status = "running";
  fullScanComplete = false;
  await scan("full");
  startObserver();
  startPolling();
  setInterval(loadConfig, CONFIG_REFRESH_INTERVAL);

  console.log("[SproutMod] System active.");
  broadcastStats();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 3000); });
} else {
  setTimeout(init, 3000);
}
