/*
 * Responsibility: Remote config + timestamp-gate coordination for the content script.
 * What it does: Fetches config via background, maintains last_checked_timestamp via background, and normalizes config values.
 * Connections: scan/moderation flows read `config` and `lastCheckedTimestamp`; background.js services FETCH_CONFIG and timestamp messages.
 */

"use strict";

async function fetchLastCheckedTimestamp() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_LAST_TIMESTAMP" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        console.warn("[SproutMod] Could not fetch last_checked_timestamp, defaulting to 0");
        resolve(0);
        return;
      }

      var raw = response.last_checked_timestamp;
      var num = Number(raw) || 0;
      console.log("[SproutMod][TS] Server last_checked_timestamp:", raw, "→", num);
      if (num > 9999999999) {
        console.warn("[SproutMod][TS] last_checked_timestamp looks like milliseconds (expected seconds):", num);
        num = Math.floor(num / 1000);
        console.log("[SproutMod][TS] Normalized last_checked_timestamp to seconds:", num);
      }

      resolve(num);
    });
  });
}

async function saveLastCheckedTimestamp(ts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "SAVE_LAST_TIMESTAMP", data: { last_checked_timestamp: ts } },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[SproutMod] Could not save last_checked_timestamp:", chrome.runtime.lastError.message);
        } else if (!response || !response.success) {
          console.warn("[SproutMod] Save last_checked_timestamp failed:", response && response.error);
        } else {
          console.log("[SproutMod] last_checked_timestamp saved:", ts);
        }
        resolve();
      }
    );
  });
}

function getTimestamp(row) {
  var el = row.querySelector("[data-qa-timestamp]");
  if (!el) return 0;
  return Number(el.getAttribute("data-qa-timestamp")) || 0;
}

function buildConfigFingerprint(cfg) {
  var parts = [];
  parts.push("h:" + !!cfg.auto_hide_enabled);
  parts.push("c:" + !!cfg.auto_complete_enabled);
  parts.push("d:" + !!cfg.dry_run_mode);
  parts.push("t:" + (cfg.threshold || cfg.confidence_threshold || 0.7));
  parts.push("m:" + (cfg.ai_model || ""));
  
  if (cfg.categories && cfg.categories.length > 0) {
    var catParts = cfg.categories.map(function(c) {
      return c.key + "=" + c.threshold;
    }).sort();
    parts.push("cats:" + catParts.join("|"));
  } else {
    parts.push("cats:none");
  }

  if (cfg.keywords && cfg.keywords.length > 0) {
    var kwParts = cfg.keywords.map(function (kw) {
      return kw.keyword + "=" + (kw.action || "badge_only") + (kw.is_active === false ? ":off" : "");
    }).sort();
    parts.push("kw:" + kwParts.join("|"));
  } else {
    parts.push("kw:none");
  }
  return parts.join(";");
}

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "FETCH_CONFIG" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[SproutMod] Config error:", chrome.runtime.lastError.message);
        if (configRetryCount < 3) {
          stats.status = "initializing";
          configRetryCount++;
          setTimeout(function () { if (!config) loadConfig(); }, 800 + configRetryCount * 600);
        } else {
          stats.status = "error";
        }
        resolve(null);
        return;
      }
      if (response && response.success) {
        configRetryCount = 0;
        config = response.data;
        if (response.cached) {
          console.warn("[SproutMod] Config loaded from cache (server fetch failed)");
        }

        // Detect user switch
        var newUserId = config.user_id || null;
        if (newUserId && newUserId !== currentUserId) {
          console.log("[SproutMod] User switch:", currentUserId, "→", newUserId);
          currentUserId = newUserId;
          actions = {};
          stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "running" };
          lastCountersSent = null;
          lastCheckedTimestamp = 0;
          timestampLoaded = false;
          fullScanComplete = false;
          prevConfigFingerprint = null;
          document.querySelectorAll("[" + PROCESSED_ATTR + "]").forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
          document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
          loadActions();
        } else if (!currentUserId && newUserId) {
          currentUserId = newUserId;
        }

        // Parse booleans
        config.auto_hide_enabled = toBool(config.auto_hide_enabled);
        config.auto_complete_enabled = toBool(config.auto_complete_enabled);
        config.dry_run_mode = toBool(config.dry_run_mode);

        // Detect config change → full re-scan
        // BUT: do NOT reset timestampLoaded — we keep local timestamp
        // Only reset timestamp on MANUAL_SCAN or FULL_RESET
        var newFingerprint = buildConfigFingerprint(config);
        if (prevConfigFingerprint !== null && prevConfigFingerprint !== newFingerprint) {
          console.log("[SproutMod] ⚡ Config CHANGED — applying for future messages (no auto-scan)");
        }
        prevConfigFingerprint = newFingerprint;

        stats.status = "running";
        console.log("[SproutMod] Config loaded — user:", currentUserId,
          "keywords:", config.keywords ? config.keywords.length : 0,
          "categories:", config.categories ? config.categories.length : 0,
          "threshold:", config.threshold,
          "AI → hide:", config.auto_hide_enabled,
          "complete:", config.auto_complete_enabled,
          "dry_run:", config.dry_run_mode);
      } else {
        if (configRetryCount < 3) {
          stats.status = "initializing";
          configRetryCount++;
          console.warn("[SproutMod] Config failed — retrying:", response && response.error);
          setTimeout(function () { if (!config) loadConfig(); }, 1000 + configRetryCount * 800);
        } else {
          stats.status = "error";
          console.warn("[SproutMod] Config failed:", response && response.error);
        }
      }
      resolve(config);
    });
  });
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    var s = v.toLowerCase().trim();
    return s === "true" || s === "1" || s === "yes";
  }
  if (typeof v === "number") return v === 1;
  return !!v;
}

