// ====================================================
// Sprout Social AI Moderator — Content Script v4
// Re-hides unhidden comments, re-badges flagged items,
// only processes genuinely new items once, persists state
// ====================================================

(function () {
  "use strict";

  const PROCESSED_ATTR = "data-sproutmod-processed";
  const BADGE_CLASS = "sproutmod-badge";
  const POLL_INTERVAL = 6000;
  const CONFIG_REFRESH_INTERVAL = 10000;
  const STORAGE_KEY_PREFIX = "sproutmod_actions_v4_";

  let currentUserId = null;
  let config = null;
  let isScanning = false;

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
            // Prune entries older than 7 days
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

  // ===================== CONFIG =====================

  var prevConfigFingerprint = null;

  function buildConfigFingerprint(cfg) {
    var parts = [];
    parts.push("h:" + !!cfg.auto_hide_enabled);
    parts.push("c:" + !!cfg.auto_complete_enabled);
    parts.push("d:" + !!cfg.dry_run_mode);
    parts.push("t:" + (cfg.threshold || cfg.confidence_threshold || 0.7));
    parts.push("m:" + (cfg.ai_model || ""));
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

          // Detect ANY config change → full re-scan
          var newFingerprint = buildConfigFingerprint(config);
          console.log("[SproutMod] Fingerprint check — prev:", prevConfigFingerprint, "new:", newFingerprint, "match:", prevConfigFingerprint === newFingerprint);
          if (prevConfigFingerprint !== null && prevConfigFingerprint !== newFingerprint) {
            console.log("[SproutMod] ⚡ Config CHANGED — full re-scan");
            console.log("[SproutMod]   Was:", prevConfigFingerprint);
            console.log("[SproutMod]   Now:", newFingerprint);
            // Clear everything
            document.querySelectorAll("[" + PROCESSED_ATTR + "]").forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
            document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
            actions = {};
            saveActions();
            stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "running" };
            lastCountersSent = null;
            // Force isScanning false before re-scan (in case stuck)
            isScanning = false;
            setTimeout(function () { scan(); }, 500);
          }
          prevConfigFingerprint = newFingerprint;

          stats.status = "running";
          console.log("[SproutMod] Config loaded — user:", currentUserId,
            "keywords:", config.keywords ? config.keywords.length : 0,
            "threshold:", config.threshold,
            "AI → hide:", config.auto_hide_enabled,
            "complete:", config.auto_complete_enabled,
            "dry_run:", config.dry_run_mode,
            "fingerprint:", prevConfigFingerprint);
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
    // Remove any existing badge on this row
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

    // Left border highlight
    var outer = row.querySelector("[data-qa-thread-item]") || row;
    outer.style.borderLeft = confidence >= 0.7 ? "4px solid #ef4444" : confidence >= 0.4 ? "4px solid #f59e0b" : "4px solid #22c55e";
    outer.style.paddingLeft = "8px";
  }

  // ===================== CLICK HIDE =====================

  // Platform-specific hide menu item names used by Sprout
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

    // Step 1: Click "More Actions" (...) button on this message
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

    // Step 2: Find Hide menu item using data-qa-menu-item attribute
    // Sprout uses: data-qa-menu-item="Hide on Facebook", "Hide on Instagram", etc.
    var hideItem = null;

    var vis = await waitForVisibleMenuItems(1400);
    var qaItems = vis.qaItems;
    for (var qi = 0; qi < qaItems.length && !hideItem; qi++) {
      var val = qaItems[qi].getAttribute("data-qa-menu-item") || "";
      for (var i = 0; i < HIDE_MENU_ITEMS.length; i++) {
        if (val === HIDE_MENU_ITEMS[i]) { hideItem = qaItems[qi]; break; }
      }
    }

    // Secondary: any data-qa-menu-item starting with "Hide"
    if (!hideItem) {
      for (var j = 0; j < qaItems.length; j++) {
        var itemName = qaItems[j].getAttribute("data-qa-menu-item") || "";
        if (itemName.toLowerCase().startsWith("hide")) { hideItem = qaItems[j]; break; }
      }
    }

    // Tertiary: role=menuitem with text starting with "Hide"
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

    // Close menu if Hide not found (press Escape)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200 + Math.random() * 100);
    // Also try clicking elsewhere to dismiss
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

    // Fallback
    if (!btn) {
      btn = row.querySelector('[aria-label="Mark Complete"], [aria-label="Mark As Complete"]');
    }

    if (!btn) {
      console.log("[SproutMod] Complete button not found for", guid);
      return false;
    }

    // Don't click if disabled (sent messages)
    if (btn.getAttribute("data-qa-button-isdisabled") === "true" || btn.disabled) {
      console.log("[SproutMod] Complete disabled for", guid);
      return false;
    }

    // CRITICAL: Don't click if ALREADY completed — clicking again would UNMARK it
    if (btn.getAttribute("data-qa-action-is-active") === "true" ||
        btn.getAttribute("data-qa-is-active") === "true" ||
        btn.getAttribute("aria-pressed") === "true" ||
        btn.getAttribute("aria-checked") === "true" ||
        ((btn.className || "").toLowerCase().indexOf("active") !== -1)) {
      console.log("[SproutMod] Already completed, skip to avoid unmark:", guid);
      return false;
    }

    btn.click();
    stats.completed++;
    console.log("[SproutMod] COMPLETE clicked for", guid);
    await sleep(400 + Math.random() * 200);
    return true;
  }

  // ===================== RE-APPLY PREVIOUS ACTION =====================
  // If a comment was previously hidden/flagged and reappears (user unhid it),
  // re-apply the badge and re-hide if needed

  async function reApplyAction(row, guid, prev) {
    console.log("[SproutMod] RE-APPLYING action for", guid, "prev:", prev.action, "keyword:", prev.keyword || "none");
    try {
      if (prev.keyword) {
        // KEYWORD re-apply: always badge for keywords
        if (prev.action === "hidden" || prev.action === "flagged") {
          addBadge(row, prev.category || "flagged", prev.confidence || 1.0, true);
          stats.flagged++;
        }

        // Check current keyword's action settings
        var currentKw = null;
        if (config && config.keywords) {
          for (var k = 0; k < config.keywords.length; k++) {
            if (config.keywords[k].keyword.toLowerCase() === prev.keyword.toLowerCase()) {
              currentKw = config.keywords[k];
              break;
            }
          }
        }
        if (currentKw) {
          var rawAction = (currentKw.action || "badge_only").toLowerCase();
          var kwActions = rawAction.split(",").map(function (a) { return a.trim(); });
          var shouldHide = kwActions.indexOf("auto_hide") !== -1 || kwActions.indexOf("both") !== -1;
          var shouldComplete = kwActions.indexOf("complete") !== -1;

          if (shouldHide && prev.action === "hidden") {
            console.log("[SproutMod] RE-HIDING (keyword):", guid);
            var hidden = await doHide(row);
            if (hidden) { stats.hidden++; await sleep(300 + Math.random() * 200); }
            else { console.warn("[SproutMod] RE-HIDE failed, skipping:", guid); }
          }
          if (shouldComplete) {
            await doComplete(row);
          }
        }
      } else {
        // AI re-apply: use current AI settings from moderation_config
        var isDryRun = !!(config && config.dry_run_mode);
        var aiWantsHide = !!(config && config.auto_hide_enabled);
        var aiWantsComplete = !!(config && config.auto_complete_enabled);

        // Badge only in dry-run mode
        if (prev.action === "hidden" || prev.action === "flagged") {
          if (isDryRun) {
            addBadge(row, prev.category || "flagged", prev.confidence || 1.0, false);
          }
          stats.flagged++;
        }

        if (prev.action === "hidden" && aiWantsHide && !isDryRun) {
          console.log("[SproutMod] RE-HIDING (AI):", guid);
          var hidden = await doHide(row);
          if (hidden) { stats.hidden++; await sleep(300 + Math.random() * 200); }
          else { console.warn("[SproutMod] RE-HIDE failed, skipping:", guid); }
        }
        if (aiWantsComplete && !isDryRun) {
          await doComplete(row);
        }
      }
    } catch (err) {
      console.warn("[SproutMod] RE-APPLY error for", guid, err);
    }
    row.setAttribute(PROCESSED_ATTR, "re-applied");
    broadcastStats();
  }

  // ===================== PROCESS ONE MESSAGE =====================

  async function processRow(row) {
    var guid = getGuid(row);
    if (!guid) return;

    // Check if this row already has our attribute in current DOM session
    var domStatus = row.getAttribute(PROCESSED_ATTR);

    // Check if we have a previous action stored for this GUID
    var prev = getAction(guid);

    // CASE 1: Previously processed AND still marked in DOM → skip entirely
    if (domStatus && domStatus !== "re-check") {
      return;
    }

    // CASE 2: Previously hidden/flagged but appeared again (user unhid or Sprout re-rendered)
    // The DOM attribute is gone (new DOM element) but we have stored action
    // IMPORTANT: Validate that the stored action is still valid under current config
    if (prev && (prev.action === "hidden" || prev.action === "flagged") && !domStatus) {
      // If it was a keyword action, verify the keyword still exists and has the same actions
      if (prev.keyword) {
        var kwStillExists = false;
        if (config && config.keywords) {
          for (var k = 0; k < config.keywords.length; k++) {
            if (config.keywords[k].keyword.toLowerCase() === prev.keyword.toLowerCase()) {
              kwStillExists = true;
              break;
            }
          }
        }
        if (!kwStillExists) {
          // Keyword was deleted — don't re-apply old keyword action
          // Instead, fall through to process as new (AI will re-evaluate)
          console.log("[SproutMod] Stored keyword action for deleted keyword '" + prev.keyword + "', re-processing as new:", guid);
          delete actions[guid];
          saveActions();
          // Fall through to CASE 4 (process as new)
        } else {
          await reApplyAction(row, guid, prev);
          return;
        }
      } else {
        // AI action — re-apply with current AI settings
        await reApplyAction(row, guid, prev);
        return;
      }
    }

    // CASE 3: Previously clean or sent → skip
    if (prev && (prev.action === "clean" || prev.action === "sent")) {
      row.setAttribute(PROCESSED_ATTR, "done-" + prev.action);
      return;
    }

    // CASE 4: Brand new message — process it
    if (isSent(row)) {
      row.setAttribute(PROCESSED_ATTR, "sent");
      recordAction(guid, { action: "sent" });
      return;
    }

    var text = getText(row);
    if (!text || text.length < 2) {
      row.setAttribute(PROCESSED_ATTR, "empty");
      recordAction(guid, { action: "clean" });
      return;
    }

    row.setAttribute(PROCESSED_ATTR, "processing");

    var platform = getPlatform(row);
    var msgType = getMsgType(row);
    console.log("[SproutMod] Processing [" + platform + "/" + msgType + "] \"" + text.substring(0, 50) + "\" " + guid);

    // ---------- KEYWORD CHECK ----------
    // Per-keyword actions from keyword_rules.action (comma-separated)
    // Fully independent from AI settings
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

          if (doBadge) { addBadge(row, kw.keyword, 1.0, true); stats.flagged++; }

          var didHide = false;
          if (doAutoHide) {
            var hidden = await hideWithRetry(row);
            if (hidden) { stats.hidden++; didHide = true; }
            await sleep(300 + Math.random() * 200);
          }

          var didComplete = false;
          if (doComplt) {
            didComplete = await doComplete(row);
          }

          var actionTaken = didHide ? "hidden" : (doBadge ? "flagged" : (doComplt ? "completed" : "flagged"));
          row.setAttribute(PROCESSED_ATTR, "done-kw-" + rawAction.replace(/,/g, "-"));
          recordAction(guid, { action: actionTaken, category: kw.keyword, confidence: 1.0, keyword: kw.keyword });

          try {
            if (doBadge || doAutoHide) {
              chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: {
                message_id: guid, message_text: text, platform: platform,
                action_taken: didHide ? "hidden" : "flagged", source: "keyword"
              }});
            }
            if (didComplete) {
              chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: {
                message_id: guid, message_text: text, platform: platform,
                action_taken: "completed", source: "keyword"
              }});
            }
          } catch (_) {}
          broadcastStats();
          return;
        }
      }
    }

    // ---------- AI MODERATION ----------
    // Uses config.auto_hide_enabled, config.auto_complete_enabled, config.dry_run_mode
    // from moderation_config. Independent from keyword actions.
    row.setAttribute(PROCESSED_ATTR, "awaiting-ai");

    chrome.runtime.sendMessage(
      { type: "MODERATE_TEXT", data: { text: text, messageId: guid, platform: platform } },
      async function (response) {
        if (chrome.runtime.lastError) {
          console.warn("[SproutMod] Runtime error:", chrome.runtime.lastError.message);
          row.setAttribute(PROCESSED_ATTR, "error");
          recordAction(guid, { action: "clean" });
          return;
        }
        if (!response || !response.success) {
          console.warn("[SproutMod] API error:", response && response.error);
          row.setAttribute(PROCESSED_ATTR, "error");
          recordAction(guid, { action: "clean" });
          return;
        }

        var result = response.data;
        console.log("[SproutMod] AI result:", result);

        if (result.flagged) {
          var cat = result.highest_category || "flagged";
          var conf = result.confidence || 0.5;

          var isDryRun        = !!(config && config.dry_run_mode);
          var aiWantsHide     = !!(config && config.auto_hide_enabled);
          var aiWantsComplete = !!(config && config.auto_complete_enabled);

          var shouldHide     = aiWantsHide && !isDryRun;
          var shouldComplete = aiWantsComplete && !isDryRun;

          console.log("[SproutMod] AI FLAGGED:", cat, Math.round(conf * 100) + "%", guid,
            "→ badge:" + isDryRun + " hide:" + shouldHide + " complete:" + shouldComplete + " dry_run:" + isDryRun);

          // Badge only in dry-run mode (classify & show what AI would flag)
          // When actions are active (hide/complete), no badge needed
          if (isDryRun) {
            addBadge(row, cat, conf, false);
          }
          stats.flagged++;

          var didHide = false;
          if (shouldHide) {
            var hidden = await hideWithRetry(row);
            if (hidden) {
              stats.hidden++;
              didHide = true;
              console.log("[SproutMod] AI HIDE success:", guid);
            } else {
              console.warn("[SproutMod] AI HIDE failed:", guid);
            }
            await sleep(300 + Math.random() * 200);
          }

          var didComplete = false;
          if (shouldComplete) {
            didComplete = await doComplete(row);
          }

          var aiAction = didHide ? "hidden" : "flagged";
          row.setAttribute(PROCESSED_ATTR, "done-ai-" + aiAction);
          recordAction(guid, { action: aiAction, category: cat, confidence: conf, keyword: null });

          try {
            var payload = { message_id: guid, platform: platform, action_taken: aiAction, category: cat, confidence: conf, source: "ai" };
            if (response && response.success && response.data && response.data.log_id) payload.log_id = response.data.log_id;
            chrome.runtime.sendMessage({ type: "UPDATE_LOG", data: payload });
            if (didComplete) {
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

        broadcastStats();
      }
    );
  }

  // ===================== SCANNER =====================

  async function scan() {
    if (!config) return;
    if (isScanning) return;
    isScanning = true;

    try {
    var rows = getAllMessageRows();
    var commentRows = [];
    for (var i0 = 0; i0 < rows.length; i0++) {
      if (isComment(rows[i0])) commentRows.push(rows[i0]);
    }
    var startFlagged = stats.flagged;
    var startCompleted = stats.completed;
    var hiddenInc = 0;
    var newCount = 0;
    for (var i = 0; i < commentRows.length; i++) {
      var row = commentRows[i];
      var guid = getGuid(row);
      if (!guid) continue;

      var domStatus = row.getAttribute(PROCESSED_ATTR);
      var prev = getAction(guid);
      var needsProcessing = !domStatus;

      if (needsProcessing) {
        newCount++;
        try {
          await processRow(row);
        } catch (rowErr) {
          console.warn("[SproutMod] Error processing row:", guid, rowErr);
          row.setAttribute(PROCESSED_ATTR, "error");
        }
        await sleep(300);
      }

      // Count new hides only (do not count previously hidden re-hides)
      var after = getAction(guid);
      if (after && after.action === "hidden" && (!prev || prev.action !== "hidden")) {
        hiddenInc++;
      }
    }
    stats.scanned = commentRows.length;
    stats.lastScan = new Date().toISOString();


    if (newCount > 0) {
      console.log("[SproutMod] Scan: processed", newCount, "items");
    }
    broadcastStats();

    // Update counters only when there was activity or totals changed
    try {
      var changedThisScan =
        newCount > 0 ||
        hiddenInc > 0 ||
        Math.max(0, stats.flagged - startFlagged) > 0 ||
        Math.max(0, stats.completed - startCompleted) > 0;
      var currentTotals = {
        total_processed: stats.scanned,
        flagged_total: stats.flagged,
        auto_hidden_total: stats.hidden,
        completed_total: stats.completed,
      };
      var totalsChanged =
        !lastCountersSent ||
        currentTotals.total_processed !== lastCountersSent.total_processed ||
        currentTotals.flagged_total !== lastCountersSent.flagged_total ||
        currentTotals.auto_hidden_total !== lastCountersSent.auto_hidden_total ||
        currentTotals.completed_total !== lastCountersSent.completed_total;
      if ((commentRows.length > 0 && changedThisScan) || (commentRows.length > 0 && totalsChanged)) {
        chrome.runtime.sendMessage(
          {
            type: "UPDATE_COUNTERS",
            data: currentTotals,
          },
          function (response) {
            if (chrome.runtime.lastError) {
              console.warn("[SproutMod] Counters update message failed:", chrome.runtime.lastError.message);
              return;
            }
            if (!response || !response.success) {
              var e = response && response.error;
              var c = response && response.code;
              var d = response && response.details;
              console.warn("[SproutMod] Counters API error:", e, c || "", d || "");
            } else {
              lastCountersSent = currentTotals;
              console.log("[SproutMod] Counters updated");
            }
          }
        );
      } else {
        // Skip update when not on inbox or nothing changed
      }
    } catch (_) {}
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

  var debounceTimer = null;

  function startObserver() {
    var target =
      document.querySelector('[data-qa-name="message-list"]') ||
      document.querySelector('[data-qa-status]') ||
      document.querySelector("main") ||
      document.body;

    var observer = new MutationObserver(function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        // Check if there are any rows without our attribute
        var rows = getAllMessageRows();
        var hasNew = false;
        for (var i = 0; i < rows.length; i++) {
          if (!rows[i].hasAttribute(PROCESSED_ATTR)) {
            hasNew = true;
            break;
          }
        }
        if (hasNew) {
          console.log("[SproutMod] Observer: new/re-rendered items detected");
          scan();
        }
      }, 800);
    });

    observer.observe(target, { childList: true, subtree: true });
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
      if (hasNew) {
        console.log("[SproutMod] Poll: found unprocessed items");
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
      // Clear DOM attributes so everything gets re-checked
      var rows = document.querySelectorAll("[" + PROCESSED_ATTR + "]");
      rows.forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
      document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
      stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "running" };
      // NOTE: We do NOT clear actions — so previously hidden items will be re-hidden
      scan();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "FULL_RESET") {
      console.log("[SproutMod] Full reset — clearing all stored actions");
      actions = {};
      saveActions();
      var allRows = document.querySelectorAll("[" + PROCESSED_ATTR + "]");
      allRows.forEach(function (el) { el.removeAttribute(PROCESSED_ATTR); });
      document.querySelectorAll("." + BADGE_CLASS).forEach(function (el) { el.remove(); });
      stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "running" };
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
    console.log("[SproutMod]  Sprout Social AI Moderator v4.2");
    console.log("[SproutMod]  User-scoped | Config change detection");
    console.log("[SproutMod] ========================================");

    // Get user ID from auth token
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

    // Wait for inbox
    for (var i = 0; i < 30; i++) {
      if (document.querySelectorAll('[data-qa-inbox-list-row]').length > 0) break;
      await sleep(1000 + Math.random() * 500);
    }

    await loadConfig();

    if (config) {
      // Validate stored actions against current config on startup
      // Remove keyword actions whose keywords no longer exist
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
          console.log("[SproutMod] Removing stored action for deleted keyword '" + a.keyword + "':", g);
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

    console.log("[SproutMod] System active. Watching for new & unhidden messages.");
    broadcastStats();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 3000); });
  } else {
    setTimeout(init, 3000);
  }
})();
