// ====================================================
// Sprout Social AI Moderator — Content Script v5.3
// Timestamp-based iteration: only processes comments
// newer than last_checked_timestamp from the database.
// Counters reset to 0 each scan cycle.
// ====================================================

(function () {
  "use strict";

  const PROCESSED_ATTR = "data-sproutmod-processed";
  const BADGE_CLASS = "sproutmod-badge";
  const GUID_ATTR = "data-sproutmod-guid";
  const POLL_INTERVAL = 6000;
  const CONFIG_REFRESH_INTERVAL = 10000;
  const STORAGE_KEY_PREFIX = "sproutmod_actions_v5_";

  let currentUserId = null;
  let config = null;
  let isScanning = false;
  let fullScanComplete = false;
  let lastRestoreBadgesAt = 0;
  let lastNewMessagesClickAt = 0;

  // ─── Timestamp gate: fetched ONCE at init from server, then maintained locally ───
  let lastCheckedTimestamp = 0;
  let timestampLoaded = false;

  // actions = { guid: { action: "hidden"|"flagged"|"clean"|"sent", category: "...", confidence: 0.9, keyword: null|"...", ts: 123 } }
  let actions = {};

  let stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "initializing" };
  let lastCountersSent = null;
  let configRetryCount = 0;
  let pendingScanMode = null;

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

  function getScrollParent(startEl) {
    var el = startEl;
    while (el && el !== document.body && el !== document.documentElement) {
      try {
        var cs = window.getComputedStyle(el);
        var oy = cs && cs.overflowY ? cs.overflowY : "";
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 4) return el;
      } catch (_) {}
      el = el.parentElement;
    }
    try { return document.scrollingElement || document.documentElement; } catch (_) {}
    return document.documentElement;
  }

  function getMessageListScroller() {
    var list = document.querySelector('[data-qa-name="message-list"]');
    if (list) return getScrollParent(list);
    var rows = getAllMessageRows();
    if (rows && rows.length) return getScrollParent(rows[0]);
    return getScrollParent(document.body);
  }

  function getRowsSignature() {
    var rows = getAllMessageRows();
    var count = rows ? rows.length : 0;
    var first = "";
    var last = "";
    if (count > 0) {
      first = getGuid(rows[0]) || "";
      last = getGuid(rows[count - 1]) || "";
    }
    return String(count) + "|" + first + "|" + last;
  }

  async function waitForRowsSignatureChange(prevSig, maxWaitMs) {
    var start = Date.now();
    while (Date.now() - start < (maxWaitMs || 1600)) {
      if (getRowsSignature() !== prevSig) return true;
      await sleep(120 + Math.random() * 80);
    }
    return false;
  }

  async function scrollMessageListToTop() {
    var scroller = getMessageListScroller();
    try {
      if (scroller && scroller !== document.scrollingElement && scroller !== document.documentElement) {
        scroller.scrollTop = 0;
      } else if (document.scrollingElement) {
        document.scrollingElement.scrollTop = 0;
      } else {
        window.scrollTo(0, 0);
      }
    } catch (_) {}
    await sleep(500);
  }

  async function scrollMessageListForward() {
    var scroller = getMessageListScroller();
    var beforeSig = getRowsSignature();
    var beforeTop = 0;
    try {
      beforeTop = scroller && typeof scroller.scrollTop === "number" ? scroller.scrollTop : (document.scrollingElement ? document.scrollingElement.scrollTop : window.scrollY);
    } catch (_) {}

    var rows = getAllMessageRows();
    var lastRow = rows && rows.length ? rows[rows.length - 1] : null;
    if (lastRow) {
      try { lastRow.scrollIntoView({ block: "end" }); } catch (_) {}
    }

    try {
      if (scroller && typeof scroller.scrollTop === "number") {
        scroller.scrollTop = scroller.scrollTop + Math.max(240, Math.floor(scroller.clientHeight * 0.85));
      } else {
        window.scrollBy(0, Math.max(240, Math.floor(window.innerHeight * 0.85)));
      }
    } catch (_) {}

    await sleep(650 + Math.random() * 250);
    var changed = await waitForRowsSignatureChange(beforeSig, 2200);
    if (changed) return true;

    try {
      var afterTop = scroller && typeof scroller.scrollTop === "number" ? scroller.scrollTop : (document.scrollingElement ? document.scrollingElement.scrollTop : window.scrollY);
      if (afterTop !== beforeTop) return true;
    } catch (_) {}

    return false;
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

  function clearRowDecorations(row) {
    try {
      var existing = row.querySelectorAll("." + BADGE_CLASS);
      existing.forEach(function (b) { b.remove(); });
    } catch (_) {}
    try {
      var outer = row.querySelector("[data-qa-thread-item]") || row;
      outer.style.borderLeft = "";
      outer.style.paddingLeft = "";
    } catch (_) {}
  }

  function reconcileRowGuid(row, guid) {
    if (!guid) return;
    var prev = row.getAttribute(GUID_ATTR);
    if (prev && prev !== guid) {
      row.removeAttribute(PROCESSED_ATTR);
      row.removeAttribute(GUID_ATTR);
      clearRowDecorations(row);
    }
    row.setAttribute(GUID_ATTR, guid);
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
      var allCandidates = [].concat(qaItems || [], (vis.roleItems || []));
      for (var k2 = 0; k2 < allCandidates.length; k2++) {
        var txt2 = ((allCandidates[k2].getAttribute && allCandidates[k2].getAttribute("data-qa-menu-item")) || allCandidates[k2].textContent || "").trim();
        var l2 = txt2.toLowerCase();
        if (l2.indexOf("hide") !== -1 && l2.indexOf("unhide") === -1) {
          hideItem = allCandidates[k2];
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
        for (var k3 = 0; k3 < role2.length; k3++) {
          var tx2 = (role2[k3].textContent || "").trim().toLowerCase();
          if (tx2.startsWith("hide")) { hideItem = role2[k3]; break; }
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

          var willAutoHide = doAutoHide || (doBadge && !!config.auto_hide_enabled);
          var willComplete = doComplt || (doBadge && !!config.auto_complete_enabled);

          console.log("[SproutMod] KW MATCH: \"" + kw.keyword + "\" → badge:" + doBadge + " hide:" + willAutoHide + " complete:" + willComplete);

          if (doBadge) {
            addBadge(row, kw.keyword, 1.0, true);
            result.flagged = true;
          }

          if (willAutoHide) {
            var hidden = await hideWithRetry(row);
            if (hidden) { result.hidden = true; }
            await sleep(300 + Math.random() * 200);
          }

          if (willComplete) {
            var completed = await doComplete(row);
            if (completed) { result.completed = true; }
          }

          var actionTaken = result.hidden ? "hidden" : (result.completed ? "completed" : "flagged");
          row.setAttribute(PROCESSED_ATTR, "done-kw-" + rawAction.replace(/,/g, "-"));
          recordAction(guid, { action: actionTaken, category: kw.keyword, confidence: 1.0, keyword: kw.keyword });

          if (willAutoHide && !doBadge) { result.flagged = true; }

          try {
            if (doBadge || willAutoHide) {
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

      var shouldHide = !!(config && config.auto_hide_enabled) && (aiData.action === "hide");
      var shouldComplete = !!(config && config.auto_complete_enabled) && !!aiData.should_complete;

      console.log("[SproutMod] AI FLAGGED:", cat, Math.round(conf * 100) + "%", guid,
        "→ action:" + (aiData.action || "") + " hide:" + shouldHide + " complete:" + shouldComplete);

      addBadge(row, cat, conf, false);
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
    var guid = getGuid(row);
    if (guid) reconcileRowGuid(row, guid);
    row.setAttribute(PROCESSED_ATTR, "restored-" + action);

    if (action === "clean" || action === "sent" || action === "empty") return;

    var label = data.keyword || data.category || "Flagged";
    var conf = data.confidence || 1.0;
    var isKw = !!data.keyword;

    addBadge(row, label, conf, isKw);
  }

  function restoreVisibleBadgesFromCache() {
    var now = Date.now();
    if (now - lastRestoreBadgesAt < 800) return;
    lastRestoreBadgesAt = now;

    var rows = getAllMessageRows();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!isComment(row)) continue;

      var guid = getGuid(row);
      if (!guid) continue;
      reconcileRowGuid(row, guid);

      // Skip rows that already have our attribute AND have a badge (if needed)
      if (row.hasAttribute(PROCESSED_ATTR)) {
        // If it's flagged/hidden but badge is missing (DOM recycled), re-add badge
        var cached0 = actions[guid];
        if (cached0 && cached0.action !== "clean" && cached0.action !== "sent" && cached0.action !== "empty") {
          if (!row.querySelector("." + BADGE_CLASS)) {
            restoreAction(row, cached0);
          }
        }
        continue;
      }

      var cached = actions[guid];
      if (!cached) {
        // Not in cache — mark old items so they don't keep triggering hasNew
        var ts = getTimestamp(row);
        if (ts > 0 && lastCheckedTimestamp > 0 && ts <= lastCheckedTimestamp) {
          row.setAttribute(PROCESSED_ATTR, "skipped-old");
        }
        continue;
      }

      var action = cached.action || "clean";
      if (action === "clean" || action === "sent" || action === "empty") {
        // Mark with PROCESSED_ATTR so recycled DOM stops appearing as "new"
        row.setAttribute(PROCESSED_ATTR, "restored-" + action);
        continue;
      }

      restoreAction(row, cached);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // FIX v5.2: checkForNewMessagesButton no longer returns a value
  // that causes the caller to bail out of scan().  It just clicks
  // the button, waits for content, and lets scan() continue.
  // ──────────────────────────────────────────────────────────────
  async function waitForTopTimestamps(maxWaitMs) {
    var start = Date.now();
    while (Date.now() - start < (maxWaitMs || 2500)) {
      var rows = getAllMessageRows();
      var ok = true;
      var checked = 0;
      for (var i = 0; i < rows.length && checked < 6; i++) {
        var r = rows[i];
        if (!isComment(r)) continue;
        var ts = getTimestamp(r);
        if (!(ts > 0)) { ok = false; break; }
        checked++;
      }
      if (checked > 0 && ok) return true;
      await sleep(120 + Math.random() * 60);
    }
    return false;
  }

  async function checkForNewMessagesButton() {
    var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
    if (newMsgBtn && isVisible(newMsgBtn)) {
      var prevSig = getRowsSignature();
      console.log("[SproutMod] Found 'New Messages' notification, clicking...");
      newMsgBtn.click();
      lastNewMessagesClickAt = Date.now();
      await sleep(700 + Math.random() * 300);
      await waitForRowsSignatureChange(prevSig, 3500);
      await waitForTopTimestamps(2500);
      await sleep(300);
      try { await loadConfig(); } catch (_) {}
      return true;
    }
    return false;
  }

  function shouldReplayOldItems() {
    return lastNewMessagesClickAt && (Date.now() - lastNewMessagesClickAt < 20000);
  }

  async function scan(mode) {
    if (!config) return;

    var requestedMode = mode || (fullScanComplete ? "visible" : "full");
    if (isScanning) {
      if (!pendingScanMode) pendingScanMode = requestedMode;
      else if (pendingScanMode === "visible" && requestedMode === "full") pendingScanMode = "full";
      return;
    }
    isScanning = true;

    // ─── Fresh counters for this scan cycle ───
    var scanCount = 0;      // only counts ACTUALLY PROCESSED (new) cards
    var flaggedCount = 0;
    var hiddenCount = 0;
    var completedCount = 0;
    var skippedCount = 0;
    var replayedOldCount = 0;

    try {
      // ─── Fetch timestamp from server ONCE, then use local copy ───
      if (!timestampLoaded) {
        var serverTs = await fetchLastCheckedTimestamp();
        lastCheckedTimestamp = serverTs;
        timestampLoaded = true;
        console.log("[SproutMod] Fetched last_checked_timestamp from server:", lastCheckedTimestamp);
      }

      var desiredMode = requestedMode;
      var highestProcessedTimestamp = lastCheckedTimestamp;

      await checkForNewMessagesButton();

      if (desiredMode === "full") {
        await scrollMessageListToTop();

        var seenGuidsThisScan = {};
        var stagnantScrolls = 0;

        for (var pass = 0; pass < 80; pass++) {
          var rows = getAllMessageRows();
          var commentRows = [];
          for (var i0 = 0; i0 < rows.length; i0++) {
            if (isComment(rows[i0])) commentRows.push(rows[i0]);
          }

          if (commentRows.length === 0) {
            var advanced0 = await scrollMessageListForward();
            if (!advanced0) break;
            await sleep(450);
            continue;
          }

          var highestCardTimestamp = 0;
          var hasAnyUnprocessed = false;

          for (var t = 0; t < commentRows.length; t++) {
            var ts = getTimestamp(commentRows[t]);
            if (ts > highestCardTimestamp) highestCardTimestamp = ts;
            if (!commentRows[t].hasAttribute(PROCESSED_ATTR)) hasAnyUnprocessed = true;
          }

          var allOld = (lastCheckedTimestamp > 0 && highestCardTimestamp > 0 && highestCardTimestamp <= lastCheckedTimestamp);
          if (allOld) {
            var anyRestored = false;
            for (var s = 0; s < commentRows.length; s++) {
              var row0 = commentRows[s];
              if (row0.hasAttribute(PROCESSED_ATTR)) continue;
              var g0 = getGuid(row0);
              if (!g0) continue;
              if (actions[g0]) {
                restoreAction(row0, actions[g0]);
                anyRestored = true;
              } else if (replayedOldCount < 8 && shouldReplayOldItems()) {
                replayedOldCount++;
                try {
                  await processRow(row0);
                } catch (_) {
                  row0.setAttribute(PROCESSED_ATTR, "error");
                }
              } else {
                row0.setAttribute(PROCESSED_ATTR, "skipped-old");
              }
              seenGuidsThisScan[g0] = true;
            }
            if (anyRestored) console.log("[SproutMod] Restored cached actions for old items");
          } else if (hasAnyUnprocessed) {
            for (var i = 0; i < commentRows.length; i++) {
              var row = commentRows[i];
              var guid = getGuid(row);
              if (!guid) continue;

              if (row.hasAttribute(PROCESSED_ATTR)) {
                seenGuidsThisScan[guid] = true;
                continue;
              }

              if (seenGuidsThisScan[guid]) {
                var cached2 = actions[guid];
                if (cached2) {
                  restoreAction(row, cached2);
                } else {
                  row.setAttribute(PROCESSED_ATTR, "skipped-dup");
                }
                continue;
              }
              seenGuidsThisScan[guid] = true;

              var cardTimestamp = getTimestamp(row);

              if (cardTimestamp > 0 && lastCheckedTimestamp > 0 && cardTimestamp <= lastCheckedTimestamp) {
                var cached = actions[guid];
                if (cached) {
                  restoreAction(row, cached);
                  skippedCount++;
                  continue;
                }
                if (replayedOldCount < 8 && shouldReplayOldItems()) {
                  replayedOldCount++;
                  try {
                    await processRow(row);
                  } catch (_) {
                    row.setAttribute(PROCESSED_ATTR, "error");
                  }
                } else {
                  row.setAttribute(PROCESSED_ATTR, "skipped-old");
                  skippedCount++;
                }
                continue;
              }

              scanCount++;
              console.log("[SproutMod] NEW:", guid, "ts:", cardTimestamp);

              try {
                var outcome = await processRow(row);
                if (outcome.flagged) flaggedCount++;
                if (outcome.hidden) hiddenCount++;
                if (outcome.completed) completedCount++;
              } catch (rowErr) {
                console.warn("[SproutMod] Error processing row:", guid, rowErr);
                row.setAttribute(PROCESSED_ATTR, "error");
              }

              var effectiveTs = cardTimestamp > 0 ? cardTimestamp : Math.floor(Date.now() / 1000);
              if (effectiveTs > highestProcessedTimestamp) highestProcessedTimestamp = effectiveTs;

              await sleep(280 + Math.random() * 140);
            }
          }

          var advanced = await scrollMessageListForward();
          if (!advanced) {
            stagnantScrolls++;
            if (stagnantScrolls >= 2) break;
          } else {
            stagnantScrolls = 0;
          }
        }

        fullScanComplete = true;
      } else {
        var rowsStartV = getAllMessageRows();
        var sessionUpperTs = 0;
        for (var sV = 0; sV < rowsStartV.length; sV++) {
          var rS = rowsStartV[sV];
          if (!isComment(rS)) continue;
          if (rS.hasAttribute(PROCESSED_ATTR)) continue;
          var tsS = getTimestamp(rS);
          if (tsS > 0 && (lastCheckedTimestamp <= 0 || tsS > lastCheckedTimestamp) && tsS > sessionUpperTs) sessionUpperTs = tsS;
        }

        var processedThisCycle = {};
        var maxPasses = 40; // safety cap

        for (var passV = 0; passV < maxPasses; passV++) {
          var rowsV = getAllMessageRows();
          var foundWork = false;

          for (var iV = 0; iV < rowsV.length; iV++) {
            var rowV = rowsV[iV];
            if (!isComment(rowV)) continue;

            var guidV = getGuid(rowV);
            if (!guidV) continue;
            if (rowV.hasAttribute(PROCESSED_ATTR)) continue;
            if (processedThisCycle[guidV]) continue;

            var cardTimestampV = getTimestamp(rowV);

            // Prevent processing timestamp-less rows after we have a timestamp gate.
            if (lastCheckedTimestamp > 0 && !(cardTimestampV > 0)) {
              rowV.setAttribute(PROCESSED_ATTR, "skipped-no-ts");
              skippedCount++;
              continue;
            }

            // Only process items genuinely newer than lastCheckedTimestamp.
            if (cardTimestampV > 0 && lastCheckedTimestamp > 0 && cardTimestampV <= lastCheckedTimestamp) {
              var cachedV = actions[guidV];
              if (cachedV) {
                restoreAction(rowV, cachedV);
                skippedCount++;
                continue;
              }
              if (replayedOldCount < 8 && shouldReplayOldItems()) {
                replayedOldCount++;
                processedThisCycle[guidV] = true;
                foundWork = true;
                try {
                  await processRow(rowV);
                } catch (_) {
                  rowV.setAttribute(PROCESSED_ATTR, "error");
                }
                await sleep(400 + Math.random() * 200);
                break;
              } else {
                rowV.setAttribute(PROCESSED_ATTR, "skipped-old");
                skippedCount++;
              }
              continue;
            }

            if (sessionUpperTs > 0 && cardTimestampV > sessionUpperTs) {
              if (!pendingScanMode) pendingScanMode = "visible";
              continue;
            }

            // Found a genuinely new item
            processedThisCycle[guidV] = true;
            foundWork = true;
            scanCount++;
            console.log("[SproutMod] NEW:", guidV, "ts:", cardTimestampV);

            try {
              var outcomeV = await processRow(rowV);
              if (outcomeV.flagged) flaggedCount++;
              if (outcomeV.hidden) hiddenCount++;
              if (outcomeV.completed) completedCount++;
            } catch (rowErrV) {
              console.warn("[SproutMod] Error processing row:", guidV, rowErrV);
              rowV.setAttribute(PROCESSED_ATTR, "error");
            }

            var effectiveTsV = cardTimestampV > 0 ? cardTimestampV : Math.floor(Date.now() / 1000);
            if (effectiveTsV > highestProcessedTimestamp) highestProcessedTimestamp = effectiveTsV;

            // ── After each hide+complete, wait for DOM to settle,
            //    then BREAK inner loop and re-query fresh DOM ──
            await sleep(400 + Math.random() * 200);
            break;
          }

          // If inner loop found no work, we're done
          if (!foundWork) break;
        }
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

      var clickedAfter = await checkForNewMessagesButton();
      if (clickedAfter) {
        if (!pendingScanMode) pendingScanMode = "visible";
      }

    } catch (scanErr) {
      console.error("[SproutMod] Scan error:", scanErr);
    } finally {
      isScanning = false;
      if (pendingScanMode) {
        var nextMode = pendingScanMode;
        pendingScanMode = null;
        scan(nextMode);
      }
    }
  }

  function broadcastStats() {
    try {
      chrome.runtime.sendMessage({ type: "STATS_UPDATE", data: stats });
    } catch (e) { /* popup closed */ }
  }

  // ===================== GENUINELY-NEW CHECK =====================
  // Distinguishes truly new messages from recycled DOM elements
  // that lost their PROCESSED_ATTR due to Sprout's virtual list.

  function hasGenuinelyNewItems() {
    var rows = getAllMessageRows();
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.hasAttribute(PROCESSED_ATTR)) continue;
      if (!isComment(row)) continue;

      var guid = getGuid(row);
      if (!guid) continue;

      // Already in our action cache → recycled DOM, not new
      if (actions[guid]) continue;

      // Timestamp older than or equal to our gate → old item, not new
      var ts = getTimestamp(row);
      if (ts > 0 && lastCheckedTimestamp > 0 && ts <= lastCheckedTimestamp) continue;

      // This item is genuinely new — needs processing
      return true;
    }
    return false;
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
        if (isScanning) {
          var btn0 = document.querySelector('button[data-qa-button*="New Message"]');
          var hasBtn0 = btn0 && isVisible(btn0);
          if (hasBtn0) {
            pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
            return;
          }
          if (fullScanComplete) {
            if (hasGenuinelyNewItems()) {
              pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
            }
            return;
          }
          pendingScanMode = "full";
          return;
        }
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

        if (hasButton) {
          console.log("[SproutMod] Observer: New Messages button detected");
          // FIX v5.2: always trigger a visible scan — checkForNewMessagesButton()
          // is called INSIDE scan() now, so no need to call it separately here.
          scan("visible");
          return;
        }

        // ── FIX v5.3: after fullScanComplete, restore badges for recycled
        //    DOM elements and only trigger scan for genuinely new items ──
        if (fullScanComplete) {
          restoreVisibleBadgesFromCache();
          if (hasGenuinelyNewItems()) {
            console.log("[SproutMod] Observer: genuinely new items detected, running visible scan");
            scan("visible");
          }
          return;
        }

        if (!fullScanComplete && hasNew) {
          console.log("[SproutMod] Observer: new items detected (pre-full-scan)");
          scan("full");
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
      if (isScanning) {
        var btn0 = document.querySelector('button[data-qa-button*="New Message"]');
        var hasBtn0 = btn0 && isVisible(btn0);
        if (hasBtn0) {
          pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
          return;
        }
        if (fullScanComplete) {
          if (hasGenuinelyNewItems()) {
            pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
          }
          return;
        }
        return;
      }
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

      if (hasButton) {
        console.log("[SproutMod] Poll: New Messages button detected");
        // FIX v5.2: trigger scan directly — button click happens inside scan()
        scan("visible");
        return;
      }

      // ── FIX v5.3: restore badges for recycled DOM elements
      //    and only trigger scan for genuinely new items ──
      if (fullScanComplete) {
        restoreVisibleBadgesFromCache();
        if (hasGenuinelyNewItems()) {
          console.log("[SproutMod] Poll: genuinely new items detected, running visible scan");
          scan("visible");
        }
        return;
      }

      if (!fullScanComplete && hasNew) {
        console.log("[SproutMod] Poll: found unprocessed items (pre-full-scan)");
        scan("full");
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

  // ===================== INIT =====================

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
})();
