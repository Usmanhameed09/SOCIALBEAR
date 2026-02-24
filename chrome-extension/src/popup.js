// Popup script for Sprout Moderation Extension

const loginView = document.getElementById("login-view");
const mainView = document.getElementById("main-view");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const rescanBtn = document.getElementById("rescan-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const statusContainer = document.getElementById("status-container");

// Check if already connected
chrome.storage.local.get(["authToken", "apiBaseUrl"], (data) => {
  if (data.authToken) {
    showMainView();
    refreshStats();
  } else {
    showLoginView();
  }
});

function showLoginView() {
  loginView.classList.add("active");
  mainView.classList.remove("active");
}

function showMainView() {
  loginView.classList.remove("active");
  mainView.classList.add("active");
}

function showError(msg) {
  loginError.textContent = msg;
  loginError.classList.add("show");
}

function hideError() {
  loginError.classList.remove("show");
}

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "AUTH_REQUIRED") {
      showLoginView();
      showError(msg.message || "Session expired. Please sign in again.");
    }
  });
} catch (_) {}

// LOGIN
loginBtn.addEventListener("click", async () => {
  hideError();
  const apiUrl = document.getElementById("apiUrl").value.trim();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  if (!apiUrl || !email || !password) {
    showError("All fields are required");
    return;
  }

  loginBtn.textContent = "Connecting...";
  loginBtn.disabled = true;

  try {
    // Use Supabase REST API to sign in
    const supabaseUrl = apiUrl.includes("supabase.co")
      ? apiUrl
      : null;

    // Sign in via our Next.js API or directly via Supabase
    // We'll call Supabase auth endpoint from the admin panel URL
    const response = await fetch(
      `${apiUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: await getAnonKey(apiUrl),
        },
        body: JSON.stringify({ email, password }),
      }
    );

    if (!response.ok) {
      // Fallback: try direct Supabase login
      const supabaseRes = await loginViaSupabase(apiUrl, email, password);
      if (!supabaseRes) {
        throw new Error("Invalid credentials");
      }
      return;
    }

    const data = await response.json();

    chrome.storage.local.set(
      {
        authToken: data.access_token,
        refreshToken: data.refresh_token,
        apiBaseUrl: apiUrl,
        userEmail: email,
      },
      () => {
        showMainView();
        refreshStats();
      }
    );
  } catch (err) {
    showError(err.message || "Connection failed");
  } finally {
    loginBtn.textContent = "Connect";
    loginBtn.disabled = false;
  }
});

async function getAnonKey(apiUrl) {
  // Try to fetch the anon key from our API
  try {
    const res = await fetch(`${apiUrl}/api/config`, {
      method: "OPTIONS",
    });
    // If the admin panel serves its own auth, we might need a different approach
  } catch (e) {}
  // Return empty — user may need to provide this
  return "";
}

async function loginViaSupabase(apiUrl, email, password) {
  // Alternative: the user provides their Supabase URL in the apiUrl field
  // and we authenticate directly
  try {
    // Try using the admin panel's own login endpoint
    const res = await fetch(`${apiUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    if (res.ok) {
      const data = await res.json();
      chrome.storage.local.set(
        {
          authToken: data.access_token || data.token,
          refreshToken: data.refresh_token || "",
          apiBaseUrl: apiUrl,
          userEmail: email,
        },
        () => {
          showMainView();
          refreshStats();
        }
      );
      return true;
    }
  } catch (e) {}
  return false;
}

// STATS
function refreshStats() {
  // Get stats from content script
  chrome.tabs.query(
    { active: true, currentWindow: true },
    (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { type: "GET_STATS" },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              updateStatus("waiting", "Waiting for Sprout inbox tab...");
              return;
            }
            updateStats(response);
            updateStatus(response.status, getStatusMessage(response.status));
          }
        );
      }
    }
  );
}

function updateStats(stats) {
  document.getElementById("stat-scanned").textContent = stats.scanned || 0;
  document.getElementById("stat-flagged").textContent = stats.flagged || 0;
  document.getElementById("stat-hidden").textContent = stats.hidden || 0;

  if (stats.lastScan) {
    const ago = timeAgo(new Date(stats.lastScan));
    document.getElementById("stat-last-scan").textContent = ago;
  }
}

function updateStatus(status, message) {
  const cssClass =
    status === "running" ? "" : status === "error" ? "error" : "warning";
  statusContainer.innerHTML = `
    <div class="status-bar ${cssClass}">
      <div class="status-dot"></div>
      <span>${message}</span>
    </div>
  `;
}

function getStatusMessage(status) {
  switch (status) {
    case "running":
      return "System active — monitoring inbox";
    case "error":
      return "Error — check config in admin panel";
    case "no_config":
      return "Please configure in admin panel";
    case "initializing":
      return "Initializing...";
    default:
      return "Unknown status";
  }
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

// RESCAN
rescanBtn.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "MANUAL_SCAN" });
      rescanBtn.textContent = "✅ Scanning...";
      setTimeout(() => {
        rescanBtn.textContent = "🔄 Rescan Inbox";
        refreshStats();
      }, 2000);
    }
  });
});

// DISCONNECT
disconnectBtn.addEventListener("click", () => {
  chrome.storage.local.remove(
    ["authToken", "refreshToken", "apiBaseUrl", "userEmail", "cachedConfig"],
    () => {
      showLoginView();
    }
  );
});

// Auto refresh stats
setInterval(refreshStats, 5000);
