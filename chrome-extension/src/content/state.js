/*
 * Responsibility: Shared constants and mutable state for the content script runtime.
 * What it does: Defines all top-level constants and state used across the content script files.
 * Connections: All other src/content/*.js files read and mutate these values; index.js boots init and scanning.
 */

"use strict";

const PROCESSED_ATTR = "data-sproutmod-processed";
const BADGE_CLASS = "sproutmod-badge";
const GUID_ATTR = "data-sproutmod-guid";
const POLL_INTERVAL = 6000;
const CONFIG_REFRESH_INTERVAL = 10000;
const STORAGE_KEY_PREFIX = "sproutmod_actions_v5_";

let currentUserId = null;
let config = null;
let isScanning = false;
let fullScanComplete = false;
let lastRestoreBadgesAt = 0;
let lastNewMessagesClickAt = 0;

// ─── Timestamp gate: fetched ONCE at init from server, then maintained locally ───
let lastCheckedTimestamp = 0;
let timestampLoaded = false;

// actions = { guid: { action: "hidden"|"flagged"|"clean"|"sent", category: "...", confidence: 0.9, keyword: null|"...", ts: 123 } }
let actions = {};

let stats = { scanned: 0, flagged: 0, hidden: 0, completed: 0, lastScan: null, status: "initializing" };
let lastCountersSent = null;
let configRetryCount = 0;
let pendingScanMode = null;

let prevConfigFingerprint = null;

let debounceTimer = null;
let ignoreMutations = false;
