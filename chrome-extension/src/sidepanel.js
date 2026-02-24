// Sidepanel script (moved from inline due to MV3 CSP)
var loginView = document.getElementById("login-view");
var mainView  = document.getElementById("main-view");
var loginBtn  = document.getElementById("login-btn");
var loginError = document.getElementById("login-error");

// Safe default: show login while initializing
try {
  showLoginView();
} catch (_) {}

// INIT
try {
  chrome.storage.local.get(["authToken", "apiBaseUrl", "userEmail"], function(data) {
    if (data && data.authToken) {
      showMainView();
      refreshStats();
      loadConfigSummary();
    } else {
      showLoginView();
    }
  });
} catch (e) {
  showLoginView();
}

function showLoginView() {
  if (!loginView || !mainView) return;
  loginView.classList.add("active");
  mainView.classList.remove("active");
  var dot = document.getElementById("footer-dot");
  var status = document.getElementById("footer-status");
  var disconnect = document.getElementById("disconnect-btn");
  if (dot) dot.className = "footer-dot off";
  if (status) status.textContent = "Not connected";
  if (disconnect) disconnect.style.display = "none";
}

function showMainView() {
  if (!loginView || !mainView) return;
  loginView.classList.remove("active");
  mainView.classList.add("active");
  var dot = document.getElementById("footer-dot");
  var disconnect = document.getElementById("disconnect-btn");
  if (dot) dot.className = "footer-dot on";
  if (disconnect) disconnect.style.display = "";
  try {
    chrome.storage.local.get(["userEmail"], function(d) {
      var status = document.getElementById("footer-status");
      if (status) status.textContent = (d && d.userEmail) || "Connected";
    });
  } catch (_) {}
}

// LOGIN
if (loginBtn) {
  loginBtn.addEventListener("click", async function() {
    if (loginError) loginError.classList.remove("show");
    var apiUrl = document.getElementById("apiUrl").value.trim().replace(/\/+$/, "");
    var email  = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;

    if (!apiUrl || !email || !password) {
      if (loginError) {
        loginError.textContent = "All fields are required";
        loginError.classList.add("show");
      }
      return;
    }
    loginBtn.textContent = "Connecting...";
    loginBtn.disabled = true;

    try {
      var res = await fetch(apiUrl + "/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, password: password }),
      });
      if (!res.ok) throw new Error("Invalid credentials");

      var data = await res.json();
      chrome.storage.local.set({
        authToken: data.access_token || data.token,
        refreshToken: data.refresh_token || "",
        apiBaseUrl: apiUrl,
        userEmail: email,
      }, function() {
        showMainView();
        refreshStats();
        loadConfigSummary();
        sendToContent({ type: "CONFIG_UPDATED" });
      });
    } catch (err) {
      if (loginError) {
        loginError.textContent = (err && err.message) || "Connection failed";
        loginError.classList.add("show");
      }
    } finally {
      loginBtn.textContent = "Connect";
      loginBtn.disabled = false;
    }
  });
}

// STATS
function refreshStats() {
  sendToContent({ type: "GET_STATS" }, function(r) {
    if (!r) {
      updateStatus("warning", "Waiting for Sprout inbox...");
      return;
    }
    setText("stat-scanned", r.scanned || 0);
    setText("stat-flagged", r.flagged || 0);
    setText("stat-hidden", r.hidden || 0);
    setText("stat-completed", r.completed || 0);

    var msg = r.status === "running" ? "Active — Monitoring"
      : r.status === "error" ? "Error — Check config"
      : r.status === "no_config" ? "Not configured"
      : "Initializing...";
    updateStatus(r.status, msg);

    if (r.lastScan) {
      setText("footer-time", timeAgo(new Date(r.lastScan)));
    }
  });
}

function updateStatus(status, message) {
  var pill = document.getElementById("status-pill");
  if (pill) pill.className = "status-pill " + (status === "running" ? "running" : status === "error" ? "error" : "warning");
  setText("status-text", message);
}

function setText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function timeAgo(d) {
  var s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

// CONFIG SUMMARY
function loadConfigSummary() {
  try {
    chrome.runtime.sendMessage({ type: "FETCH_CONFIG" }, function(resp) {
      if (chrome.runtime.lastError || !resp) return;
      if (!resp.success || !resp.data) return;
      var cfg = resp.data;
      setText("cfg-autohide", cfg.auto_hide_enabled ? "ON" : "OFF");
      var ah = document.getElementById("cfg-autohide");
      if (ah) ah.className = "config-val " + (cfg.auto_hide_enabled ? "on" : "off");
      setText("cfg-dryrun", cfg.dry_run_mode ? "ON" : "OFF");
      var dr = document.getElementById("cfg-dryrun");
      if (dr) dr.className = "config-val " + (cfg.dry_run_mode ? "off" : "on");
      setText("cfg-model", cfg.ai_model || "gpt-4o-mini");
      setText("cfg-keywords", (cfg.keywords || []).length + " active");
      setText("cfg-categories", (cfg.categories || []).length + " active");
    });
  } catch (_) {}
}

// LIVE UPDATES
try {
  chrome.runtime.onMessage.addListener(function(msg) {
    if (msg.type === "STATS_UPDATE" && msg.data) {
      setText("stat-scanned", msg.data.scanned || 0);
      setText("stat-flagged", msg.data.flagged || 0);
      setText("stat-hidden", msg.data.hidden || 0);
      setText("stat-completed", msg.data.completed || 0);
      if (msg.data.lastScan) {
        setText("footer-time", timeAgo(new Date(msg.data.lastScan)));
      }
    }
    if (msg.type === "AUTH_REQUIRED") {
      try {
        showLoginView();
        if (loginError && msg.message) {
          loginError.textContent = msg.message;
          loginError.classList.add("show");
        }
      } catch (_) {}
    }
  });
} catch (_) {}

// ACTIONS
var rescanBtn = document.getElementById("rescan-btn");
if (rescanBtn) {
  rescanBtn.addEventListener("click", function() {
    var label = rescanBtn.querySelector("span");
    sendToContent({ type: "MANUAL_SCAN" });
    if (label) label.textContent = "Scanning...";
    setTimeout(function() { if (label) label.textContent = "Rescan Inbox"; refreshStats(); }, 2500);
  });
}

var resetBtn = document.getElementById("full-reset-btn");
if (resetBtn) {
  resetBtn.addEventListener("click", function() {
    if (confirm("Clear all history and rescan everything?")) {
      var label = resetBtn.querySelector("span");
      sendToContent({ type: "FULL_RESET" });
      if (label) label.textContent = "Resetting...";
      setTimeout(function() { if (label) label.textContent = "Full Reset"; refreshStats(); }, 2500);
    }
  });
}

var openPanelBtn = document.getElementById("open-panel-btn");
if (openPanelBtn) {
  openPanelBtn.addEventListener("click", function() {
    try {
      chrome.storage.local.get(["apiBaseUrl"], function(d) {
        if (d && d.apiBaseUrl) chrome.tabs.create({ url: d.apiBaseUrl + "/dashboard" });
      });
    } catch (_) {}
  });
}

var refreshBtn = document.getElementById("refresh-btn");
if (refreshBtn) {
  refreshBtn.addEventListener("click", function() {
    refreshStats();
    loadConfigSummary();
    refreshBtn.textContent = "✓";
    refreshBtn.classList.add("active-icon");
    setTimeout(function() { refreshBtn.textContent = "↻"; refreshBtn.classList.remove("active-icon"); }, 1200);
  });
}

var settingsBtn = document.getElementById("settings-btn");
if (settingsBtn) {
  settingsBtn.addEventListener("click", function() {
    try {
      chrome.storage.local.get(["apiBaseUrl"], function(d) {
        if (d && d.apiBaseUrl) chrome.tabs.create({ url: d.apiBaseUrl + "/dashboard/settings" });
      });
    } catch (_) {}
  });
}

var disconnectBtn = document.getElementById("disconnect-btn");
if (disconnectBtn) {
  disconnectBtn.addEventListener("click", function() {
    if (confirm("Disconnect from admin panel?")) {
      try {
        chrome.storage.local.remove(["authToken", "refreshToken", "apiBaseUrl", "userEmail", "cachedConfig"], function() {
          showLoginView();
        });
      } catch (_) {
        showLoginView();
      }
    }
  });
}

// HELPERS
function sendToContent(msg, cb) {
  try {
    chrome.tabs.query({ url: "https://app.sproutsocial.com/messages/*" }, function(tabs) {
      var target = (tabs && tabs[0]) || null;
      if (!target) {
        chrome.tabs.query({ active: true, currentWindow: true }, function(activeTabs) {
          var t = (activeTabs && activeTabs[0]) || null;
          var ok = t && t.url && /^https:\/\/app\.sproutsocial\.com\/messages\//.test(t.url);
          if (!ok) {
            if (typeof cb === "function") cb(null);
            return;
          }
          chrome.tabs.sendMessage(t.id, msg, function(resp) {
            if (chrome.runtime.lastError) {
              if (typeof cb === "function") cb(null);
              return;
            }
            if (typeof cb === "function") cb(resp);
          });
        });
        return;
      }
      chrome.tabs.sendMessage(target.id, msg, function(resp) {
        if (chrome.runtime.lastError) {
          if (typeof cb === "function") cb(null);
          return;
        }
        if (typeof cb === "function") cb(resp);
      });
    });
  } catch (_) {}
}

// Auto-refresh
setInterval(function() {
  refreshStats();
}, 5000);
setInterval(function() {
  loadConfigSummary();
}, 30000);
