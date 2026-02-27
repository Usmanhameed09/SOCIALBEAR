/*
 * Responsibility: User-action automation for inbox rows (hide + complete).
 * What it does: Clicks through Sprout UI to hide comments and mark items complete, with retries and UI heuristics.
 * Connections: Called by moderation.js when keyword/AI rules request hide/complete actions.
 */

"use strict";

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

