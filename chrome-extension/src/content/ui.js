/*
 * Responsibility: Visual UI decoration for moderation state inside Sprout inbox rows.
 * What it does: Adds/removes badges and left-border indicators and restores them from cached actions.
 * Connections: Called by moderation processing (moderation.js) and scan routines (scanner.js).
 */

"use strict";

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
          console.log(
            "[SproutMod][UI] RESTORE_BADGE_MISSING:",
            guid,
            "action=",
            cached0.action,
            "ts=",
            getTimestamp(row),
            "gate=",
            lastCheckedTimestamp
          );
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
        console.log("[SproutMod][UI] MARK_SKIPPED_OLD_NO_CACHE:", guid, "ts=", ts, "gate=", lastCheckedTimestamp);
        row.setAttribute(PROCESSED_ATTR, "skipped-old");
      }
      continue;
    }

    var action = cached.action || "clean";
    if (action === "clean" || action === "sent" || action === "empty") {
      // Mark with PROCESSED_ATTR so recycled DOM stops appearing as "new"
      console.log("[SproutMod][UI] RESTORE_NO_BADGE_ACTION:", guid, "action=", action, "ts=", getTimestamp(row), "gate=", lastCheckedTimestamp);
      row.setAttribute(PROCESSED_ATTR, "restored-" + action);
      continue;
    }

    console.log(
      "[SproutMod][UI] RESTORE_BADGE_FROM_CACHE:",
      guid,
      "action=",
      action,
      "label=",
      cached.keyword || cached.category || "",
      "ts=",
      getTimestamp(row),
      "gate=",
      lastCheckedTimestamp
    );
    restoreAction(row, cached);
  }
}

