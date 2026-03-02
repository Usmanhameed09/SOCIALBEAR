/*
 * Responsibility: Scanning runtime that detects and processes new inbox rows.
 * What it does: Orchestrates full/visible scans, mutation observer + polling triggers, stats broadcasting, and timestamp gate updates.
 * Connections: Calls processRow (moderation.js) and UI helpers (ui.js); reads config/timestamp state from state.js + config.js.
 */

"use strict";

async function waitForTopTimestamps(maxWaitMs) {
  var start = Date.now();
  while (Date.now() - start < (maxWaitMs || 2500)) {
    var rows = getAllMessageRows();
    var ok = true;
    var checked = 0;
    for (var i = 0; i < rows.length && checked < 6; i++) {
      var r = rows[i];
      var rg = getGuid(r);
      if (rg) reconcileRowGuid(r, rg);
      if (!isComment(r)) continue;
      var ts = getTimestamp(r);
      if (!(ts > 0)) { ok = false; break; }
      checked++;
    }
    if (checked > 0 && ok) return true;
    await sleep(120 + Math.random() * 60);
  }
  return false;
}

async function checkForNewMessagesButton() {
  var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
  if (newMsgBtn && isVisible(newMsgBtn)) {
    var prevSig = getRowsSignature();
    console.log("[SproutMod] Found 'New Messages' notification, clicking...");
    newMsgBtn.click();
    lastNewMessagesClickAt = Date.now();
    await sleep(700 + Math.random() * 300);
    await waitForRowsSignatureChange(prevSig, 3500);
    await waitForTopTimestamps(2500);
    await sleep(300);
    try { await loadConfig(); } catch (_) {}
    try { restoreVisibleBadgesFromCache(); } catch (_) {}
    return true;
  }
  return false;
}

function shouldReplayOldItems() {
  return false;
}

async function scan(mode) {
  if (!config) return;

  var requestedMode = mode || (fullScanComplete ? "visible" : "full");
  if (isScanning) {
    if (!pendingScanMode) pendingScanMode = requestedMode;
    else if (pendingScanMode === "visible" && requestedMode === "full") pendingScanMode = "full";
    return;
  }
  isScanning = true;

  // ─── Fresh counters for this scan cycle ───
  var scanCount = 0;      // only counts ACTUALLY PROCESSED (new) cards
  var flaggedCount = 0;
  var hiddenCount = 0;
  var completedCount = 0;
  var skippedCount = 0;
  var replayedOldCount = 0;

  try {
    // ─── Fetch timestamp from server ONCE, then use local copy ───
    if (!timestampLoaded) {
      var serverTs = await fetchLastCheckedTimestamp();
      lastCheckedTimestamp = serverTs;
      timestampLoaded = true;
      console.log("[SproutMod] Fetched last_checked_timestamp from server:", lastCheckedTimestamp);
    }

    var desiredMode = requestedMode;
    var highestProcessedTimestamp = lastCheckedTimestamp;

    await checkForNewMessagesButton();

    if (desiredMode === "full") {
      await scrollMessageListToTop();

      var seenGuidsThisScan = {};
      var stagnantScrolls = 0;

      for (var pass = 0; pass < 80; pass++) {
        var rows = getAllMessageRows();
        var commentRows = [];
        for (var i0 = 0; i0 < rows.length; i0++) {
          var gInit = getGuid(rows[i0]);
          if (gInit) reconcileRowGuid(rows[i0], gInit);
          if (isComment(rows[i0])) commentRows.push(rows[i0]);
        }

        if (commentRows.length === 0) {
          var advanced0 = await scrollMessageListForward();
          if (!advanced0) break;
          await sleep(450);
          continue;
        }

        var highestCardTimestamp = 0;
        var hasAnyUnprocessed = false;

        for (var t = 0; t < commentRows.length; t++) {
          var gT = getGuid(commentRows[t]);
          if (gT) reconcileRowGuid(commentRows[t], gT);
          var ts = getTimestamp(commentRows[t]);
          if (ts > highestCardTimestamp) highestCardTimestamp = ts;
          if (!commentRows[t].hasAttribute(PROCESSED_ATTR)) hasAnyUnprocessed = true;
        }

        var allOld = (lastCheckedTimestamp > 0 && highestCardTimestamp > 0 && highestCardTimestamp <= lastCheckedTimestamp);
        if (allOld) {
          console.log(
            "[SproutMod][Scan] All visible comment rows are <= lastCheckedTimestamp; restoring/skipping. topTs=",
            highestCardTimestamp,
            "gate=",
            lastCheckedTimestamp,
            "shouldReplayOld=",
            shouldReplayOldItems()
          );

          var anyRestored = false;
          for (var s = 0; s < commentRows.length; s++) {
            var row0 = commentRows[s];
            var g0 = getGuid(row0);
            if (g0) reconcileRowGuid(row0, g0);
            if (row0.hasAttribute(PROCESSED_ATTR)) continue;
            if (!g0) continue;

            var ts0 = getTimestamp(row0);
            if (actions[g0]) {
              console.log("[SproutMod][Scan] RESTORE_CACHED_OLD:", g0, "ts=", ts0, "gate=", lastCheckedTimestamp);
              restoreAction(row0, actions[g0]);
              anyRestored = true;
            } else if (replayedOldCount < 8 && shouldReplayOldItems()) {
              replayedOldCount++;
              console.warn("[SproutMod][Scan] REPLAY_PROCESS_OLD:", g0, "ts=", ts0, "gate=", lastCheckedTimestamp, "replayed=", replayedOldCount);
              try {
                await processRow(row0);
              } catch (_) {
                row0.setAttribute(PROCESSED_ATTR, "error");
              }
            } else {
              console.log("[SproutMod][Scan] SKIP_OLD_NO_CACHE:", g0, "ts=", ts0, "gate=", lastCheckedTimestamp);
              row0.setAttribute(PROCESSED_ATTR, "skipped-old");
            }
            seenGuidsThisScan[g0] = true;
          }
          if (anyRestored) console.log("[SproutMod] Restored cached actions for old items");
        } else if (hasAnyUnprocessed) {
          for (var i = 0; i < commentRows.length; i++) {
            var row = commentRows[i];
            var guid = getGuid(row);
            if (!guid) continue;
            reconcileRowGuid(row, guid);

            if (row.hasAttribute(PROCESSED_ATTR)) {
              seenGuidsThisScan[guid] = true;
              continue;
            }

            if (seenGuidsThisScan[guid]) {
              var cached2 = actions[guid];
              if (cached2) {
                restoreAction(row, cached2);
              } else {
                row.setAttribute(PROCESSED_ATTR, "skipped-dup");
              }
              continue;
            }
            seenGuidsThisScan[guid] = true;

            var cardTimestamp = getTimestamp(row);

            if (cardTimestamp > 0 && lastCheckedTimestamp > 0 && cardTimestamp <= lastCheckedTimestamp) {
              var cached = actions[guid];

              console.log(
                "[SproutMod][Scan] OLD_BY_TIMESTAMP:",
                guid,
                "ts=",
                cardTimestamp,
                "gate=",
                lastCheckedTimestamp,
                "hasCache=",
                !!cached,
                "shouldReplayOld=",
                shouldReplayOldItems(),
                "replayed=",
                replayedOldCount
              );

              if (cached) {
                restoreAction(row, cached);
                skippedCount++;
                continue;
              }
              if (replayedOldCount < 8 && shouldReplayOldItems()) {
                replayedOldCount++;
                console.warn("[SproutMod][Scan] REPLAY_PROCESS_OLD:", guid, "ts=", cardTimestamp, "gate=", lastCheckedTimestamp, "replayed=", replayedOldCount);
                try {
                  await processRow(row);
                } catch (_) {
                  row.setAttribute(PROCESSED_ATTR, "error");
                }
              } else {
                row.setAttribute(PROCESSED_ATTR, "skipped-old");
                skippedCount++;
              }
              continue;
            }

            scanCount++;
            console.log("[SproutMod] NEW:", guid, "ts:", cardTimestamp);

            try {
              var outcome = await processRow(row);
              if (outcome.flagged) flaggedCount++;
              if (outcome.hidden) hiddenCount++;
              if (outcome.completed) completedCount++;
            } catch (rowErr) {
              console.warn("[SproutMod] Error processing row:", guid, rowErr);
              row.setAttribute(PROCESSED_ATTR, "error");
            }

            var effectiveTs = cardTimestamp > 0 ? cardTimestamp : Math.floor(Date.now() / 1000);
            if (effectiveTs > highestProcessedTimestamp) highestProcessedTimestamp = effectiveTs;

            await sleep(280 + Math.random() * 140);
          }
        }

        var advanced = await scrollMessageListForward();
        if (!advanced) {
          stagnantScrolls++;
          if (stagnantScrolls >= 2) break;
        } else {
          stagnantScrolls = 0;
        }
      }

      fullScanComplete = true;
    } else {
      var rowsStartV = getAllMessageRows();
      var sessionUpperTs = 0;
      for (var sV = 0; sV < rowsStartV.length; sV++) {
        var rS = rowsStartV[sV];
        var gS = getGuid(rS);
        if (gS) reconcileRowGuid(rS, gS);
        if (!isComment(rS)) continue;
        if (rS.hasAttribute(PROCESSED_ATTR)) continue;
        var tsS = getTimestamp(rS);
        if (tsS > 0 && (lastCheckedTimestamp <= 0 || tsS > lastCheckedTimestamp) && tsS > sessionUpperTs) sessionUpperTs = tsS;
      }

      var processedThisCycle = {};
      var maxPasses = 40; // safety cap

      for (var passV = 0; passV < maxPasses; passV++) {
        var rowsV = getAllMessageRows();
        var foundWork = false;

        for (var iV = 0; iV < rowsV.length; iV++) {
          var rowV = rowsV[iV];
          var guidV = getGuid(rowV);
          if (guidV) reconcileRowGuid(rowV, guidV);
          if (rowV.hasAttribute(PROCESSED_ATTR)) continue;
          if (!isComment(rowV)) continue;
          if (!guidV) continue;
          if (processedThisCycle[guidV]) continue;

          var cardTimestampV = getTimestamp(rowV);

          // Prevent processing timestamp-less rows after we have a timestamp gate.
          if (lastCheckedTimestamp > 0 && !(cardTimestampV > 0)) {
            rowV.setAttribute(PROCESSED_ATTR, "skipped-no-ts");
            skippedCount++;
            continue;
          }

          // Only process items genuinely newer than lastCheckedTimestamp.
          if (cardTimestampV > 0 && lastCheckedTimestamp > 0 && cardTimestampV <= lastCheckedTimestamp) {
            var cachedV = actions[guidV];

            console.log(
              "[SproutMod][Scan] VISIBLE_OLD_BY_TIMESTAMP:",
              guidV,
              "ts=",
              cardTimestampV,
              "gate=",
              lastCheckedTimestamp,
              "hasCache=",
              !!cachedV,
              "shouldReplayOld=",
              shouldReplayOldItems(),
              "replayed=",
              replayedOldCount
            );

            if (cachedV) {
              restoreAction(rowV, cachedV);
              skippedCount++;
              continue;
            }
            if (replayedOldCount < 8 && shouldReplayOldItems()) {
              replayedOldCount++;
              processedThisCycle[guidV] = true;
              foundWork = true;
              console.warn("[SproutMod][Scan] REPLAY_PROCESS_OLD (visible):", guidV, "ts=", cardTimestampV, "gate=", lastCheckedTimestamp, "replayed=", replayedOldCount);
              try {
                await processRow(rowV);
              } catch (_) {
                rowV.setAttribute(PROCESSED_ATTR, "error");
              }
              await sleep(400 + Math.random() * 200);
              break;
            } else {
              rowV.setAttribute(PROCESSED_ATTR, "skipped-old");
              skippedCount++;
            }
            continue;
          }

          if (sessionUpperTs > 0 && cardTimestampV > sessionUpperTs) {
            if (!pendingScanMode) pendingScanMode = "visible";
            continue;
          }

          // Found a genuinely new item
          processedThisCycle[guidV] = true;
          foundWork = true;
          scanCount++;
          console.log("[SproutMod] NEW:", guidV, "ts:", cardTimestampV);

          try {
            var outcomeV = await processRow(rowV);
            if (outcomeV.flagged) flaggedCount++;
            if (outcomeV.hidden) hiddenCount++;
            if (outcomeV.completed) completedCount++;
          } catch (rowErrV) {
            console.warn("[SproutMod] Error processing row:", guidV, rowErrV);
            rowV.setAttribute(PROCESSED_ATTR, "error");
          }

          var effectiveTsV = cardTimestampV > 0 ? cardTimestampV : Math.floor(Date.now() / 1000);
          if (effectiveTsV > highestProcessedTimestamp) highestProcessedTimestamp = effectiveTsV;

          // ── After each hide+complete, wait for DOM to settle,
          //    then BREAK inner loop and re-query fresh DOM ──
          await sleep(400 + Math.random() * 200);
          break;
        }

        // If inner loop found no work, we're done
        if (!foundWork) break;
      }
    }

    // ─── Save highest timestamp locally + to server ───
    if (highestProcessedTimestamp > lastCheckedTimestamp) {
      lastCheckedTimestamp = highestProcessedTimestamp;
      console.log("[SproutMod] Updated last_checked_timestamp:", lastCheckedTimestamp);
      saveLastCheckedTimestamp(highestProcessedTimestamp); // fire-and-forget
    }

    // ─── Update stats ONLY if we actually processed new cards ───
    if (scanCount > 0) {
      stats.scanned = scanCount;
      stats.flagged = flaggedCount;
      stats.hidden = hiddenCount;
      stats.completed = completedCount;
      stats.lastScan = new Date().toISOString();

      console.log("[SproutMod] ═══════════════════════════════════");
      console.log("[SproutMod]  Scan Complete");
      console.log("[SproutMod]  Processed:  " + scanCount);
      console.log("[SproutMod]  Skipped:    " + skippedCount);
      console.log("[SproutMod]  Flagged:    " + flaggedCount);
      console.log("[SproutMod]  Hidden:     " + hiddenCount);
      console.log("[SproutMod]  Completed:  " + completedCount);
      console.log("[SproutMod]  Timestamp:  " + lastCheckedTimestamp);
      console.log("[SproutMod] ═══════════════════════════════════");

      broadcastStats();

      // Send counters to server
      try {
        var currentTotals = {
          total_processed: scanCount,
          flagged_total: flaggedCount,
          auto_hidden_total: hiddenCount,
          completed_total: completedCount,
          today_processed_increment: scanCount,
          today_flagged_increment: flaggedCount,
          today_auto_hidden_increment: hiddenCount,
          today_completed_increment: completedCount,
        };
        chrome.runtime.sendMessage(
          { type: "UPDATE_COUNTERS", data: currentTotals },
          function (response) {
            if (chrome.runtime.lastError) return;
            if (response && response.success) {
              lastCountersSent = currentTotals;
              console.log("[SproutMod] Counters updated");
            }
          }
        );
      } catch (_) {}
    } else if (skippedCount > 0) {
      console.log("[SproutMod] Scan: all", skippedCount, "cards skipped (already processed)");
    }

    var clickedAfter = await checkForNewMessagesButton();
    if (clickedAfter) {
      if (!pendingScanMode) pendingScanMode = "visible";
    }

  } catch (scanErr) {
    console.error("[SproutMod] Scan error:", scanErr);
  } finally {
    isScanning = false;
    if (pendingScanMode) {
      var nextMode = pendingScanMode;
      pendingScanMode = null;
      scan(nextMode);
    }
  }
}

function broadcastStats() {
  try {
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", data: stats });
  } catch (e) { /* popup closed */ }
}

function hasGenuinelyNewItems() {
  var rows = getAllMessageRows();
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var guid = getGuid(row);
    if (guid) reconcileRowGuid(row, guid);
    if (row.hasAttribute(PROCESSED_ATTR)) continue;
    if (!isComment(row)) continue;
    if (!guid) continue;

    // Already in our action cache → recycled DOM, not new
    if (actions[guid]) continue;

    // Timestamp older than or equal to our gate → old item, not new
    var ts = getTimestamp(row);
    if (ts > 0 && lastCheckedTimestamp > 0 && ts <= lastCheckedTimestamp) continue;

    // This item is genuinely new — needs processing
    return true;
  }
  return false;
}

function startObserver() {
  var target =
    document.querySelector('[data-qa-name="message-list"]') ||
    document.querySelector('[data-qa-status]') ||
    document.querySelector("main") ||
    document.body;

  var observer = new MutationObserver(function (mutations) {
    // Ignore mutations we caused (badge injection, attribute changes)
    if (ignoreMutations) return;

    // Check if any mutation is NOT from our badge/attribute changes
    var isOurChange = true;
    for (var m = 0; m < mutations.length; m++) {
      var mut = mutations[m];
      if (mut.type === "attributes" && mut.attributeName === PROCESSED_ATTR) continue;
      if (mut.type === "childList") {
        // Check if added nodes are our badges
        var hasNonBadge = false;
        for (var n = 0; n < mut.addedNodes.length; n++) {
          var node = mut.addedNodes[n];
          if (node.nodeType === 1 && node.classList && node.classList.contains(BADGE_CLASS)) continue;
          hasNonBadge = true;
          break;
        }
        if (hasNonBadge) { isOurChange = false; break; }
      } else {
        isOurChange = false;
        break;
      }
    }
    if (isOurChange) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      if (isScanning) {
        var btn0 = document.querySelector('button[data-qa-button*="New Message"]');
        var hasBtn0 = btn0 && isVisible(btn0);
        if (hasBtn0) {
          pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
          return;
        }
        if (fullScanComplete) {
          if (hasGenuinelyNewItems()) {
            pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
          }
          return;
        }
        pendingScanMode = "full";
        return;
      }
      var rows = getAllMessageRows();
      var hasNew = false;
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].hasAttribute(PROCESSED_ATTR)) {
          hasNew = true;
          break;
        }
      }
      
      // Also check for New Messages button
      var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
      var hasButton = newMsgBtn && isVisible(newMsgBtn);

      if (hasButton) {
        console.log("[SproutMod] Observer: New Messages button detected");
        scan("visible");
        return;
      }

      if (fullScanComplete) {
        restoreVisibleBadgesFromCache();
        if (hasGenuinelyNewItems()) {
          console.log("[SproutMod] Observer: genuinely new items detected, running visible scan");
          scan("visible");
        }
        return;
      }

      if (!fullScanComplete && hasNew) {
        console.log("[SproutMod] Observer: new items detected (pre-full-scan)");
        scan("full");
      }
    }, 1200);
  });

  observer.observe(target, { childList: true, subtree: true, attributes: false });
  console.log("[SproutMod] Observer watching:", target.className ? target.className.substring(0, 40) : target.tagName);
  return observer;
}

function startPolling() {
  setInterval(function () {
    if (isScanning) {
      var btn0 = document.querySelector('button[data-qa-button*="New Message"]');
      var hasBtn0 = btn0 && isVisible(btn0);
      if (hasBtn0) {
        pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
        return;
      }
      if (fullScanComplete) {
        if (hasGenuinelyNewItems()) {
          pendingScanMode = pendingScanMode === "full" ? "full" : "visible";
        }
        return;
      }
      return;
    }
    var rows = getAllMessageRows();
    var hasNew = false;
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].hasAttribute(PROCESSED_ATTR)) {
        hasNew = true;
        break;
      }
    }
    
    // Also check for New Messages button
    var newMsgBtn = document.querySelector('button[data-qa-button*="New Message"]');
    var hasButton = newMsgBtn && isVisible(newMsgBtn);

    if (hasButton) {
      console.log("[SproutMod] Poll: New Messages button detected");
      scan("visible");
      return;
    }

    if (fullScanComplete) {
      restoreVisibleBadgesFromCache();
      if (hasGenuinelyNewItems()) {
        console.log("[SproutMod] Poll: genuinely new items detected, running visible scan");
        scan("visible");
      }
      return;
    }

    if (!fullScanComplete && hasNew) {
      console.log("[SproutMod] Poll: found unprocessed items (pre-full-scan)");
      scan("full");
    }
  }, POLL_INTERVAL);
}
