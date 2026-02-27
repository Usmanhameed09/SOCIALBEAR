/*
 * Responsibility: Applies keyword + AI moderation to a single inbox row.
 * What it does: Runs keyword rules first, then calls background moderation API, updates badges/actions/logs.
 * Connections: Called by scan loop in scanner.js; uses UI utilities (ui.js) and action automation (actions.js).
 */

"use strict";

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

