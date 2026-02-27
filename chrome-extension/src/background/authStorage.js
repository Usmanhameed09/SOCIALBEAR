/*
 * Responsibility: Auth token persistence helpers for the background service worker.
 * What it does: Reads/writes authToken and refreshToken in chrome.storage.local and provides headers when needed.
 * Connections: Used by auth refresh + API request helpers (authRefresh.js) and request handlers (handlers.js).
 */

async function getAuthHeaders() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken"], (data) => {
      const headers = { "Content-Type": "application/json" };
      if (data && data.authToken) {
        headers.Authorization = `Bearer ${data.authToken}`;
      }
      resolve(headers);
    });
  });
}

async function getAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["authToken", "refreshToken"], (data) => {
      resolve({
        authToken: (data && data.authToken) || "",
        refreshToken: (data && data.refreshToken) || "",
      });
    });
  });
}

async function setAuthState({ authToken, refreshToken }) {
  return new Promise((resolve) => {
    const update = {};
    if (typeof authToken === "string") update.authToken = authToken;
    if (typeof refreshToken === "string") update.refreshToken = refreshToken;
    chrome.storage.local.set(update, resolve);
  });
}

async function clearAuthState() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(["authToken", "refreshToken"], resolve);
  });
}

