/*
 * Responsibility: Local persistence of per-message actions for the content script.
 * What it does: Stores moderation outcomes in chrome.storage.local keyed by user ID and prunes old entries.
 * Connections: Used by scan/moderation flows to restore badges and skip already-handled messages.
 */

"use strict";

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

