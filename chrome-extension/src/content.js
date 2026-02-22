// ====================================================
// Sprout Social AI Moderator — Content Script v5.1
// Timestamp-based iteration: only processes comments
// newer than last_checked_timestamp from the database.
// Counters reset to 0 each scan cycle.
// ====================================================

(function () {
  "use strict";

  const PROCESSED_ATTR = "data-sproutmod-processed";
  const BADGE_CLASS = "sproutmod-badge";
  const POLL_INTERVAL = 6000;
  const CONFIG_REFRESH_INTERVAL = 10000;
  const STORAGE_KEY_PREFIX = "sproutmod_actions_v5_";

  let currentUserId = null;
  let config = null;
  let isScanning = false;

  // ─── Timestamp gate: fetched ONCE at init from server, then maintained locally ───
  let lastCheckedTimestamp = 0;
  let timestampLoaded = false;

  // actions = { guid: { action: "hidden"|"flagged"|"clean"|"sent", category: "...", confidence: 0.9, keyword: null|"...", ts: 123 } }
  let actions = {};

  let stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "initializing" };
  let lastCountersSent = null;
  let configRetryCount = 0;

  // ===================== PERSISTENCE =====================

  function getStorageKey() {
    return STORAGE_KEY_PREFIX + (currentUserId || "default");
  }

  async function loadActions() {
    return new Promise((resolve) => {
      var key = getStorageKey();
      chrome.storage.local.get([key], (data) => {
        if (data[key]) {
          try {
            actions = JSON.parse(data[key]);
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            let pruned = 0;
            for (const guid of Object.keys(actions)) {
              if (actions[guid].ts && actions[guid].ts < cutoff) {
                delete actions[guid];
                pruned++;
              }
            }
            if (pruned > 0) saveActions();
            console.log("[SproutMod] Loaded", Object.keys(actions).length, "actions for user:", currentUserId || "default");
          } catch (e) {
            actions = {};
          }
        } else {
          actions = {};
        }
        resolve();
      });
    });
  }

  function saveActions() {
    var key = getStorageKey();
    chrome.storage.local.set({ [key]: JSON.stringify(actions) });
  }

  function recordAction(guid, data) {
    actions[guid] = { ...data, ts: Date.now() };
    saveActions();
  }

  function getAction(guid) {
    return actions[guid] || null;
  }

  // ===================== TIMESTAMP HELPERS =====================

  async function fetchLastCheckedTimestamp() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_LAST_TIMESTAMP" }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
          console.warn("[SproutMod] Could not fetch last_checked_timestamp, defaulting to 0");
          resolve(0);
          return;
        }
        resolve(Number(response.last_checked_timestamp) || 0);
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

  // ===================== CONFIG =====================

  var prevConfigFingerprint = null;

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
            console.log("[SproutMod] ⚡ Config CHANGED — full re-scan");
            document.querySelectorAll("[" + PROCESSED_ATTR + "]").forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
            document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
            actions = {};
            saveActions();
            stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "running" };
            lastCountersSent = null;
            // DO NOT reset lastCheckedTimestamp or timestampLoaded here
            // Config change means re-evaluate visible cards, but timestamp gate still applies
            isScanning = false;
            setTimeout(function () { scan(); }, 500);
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

  // ===================== DOM HELPERS =====================

  function getAllMessageRows() {
    return document.querySelectorAll('[data-qa-inbox-list-row="true"]');
  }

  function getGuid(row) {
    var el = row.querySelector("[data-qa-guid]");
    return el ? el.getAttribute("data-qa-guid") : null;
  }

  function getText(row) {
    var el = row.querySelector("[data-qa-message-text]");
    if (!el) return "";
    return el.getAttribute("data-qa-message-text") || "";
  }

  function isSent(row) {
    var el = row.querySelector("[data-qa-message-sent]");
    return el ? el.getAttribute("data-qa-message-sent") === "true" : false;
  }

  function getPlatform(row) {
    var el = row.querySelector("[data-qa-message-network]");
    if (!el) return "unknown";
    var net = el.getAttribute("data-qa-message-network") || "unknown";
    var map = {
      facebook: "facebook",
      fb_instagram_account: "instagram",
      twitter: "twitter",
      youtube: "youtube",
      tiktok: "tiktok",
      threads: "threads",
      linkedin: "linkedin"
    };
    return map[net] || net;
  }

  function getMsgType(row) {
    var el = row.querySelector("[data-qa-message-type]");
    return el ? el.getAttribute("data-qa-message-type") : "unknown";
  }
  function isComment(row) {
    var t = (getMsgType(row) || "").toLowerCase();
    return t.indexOf("comment") !== -1;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isVisible(el) {
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return false;
    var cs = window.getComputedStyle(el);
    if (!cs) return false;
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return true;
  }

  function getVisibleMenuContainers() {
    var menus = Array.prototype.slice.call(document.querySelectorAll('[role="menu"], ul[role="menu"]'));
    return menus.filter(isVisible);
  }

  function collectVisibleMenuItems() {
    var qaItems = [];
    var roleItems = [];
    var containers = getVisibleMenuContainers();
    for (var i = 0; i < containers.length; i++) {
      qaItems = qaItems.concat(Array.prototype.slice.call(containers[i].querySelectorAll("[data-qa-menu-item]")).filter(isVisible));
      roleItems = roleItems.concat(Array.prototype.slice.call(containers[i].querySelectorAll('[role="menuitem"]')).filter(isVisible));
    }
    if (qaItems.length === 0 && roleItems.length === 0) {
      qaItems = Array.prototype.slice.call(document.querySelectorAll("[data-qa-menu-item]")).filter(isVisible);
      roleItems = Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"]')).filter(isVisible);
    }
    return { qaItems: qaItems, roleItems: roleItems };
  }

  async function waitForVisibleMenuItems(maxWaitMs) {
    var start = Date.now();
    while (Date.now() - start < (maxWaitMs || 1200)) {
      var coll = collectVisibleMenuItems();
      var qa = coll.qaItems;
      var role = coll.roleItems;
      if (qa.length > 0 || role.length > 0) {
        return { qaItems: qa, roleItems: role };
      }
      await sleep(100 + Math.random() * 50);
    }
    return { qaItems: [], roleItems: [] };
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

  // ===================== BADGE =====================

  function addBadge(row, label, confidence, isKeyword) {
    var existing = row.querySelectorAll("." + BADGE_CLASS);
    existing.forEach(function (b) { b.remove(); });

    var pct = Math.round(confidence * 100);
    var level = confidence >= 0.7 ? "sproutmod-high" : confidence >= 0.4 ? "sproutmod-medium" : "sproutmod-low";

    var badge = document.createElement("div");
    badge.className = BADGE_CLASS;
    badge.innerHTML =
      '<div class="sproutmod-badge-inner ' + level + '">' +
        '<span class="sproutmod-badge-icon">' + (isKeyword ? "\uD83D\uDD11" : "\uD83D\uDEE1\uFE0F") + "</span>" +
        '<span class="sproutmod-badge-label">' + (isKeyword ? "KW: " : "") + label + "</span>" +
        '<span class="sproutmod-badge-conf">' + pct + "%</span>" +
      "</div>";

    var body = row.querySelector('[data-qa-message-body="true"]');
    if (body) {
      body.style.position = "relative";
      body.appendChild(badge);
    } else {
      row.style.position = "relative";
      row.appendChild(badge);
    }

    var outer = row.querySelector("[data-qa-thread-item]") || row;
    outer.style.borderLeft = confidence >= 0.7 ? "4px solid #ef4444" : confidence >= 0.4 ? "4px solid #f59e0b" : "4px solid #22c55e";
    outer.style.paddingLeft = "8px";
  }

  // ===================== CLICK HIDE =====================

  var HIDE_MENU_ITEMS = [
    "Hide on Facebook",
    "Hide on Instagram",
    "Hide on Twitter",
    "Hide on X",
    "Hide on X (Twitter)",
    "Hide on Twitter/X",
    "Hide Reply on X",
    "Hide Reply on Twitter",
    "Hide Message on X",
    "Hide Message on Twitter",
    "Hide on YouTube",
    "Hide on TikTok",
    "Hide on LinkedIn",
    "Hide on Threads",
    "Hide on FB",
    "Hide on IG",
    "Hide on Meta",
    "Hide comment on Facebook",
    "Hide comment on Instagram",
    "Hide reply on Facebook",
    "Hide reply on Instagram",
    "Hide Comment",
    "Hide Post",
    "Hide Reply",
    "Hide this reply",
    "Hide this comment",
    "Hide message",
    "Hide",
  ];

  async function doHide(row) {
    var guid = getGuid(row);
    try { row.scrollIntoView({ block: "center" }); } catch (_) {}

    var moreBtn = row.querySelector('[data-qa-action-button="More Actions"], [aria-label="More Actions"], [aria-label="More options"], [data-qa-button="More Actions"], [data-qa-text="More actions"], [data-qa-text="More options"]');
    if (!moreBtn || moreBtn.offsetParent === null) {
      var candidates = row.querySelectorAll("button, [role='button']");
      for (var m = 0; m < candidates.length; m++) {
        var lbl = ((candidates[m].getAttribute("aria-label") || candidates[m].textContent || "").trim()).toLowerCase();
        if (lbl.indexOf("more") !== -1 || lbl === "..." || lbl.indexOf("options") !== -1) {
          moreBtn = candidates[m];
          if (moreBtn && moreBtn.offsetParent !== null) break;
        }
      }
    }
    if (!moreBtn) {
      console.warn("[SproutMod] No More Actions button for", guid);
      return false;
    }

    moreBtn.click();
    console.log("[SproutMod] Clicked More Actions for", guid);
    await sleep(800);

    var hideItem = null;

    var vis = await waitForVisibleMenuItems(1400);
    
    var qaItems = vis.qaItems;
    for (var qi = 0; qi < qaItems.length && !hideItem; qi++) {
      var val = qaItems[qi].getAttribute("data-qa-menu-item") || "";
      for (var i = 0; i < HIDE_MENU_ITEMS.length; i++) {
        if (val === HIDE_MENU_ITEMS[i]) { hideItem = qaItems[qi]; break; }
      }
    }

    if (!hideItem) {
      for (var j = 0; j < qaItems.length; j++) {
        var itemName = qaItems[j].getAttribute("data-qa-menu-item") || "";
        if (itemName.toLowerCase().startsWith("hide")) { hideItem = qaItems[j]; break; }
      }
    }

    if (!hideItem) {
      var roleItems = vis.roleItems;
      for (var k = 0; k < roleItems.length; k++) {
        var txt = (roleItems[k].textContent || "").trim();
        if (txt.toLowerCase().startsWith("hide")) {
          hideItem = roleItems[k];
          break;
        }
      }
    }

    if (!hideItem) {
      moreBtn.click();
      vis = await waitForVisibleMenuItems(1600);
      qaItems = vis.qaItems;
      for (var i2 = 0; i2 < qaItems.length && !hideItem; i2++) {
        var v2 = qaItems[i2].getAttribute("data-qa-menu-item") || "";
        for (var h = 0; h < HIDE_MENU_ITEMS.length; h++) {
          if (v2 === HIDE_MENU_ITEMS[h]) { hideItem = qaItems[i2]; break; }
        }
      }
      if (!hideItem) {
        for (var j2 = 0; j2 < qaItems.length; j2++) {
          var nm2 = qaItems[j2].getAttribute("data-qa-menu-item") || "";
          if (nm2.toLowerCase().startsWith("hide")) { hideItem = qaItems[j2]; break; }
        }
      }
      if (!hideItem) {
        var role2 = vis.roleItems;
        for (var k2 = 0; k2 < role2.length; k2++) {
          var tx2 = (role2[k2].textContent || "").trim().toLowerCase();
          if (tx2.startsWith("hide")) { hideItem = role2[k2]; break; }
        }
      }
    }

    if (hideItem) {
      hideItem.click();
      console.log("[SproutMod] HIDE clicked for", guid, "→", (hideItem.getAttribute("data-qa-menu-item") || hideItem.textContent.trim()));
      await sleep(700 + Math.random() * 300);

      var yt = document.querySelector('[data-qa-button="Hide Comment"]');
      if (yt && yt.offsetParent !== null) {
        yt.click();
        console.log("[SproutMod] Confirmed hide dialog");
        await sleep(400 + Math.random() * 200);
      } else {
        var confirms = document.querySelectorAll('[data-qa-button="confirm"], [data-qa-action="confirm"], button[class*="confirm"], [role="alertdialog"] button');
        for (var c = 0; c < confirms.length; c++) {
          if (confirms[c].offsetParent !== null) {
            confirms[c].click();
            console.log("[SproutMod] Confirmed hide dialog");
            await sleep(400 + Math.random() * 200);
            break;
          }
        }
      }
      return true;
    }

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200 + Math.random() * 100);
    document.body.click();
    console.warn("[SproutMod] Hide NOT found in dropdown for", guid);
    return false;
  }

  async function hideWithRetry(row) {
    for (var a = 0; a < 3; a++) {
      var ok = await doHide(row);
      if (ok) return true;
      await sleep(500 + a * 300 + Math.random() * 300);
      try { row.scrollIntoView({ block: "center" }); } catch (_) {}
    }
    return false;
  }

  // ===================== CLICK COMPLETE =====================

  async function doComplete(row) {
    var guid = getGuid(row);
    var btn = row.querySelector('[data-qa-action-button="Mark Complete"], [data-qa-action-button="Mark As Complete"], [aria-label="Mark Complete"], [aria-label="Mark As Complete"]');

    if (!btn) {
      btn = row.querySelector('[aria-label="Mark Complete"], [aria-label="Mark As Complete"]');
    }

    if (!btn) {
      console.log("[SproutMod] Complete button not found for", guid);
      return false;
    }

    if (btn.getAttribute("data-qa-button-isdisabled") === "true" || btn.disabled) {
      console.log("[SproutMod] Complete disabled for", guid);
      return false;
    }

    if (btn.getAttribute("data-qa-action-is-active") === "true" ||
        btn.getAttribute("data-qa-is-active") === "true" ||
        btn.getAttribute("aria-pressed") === "true" ||
        btn.getAttribute("aria-checked") === "true" ||
        ((btn.className || "").toLowerCase().indexOf("active") !== -1)) {
      console.log("[SproutMod] Already completed, skip to avoid unmark:", guid);
      return false;
    }

    btn.click();
    console.log("[SproutMod] COMPLETE clicked for", guid);
    await sleep(400 + Math.random() * 200);
    return true;
  }

  // ===================== PROCESS ONE MESSAGE =====================
  // Returns { flagged: bool, hidden: bool, completed: bool }

  async function processRow(row) {
    var result = { flagged: false, hidden: false, completed: false };
    var guid = getGuid(row);
    if (!guid) return result;

    if (isSent(row)) {
      row.setAttribute(PROCESSED_ATTR, "sent");
      recordAction(guid, { action: "sent" });
      return result;
    }

    var text = getText(row);
    if (!text || text.length < 2) {
      row.setAttribute(PROCESSED_ATTR, "empty");
      recordAction(guid, { action: "clean" });
      return result;
    }

    row.setAttribute(PROCESSED_ATTR, "processing");

    var platform = getPlatform(row);
    var msgType = getMsgType(row);
    console.log("[SproutMod] Processing [" + platform + "/" + msgType + "] \"" + text.substring(0, 50) + "\" " + guid);

    // ---------- KEYWORD CHECK ----------
    if (config && config.keywords && config.keywords.length > 0) {
      var lower = text.toLowerCase();
      for (var i = 0; i < config.keywords.length; i++) {
        var kw = config.keywords[i];
        if (lower.indexOf(kw.keyword.toLowerCase()) !== -1) {
          var rawAction = (kw.action || "badge_only").toLowerCase();
          var kwActions = rawAction.split(",").map(function (a) { return a.trim(); });

          var doBadge    = kwActions.indexOf("badge_only") !== -1;
          var doAutoHide = kwActions.indexOf("auto_hide") !== -1;
          var doComplt   = kwActions.indexOf("complete") !== -1;
          if (kwActions.indexOf("both") !== -1) { doBadge = true; doAutoHide = true; }

          console.log("[SproutMod] KW MATCH: \"" + kw.keyword + "\" → badge:" + doBadge + " hide:" + doAutoHide + " complete:" + doComplt);

          if (doBadge) {
            addBadge(row, kw.keyword, 1.0, true);
            result.flagged = true;
          }

          if (doAutoHide) {
            var hidden = await hideWithRetry(row);
            if (hidden) { result.hidden = true; }
            await sleep(300 + Math.random() * 200);
          }

          if (doComplt) {
            var completed = await doComplete(row);
            if (completed) { result.completed = true; }
          }

          var actionTaken = result.hidden ? "hidden" : (doBadge ? "flagged" : (doComplt ? "completed" : "flagged"));
          row.setAttribute(PROCESSED_ATTR, "done-kw-" + rawAction.replace(/,/g, "-"));
          recordAction(guid, { action: actionTaken, category: kw.keyword, confidence: 1.0, keyword: kw.keyword });

          if (doAutoHide && !doBadge) { result.flagged = true; }

          try {
            if (doBadge || doAutoHide) {
              chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: {
                message_id: guid, message_text: text, platform: platform,
                action_taken: result.hidden ? "hidden" : "flagged", source: "keyword"
              }});
            }
            if (result.completed) {
              chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: {
                message_id: guid, message_text: text, platform: platform,
                action_taken: "completed", source: "keyword"
              }});
            }
          } catch (_) {}
          return result;
        }
      }
    }

    // ---------- AI MODERATION ----------
    row.setAttribute(PROCESSED_ATTR, "awaiting-ai");

    var aiResult = await new Promise(function (resolve) {
      chrome.runtime.sendMessage(
        { type: "MODERATE_TEXT", data: { text: text, messageId: guid, platform: platform } },
        function (response) {
          if (chrome.runtime.lastError) {
            console.warn("[SproutMod] Runtime error:", chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response);
        }
      );
    });

    if (!aiResult || !aiResult.success) {
      console.warn("[SproutMod] API error:", aiResult && aiResult.error);
      row.setAttribute(PROCESSED_ATTR, "error");
      recordAction(guid, { action: "clean" });
      return result;
    }

    var aiData = aiResult.data;
    console.log("[SproutMod] AI result:", aiData);

    if (aiData.flagged) {
      var cat = aiData.highest_category || "flagged";
      var conf = aiData.confidence || 0.5;

      var isDryRun        = !!(config && config.dry_run_mode);
      var aiWantsHide     = !!(config && config.auto_hide_enabled);
      var aiWantsComplete = !!(config && config.auto_complete_enabled);

      var shouldHide     = aiWantsHide && !isDryRun;
      var shouldComplete = aiWantsComplete && !isDryRun;

      console.log("[SproutMod] AI FLAGGED:", cat, Math.round(conf * 100) + "%", guid,
        "→ badge:" + isDryRun + " hide:" + shouldHide + " complete:" + shouldComplete + " dry_run:" + isDryRun);

      if (isDryRun) {
        addBadge(row, cat, conf, false);
      }
      result.flagged = true;

      if (shouldHide) {
        var hidden = await hideWithRetry(row);
        if (hidden) {
          result.hidden = true;
          console.log("[SproutMod] AI HIDE success:", guid);
        } else {
          console.warn("[SproutMod] AI HIDE failed:", guid);
        }
        await sleep(300 + Math.random() * 200);
      }

      if (shouldComplete) {
        var completed = await doComplete(row);
        if (completed) { result.completed = true; }
      }

      var aiAction = result.hidden ? "hidden" : "flagged";
      row.setAttribute(PROCESSED_ATTR, "done-ai-" + aiAction);
      recordAction(guid, { action: aiAction, category: cat, confidence: conf, keyword: null });

      try {
        var payload = { message_id: guid, platform: platform, action_taken: aiAction, category: cat, confidence: conf, source: "ai" };
        if (aiResult.data && aiResult.data.log_id) payload.log_id = aiResult.data.log_id;
        chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: payload });
        if (result.completed) {
          chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: {
            message_id: guid, message_text: text, platform: platform,
            action_taken: "completed", source: "ai"
          }});
        }
      } catch (_) {}
    } else {
      console.log("[SproutMod] Clean:", guid);
      row.setAttribute(PROCESSED_ATTR, "done-clean");
      recordAction(guid, { action: "clean" });
    }

    return result;
  }

  // ===================== SCANNER =====================

  function restoreAction(row, data) {
    var action = data.action || "clean";
    row.setAttribute(PROCESSED_ATTR, "restored-" + action);

    if (action === "clean" || action === "sent" || action === "empty") return;

    var label = data.keyword || data.category || "Flagged";
    var conf = data.confidence || 1.0;
    var isKw = !!data.keyword;

    addBadge(row, label, conf, isKw);
  }

  async function checkForNewMessagesButton() {
    var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
    if (newMsgBtn && isVisible(newMsgBtn)) {
      console.log("[SproutMod] Found 'New Messages' notification, clicking...");
      newMsgBtn.click();
      await sleep(2500); // Wait for content to load
      
      console.log("[SproutMod] Restarting scan (New Messages clicked)...");
      isScanning = false;
      scan();
      return true;
    }
    return false;
  }

  async function scan() {
    if (!config) return;
    if (isScanning) return;
    isScanning = true;

    // ─── Fresh counters for this scan cycle ───
    var scanCount = 0;      // only counts ACTUALLY PROCESSED (new) cards
    var flaggedCount = 0;
    var hiddenCount = 0;
    var completedCount = 0;
    var skippedCount = 0;

    try {
      // ─── Fetch timestamp from server ONCE, then use local copy ───
      if (!timestampLoaded) {
        var serverTs = await fetchLastCheckedTimestamp();
        lastCheckedTimestamp = serverTs;
        timestampLoaded = true;
        console.log("[SproutMod] Fetched last_checked_timestamp from server:", lastCheckedTimestamp);
      }

      // ─── Get all comment rows ───
      var rows = getAllMessageRows();
      var commentRows = [];
      for (var i0 = 0; i0 < rows.length; i0++) {
        if (isComment(rows[i0])) commentRows.push(rows[i0]);
      }

      // ─── Quick exit: nothing unprocessed in DOM ───
      var hasUnprocessed = false;
      for (var chk = 0; chk < commentRows.length; chk++) {
        if (!commentRows[chk].hasAttribute(PROCESSED_ATTR)) {
          hasUnprocessed = true;
          break;
        }
      }
      if (!hasUnprocessed) {
        // Even if no unprocessed items, check for "New Messages" button
        if (await checkForNewMessagesButton()) return;
        isScanning = false;
        return;
      }

      // ─── Find the highest timestamp in the current DOM ───
      // If DB timestamp >= highest card timestamp, ALL cards are old → skip entire scan
      // BUT: We must check if any "old" card is actually unbadged (re-rendered).
      // If it's unbadged but we have a cached action, we should restore it.
      var highestCardTimestamp = 0;
      for (var t = 0; t < commentRows.length; t++) {
        var ts = getTimestamp(commentRows[t]);
        if (ts > highestCardTimestamp) highestCardTimestamp = ts;
      }

      var allOld = (lastCheckedTimestamp > 0 && highestCardTimestamp > 0 && highestCardTimestamp <= lastCheckedTimestamp);

      if (allOld) {
        console.log("[SproutMod] All cards seem old (highest:", highestCardTimestamp, "≤ db:", lastCheckedTimestamp, ")");
        
        // Check for "New Messages" button before skipping
        if (await checkForNewMessagesButton()) return;

        // Instead of blindly skipping, check if we have cached actions for them
        var anyRestored = false;
        for (var s = 0; s < commentRows.length; s++) {
          if (commentRows[s].hasAttribute(PROCESSED_ATTR)) continue;
          
          var g = getGuid(commentRows[s]);
          if (g && actions[g]) {
             // We have processed this before! Restore badge/state.
             restoreAction(commentRows[s], actions[g]);
             anyRestored = true;
          } else {
             // Truly old and unknown? Or maybe we missed it?
             // If we missed it, we should probably process it.
             // But if we process it, we might duplicate logs?
             // For now, if it's old and NOT in actions, we assume it was processed before we started tracking actions or clean.
             // Safest is to mark as skipped-old to avoid infinite loops on old stuff.
             commentRows[s].setAttribute(PROCESSED_ATTR, "skipped-old");
          }
        }
        
        if (anyRestored) {
          console.log("[SproutMod] Restored cached actions for re-rendered old items");
        }

        isScanning = false;
        return;
      }

      var highestProcessedTimestamp = lastCheckedTimestamp;

      // ─── Loop through each comment card sequentially ───
      for (var i = 0; i < commentRows.length; i++) {
        var row = commentRows[i];
        var guid = getGuid(row);
        if (!guid) continue;

        // Already processed in DOM — skip completely
        if (row.hasAttribute(PROCESSED_ATTR)) continue;

        // Extract timestamp
        var cardTimestamp = getTimestamp(row);

        // Timestamp gate: skip old cards
        if (cardTimestamp > 0 && lastCheckedTimestamp > 0 && cardTimestamp <= lastCheckedTimestamp) {
          var cached = actions[guid];
          if (cached) {
            restoreAction(row, cached);
          } else {
            row.setAttribute(PROCESSED_ATTR, "skipped-old");
          }
          skippedCount++;
          continue;
        }

        // ─── This is a NEW card — process it ───
        scanCount++;
        console.log("[SproutMod] NEW:", guid, "ts:", cardTimestamp);

        try {
          var outcome = await processRow(row);
          if (outcome.flagged)   flaggedCount++;
          if (outcome.hidden)    hiddenCount++;
          if (outcome.completed) completedCount++;
        } catch (rowErr) {
          console.warn("[SproutMod] Error processing row:", guid, rowErr);
          row.setAttribute(PROCESSED_ATTR, "error");
        }

        // Track highest
        if (cardTimestamp > highestProcessedTimestamp) {
          highestProcessedTimestamp = cardTimestamp;
        }

        await sleep(300);
      }

      // ─── Save highest timestamp locally + to server ───
      if (highestProcessedTimestamp > lastCheckedTimestamp) {
        lastCheckedTimestamp = highestProcessedTimestamp;
        console.log("[SproutMod] Updated last_checked_timestamp:", lastCheckedTimestamp);
        saveLastCheckedTimestamp(highestProcessedTimestamp); // fire-and-forget
      }

      // ─── Update stats ONLY if we actually processed new cards ───
      if (scanCount > 0) {
        stats.scanned = scanCount;
        stats.flagged = flaggedCount;
        stats.hidden = hiddenCount;
        stats.completed = completedCount;
        stats.lastScan = new Date().toISOString();

        console.log("[SproutMod] ═══════════════════════════════════");
        console.log("[SproutMod]  Scan Complete");
        console.log("[SproutMod]  Processed:  " + scanCount);
        console.log("[SproutMod]  Skipped:    " + skippedCount);
        console.log("[SproutMod]  Flagged:    " + flaggedCount);
        console.log("[SproutMod]  Hidden:     " + hiddenCount);
        console.log("[SproutMod]  Completed:  " + completedCount);
        console.log("[SproutMod]  Timestamp:  " + lastCheckedTimestamp);
        console.log("[SproutMod] ═══════════════════════════════════");

        broadcastStats();

        // Send counters to server
        try {
          var currentTotals = {
            total_processed: scanCount,
            flagged_total: flaggedCount,
            auto_hidden_total: hiddenCount,
            completed_total: completedCount,
          };
          chrome.runtime.sendMessage(
            { type: "UPDATE_COUNTERS", data: currentTotals },
            function (response) {
              if (chrome.runtime.lastError) return;
              if (response && response.success) {
                lastCountersSent = currentTotals;
                console.log("[SproutMod] Counters updated");
              }
            }
          );
        } catch (_) {}
      } else if (skippedCount > 0) {
        console.log("[SproutMod] Scan: all", skippedCount, "cards skipped (already processed)");
      }

      // ─── Check for "New Messages" button at the end ───
      if (await checkForNewMessagesButton()) return;

    } catch (scanErr) {
      console.error("[SproutMod] Scan error:", scanErr);
    } finally {
      isScanning = false;
    }
  }

  function broadcastStats() {
    try {
      chrome.runtime.sendMessage({ type: "STATS_UPDATE", data: stats });
    } catch (e) { /* popup closed */ }
  }

  // ===================== OBSERVER =====================
  // IMPORTANT: Ignore mutations caused by our own badge injection

  var debounceTimer = null;
  var ignoreMutations = false;

  function startObserver() {
    var target =
      document.querySelector('[data-qa-name="message-list"]') ||
      document.querySelector('[data-qa-status]') ||
      document.querySelector("main") ||
      document.body;

    var observer = new MutationObserver(function (mutations) {
      // Ignore mutations we caused (badge injection, attribute changes)
      if (ignoreMutations) return;

      // Check if any mutation is NOT from our badge/attribute changes
      var isOurChange = true;
      for (var m = 0; m < mutations.length; m++) {
        var mut = mutations[m];
        if (mut.type === "attributes" && mut.attributeName === PROCESSED_ATTR) continue;
        if (mut.type === "childList") {
          // Check if added nodes are our badges
          var hasNonBadge = false;
          for (var n = 0; n < mut.addedNodes.length; n++) {
            var node = mut.addedNodes[n];
            if (node.nodeType === 1 && node.classList && node.classList.contains(BADGE_CLASS)) continue;
            hasNonBadge = true;
            break;
          }
          if (hasNonBadge) { isOurChange = false; break; }
        } else {
          isOurChange = false;
          break;
        }
      }
      if (isOurChange) return;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        var rows = getAllMessageRows();
        var hasNew = false;
        for (var i = 0; i < rows.length; i++) {
          if (!rows[i].hasAttribute(PROCESSED_ATTR)) {
            hasNew = true;
            break;
          }
        }
        
        // Also check for New Messages button
        var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
        var hasButton = newMsgBtn && isVisible(newMsgBtn);

        if (hasNew || hasButton) {
          console.log("[SproutMod] Observer: genuinely new items or New Messages button detected");
          scan();
        }
      }, 1200);
    });

    observer.observe(target, { childList: true, subtree: true, attributes: false });
    console.log("[SproutMod] Observer watching:", target.className ? target.className.substring(0, 40) : target.tagName);
    return observer;
  }

  // ===================== POLLING =====================

  function startPolling() {
    setInterval(function () {
      var rows = getAllMessageRows();
      var hasNew = false;
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].hasAttribute(PROCESSED_ATTR)) {
          hasNew = true;
          break;
        }
      }
      
      // Also check for New Messages button
      var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
      var hasButton = newMsgBtn && isVisible(newMsgBtn);

      if (hasNew || hasButton) {
        console.log("[SproutMod] Poll: found unprocessed items or New Messages button");
        scan();
      }
    }, POLL_INTERVAL);
  }

  // ===================== MESSAGE LISTENER =====================

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
      scan();
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
      scan();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "CONFIG_UPDATED") {
      loadConfig();
      sendResponse({ ok: true });
      return true;
    }
  });

  // ===================== INIT =====================

  async function init() {
    console.log("[SproutMod] ========================================");
    console.log("[SproutMod]  Sprout Social AI Moderator v5.1");
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
    await scan();
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
})();