/*
 * Responsibility: Base API URL resolution for the background service worker.
 * What it does: Reads apiBaseUrl from chrome.storage.local with a safe default.
 * Connections: Used by request handlers (handlers.js) and message routing (background.js).
 */

async function getBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apiBaseUrl"], (data) => {
      resolve(data.apiBaseUrl || "http://localhost:3000");
    });
  });
}

