// NOTE: importScripts paths are resolved RELATIVE TO THE SERVICE WORKER FILE.
// The SW lives at background/service-worker.js, but the shared modules live at
// the EXTENSION ROOT (shared/*.js). Using '../shared/...' resolves correctly.
try {
  importScripts('../shared/constants.js', '../shared/logger.js', '../shared/prompts.js', '../shared/api.js', '../shared/rewrite-service.js');
  console.log('[rewrite] service-worker started successfully');
} catch (e) {
  console.error('[rewrite] service-worker importScripts failed:', e);
}

// Make the toolbar action open the side panel. This MUST run on every SW
// startup (not only on onInstalled) because MV3 service workers are killed
// and respawned, and the panel-behavior setting does not reliably persist
// across respawns in Edge/Chrome. setPanelBehavior is idempotent.
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function(e) {
    console.warn('[rewrite] setPanelBehavior failed:', e);
  });
}

// --- CONTEXT MENU ---
chrome.runtime.onInstalled.addListener(function() {
  chrome.contextMenus.removeAll(function() {
    chrome.contextMenus.create({ id: 'ai-style-close',  title: '📝 贴近原文', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ai-style-casual', title: '💬 口语化',   contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ai-style-formal', title: '🏛️ 正式',     contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ai-sep', type: 'separator', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'ai-settings', title: '⚙️ 设置', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener(function(info, tab) {
  if (info.menuItemId === 'ai-settings') { chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') }); return; }
  if (!info.selectionText) return;
  var map = { 'ai-style-close': 'close', 'ai-style-casual': 'casual', 'ai-style-formal': 'formal' };
  var style = map[info.menuItemId];
  if (style) openSidePanelWithText(tab, info.selectionText, style);
});

// CRITICAL: sidePanel.open() must be called synchronously within the user
// gesture (the contextMenu click). Any preceding `await` makes Edge/Chrome
// treat it as "not a user gesture" and reject it with
// "sidePanel.open() may only be called in response to a user gesture".
// So we kick off open() FIRST, then write session storage afterwards.
function openSidePanelWithText(tab, text, style) {
  openSidePanel(tab).then(function() {
    // Persist the payload after the panel is opening. The panel reads it on load.
    return chrome.storage.session.set({
      pending_selected_text: text,
      pending_style: style || 'close',
      pending_tab_id: tab ? tab.id : null
    });
  }).catch(function(e) {
    console.error('[rewrite] openSidePanelWithText failed:', e);
  });
}

// Open the side panel, safely handling a null/undefined tab (e.g. some panel
// contexts). Falls back to the last focused window when tab info is unavailable.
// NOTE: must be called synchronously from a user gesture; do not add awaits
// before sidePanel.open() in the callers above.
function openSidePanel(tab) {
  if (tab && tab.id) {
    return chrome.sidePanel.open({ tabId: tab.id }).catch(function() {
      // tabId path failed — try windowId
      if (tab && tab.windowId) return chrome.sidePanel.open({ windowId: tab.windowId });
      return openSidePanelByWindow();
    });
  }
  return openSidePanelByWindow();
}

function openSidePanelByWindow() {
  return chrome.windows.getLastFocused().then(function(win) {
    return chrome.sidePanel.open({ windowId: win && win.id });
  });
}

// --- MESSAGING ---
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  switch (message.action) {
    case 'openOptionsPage':
      console.log('[rewrite] service-worker received openOptionsPage');
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
      sendResponse({ success: true });
      return true;

    case 'openSidePanel':
      handleOpenSidePanel(message, sender, sendResponse);
      return true;

    case 'rewriteText':
      handleRewrite(message, sender, sendResponse);
      return true;

    case 'replaceText':
      handleReplace(message, sender, sendResponse);
      return true;

    case 'getSettings':
      chrome.storage.local.get([
        STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE, STORAGE_KEYS.HISTORY
      ], function(r) {
        sendResponse({
          apiKey: r[STORAGE_KEYS.API_KEY] || null,
          model: r[STORAGE_KEYS.MODEL] || API_CONFIG.MODEL,
          temperature: r[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(r[STORAGE_KEYS.TEMPERATURE]) : API_CONFIG.TEMPERATURE,
          history: r[STORAGE_KEYS.HISTORY] || []
        });
      });
      return true;

    case 'saveSettings':
      var s = {};
      if (message.apiKey !== undefined) s[STORAGE_KEYS.API_KEY] = message.apiKey;
      if (message.model !== undefined) s[STORAGE_KEYS.MODEL] = message.model;
      if (message.temperature !== undefined) s[STORAGE_KEYS.TEMPERATURE] = message.temperature;
      chrome.storage.local.set(s, function() { sendResponse({ success: true }); });
      return true;

    case 'saveHistory':
      saveHistory(message.original, message.rewritten, message.style, message.note, sendResponse);
      return true;

    case 'getHistory':
      chrome.storage.local.get(STORAGE_KEYS.HISTORY, function(r) {
        sendResponse({ history: r[STORAGE_KEYS.HISTORY] || [] });
      });
      return true;

    case 'clearHistory':
      chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: [] }, function() { sendResponse({ success: true }); });
      return true;
  }
  return false;
});

// --- REWRITE HANDLER (via shared service, non-streaming) ---
async function handleRewrite(message, sender, sendResponse) {
  try {
    var storage = await chrome.storage.local.get([
      STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE
    ]);
    var apiKey = storage[STORAGE_KEYS.API_KEY];
    if (!apiKey) { sendResponse({ success: false, error: ERROR_MESSAGES.NO_API_KEY }); return; }

    var model = storage[STORAGE_KEYS.MODEL] || API_CONFIG.MODEL;
    var temperature = storage[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(storage[STORAGE_KEYS.TEMPERATURE]) : API_CONFIG.TEMPERATURE;

    var result = await rewriteText({
      text: message.text,
      style: message.style || 'close',
      targetLang: 'en',
      apiKey: apiKey,
      model: model,
      temperature: temperature,
      stream: false  // message-passing can't stream
    });

    sendResponse({ success: true, text: result.text, note: result.note || '' });

    // Persist to history BEFORE the response path ends. saveToHistory (from
    // shared/api.js) is serialized by an internal lock and uses a consistent
    // id format. Awaiting it also prevents the MV3 service worker from being
    // torn down before the storage write completes.
    try {
      await saveToHistory(message.text, result.text, message.style || 'close', result.note || '');
    } catch (e) {
      console.error('[History] Failed to save (handleRewrite):', e);
    }

  } catch (e) {
    sendResponse({ success: false, error: e.message || ERROR_MESSAGES.NETWORK_ERROR });
  }
}

// --- HELPERS ---

async function handleOpenSidePanel(message, sender, sendResponse) {
  var tabId = sender.tab ? sender.tab.id : null;
  if (message.text) {
    await chrome.storage.session.set({
      pending_selected_text: message.text,
      pending_style: 'close',
      pending_tab_id: tabId
    });
  }
  try {
    await openSidePanel(sender.tab);
    sendResponse({ success: true });
  } catch (e) {
    sendResponse({ success: false, error: e && e.message });
  }
}

async function handleReplace(message, sender, sendResponse) {
  try {
    var tabId = message.tabId;
    if (!tabId) {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs.length) { sendResponse({ success: false }); return; }
      tabId = tabs[0].id;
    }
    var res = await chrome.tabs.sendMessage(tabId, {
      action: 'replaceText',
      text: message.text,
      elementInfo: message.elementInfo || null
    });
    sendResponse({ success: res && res.success });
  } catch (e) { sendResponse({ success: false }); }
}

async function saveHistory(original, rewritten, style, note, sendResponse) {
  try {
    await saveToHistory(original, rewritten, style || 'close', note || '');
    sendResponse({ success: true });
  } catch (e) {
    console.error('[History] Failed to save (saveHistory):', e);
    sendResponse({ success: false, error: e && e.message });
  }
}
