/*
 * Responsibility: DOM querying + scrolling utilities for the content script.
 * What it does: Locates Sprout inbox rows, extracts metadata, and provides scrolling/menu discovery helpers.
 * Connections: Used by moderation actions (actions.js), badge rendering (ui.js), and scanning flow (scanner.js).
 */

"use strict";

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
  var attr = el.getAttribute("data-qa-message-text") || "";
  if (attr && attr.trim()) return attr.trim();
  return (el.textContent || "").trim();
}

function isSent(row) {
  var el = row.querySelector("[data-qa-message-sent]");
  return el ? el.getAttribute("data-qa-message-sent") === "true" : false;
}

function getPlatform(row) {
  var el = row.querySelector("[data-qa-message-network]");
  if (!el) return "unknown";
  var net = (el.getAttribute("data-qa-message-network") || "unknown").toLowerCase();
  var map = {
    facebook: "facebook",
    fb_instagram_account: "instagram",
    twitter: "twitter",
    youtube: "youtube",
    tiktok: "tiktok",
    threads: "threads",
    linkedin: "linkedin"
  };
  if (map[net]) return map[net];
  if (net.indexOf("threads") !== -1) return "threads";
  if (net.indexOf("twitter") !== -1 || net === "x") return "twitter";
  return net;
}

function getMsgType(row) {
  var el = row.querySelector("[data-qa-message-type]");
  return el ? el.getAttribute("data-qa-message-type") : "unknown";
}
function isComment(row) {
  var t = (getMsgType(row) || "").toLowerCase();
  if (t.indexOf("comment") !== -1) return true;
  if (t.indexOf("threads_") !== -1) {
    if (t.indexOf("reply") !== -1) return true;
    if (t.indexOf("mention") !== -1) return true;
  }

  var platform = (getPlatform(row) || "").toLowerCase();
  if (platform === "twitter" || platform === "threads") {
    if (t.indexOf("mention") !== -1) return true;
    if (t.indexOf("reply") !== -1) return true;
  }
  return false;
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

