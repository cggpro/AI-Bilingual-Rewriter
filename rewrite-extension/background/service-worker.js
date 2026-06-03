importScripts('shared/constants.js', 'shared/prompts.js', 'shared/api.js');

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
  if (info.menuItemId === 'ai-settings') { chrome.runtime.openOptionsPage(); return; }
  if (!info.selectionText) return;
  var map = { 'ai-style-close': 'close', 'ai-style-casual': 'casual', 'ai-style-formal': 'formal' };
  var style = map[info.menuItemId];
  if (style) openSidePanelWithText(tab, info.selectionText, style);
});

// --- KEYBOARD COMMAND ---
chrome.commands.onCommand.addListener(async function(command) {
  if (command !== 'rewrite-selection') return;
  try {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return;
    var results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: function() { return window.getSelection().toString(); }
    });
    if (results && results[0] && results[0].result) {
      var text = results[0].result.trim();
      if (text) await openSidePanelWithText(tabs[0], text, null);
    }
  } catch (e) { /* */ }
});

// --- MESSAGING ---
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  switch (message.action) {
    case 'openSidePanel':
      handleOpenSidePanel(message, sender, sendResponse);
      break;

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

// --- REWRITE HANDLER ---
async function handleRewrite(message, sender, sendResponse) {
  var controller = new AbortController();
  var timeoutId = setTimeout(function() { controller.abort(); }, API_CONFIG.TIMEOUT_MS);

  try {
    var storage = await chrome.storage.local.get([
      STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE
    ]);
    var apiKey = storage[STORAGE_KEYS.API_KEY];
    if (!apiKey) { clearTimeout(timeoutId); sendResponse({ success: false, error: ERROR_MESSAGES.NO_API_KEY }); return; }

    var model = storage[STORAGE_KEYS.MODEL] || API_CONFIG.MODEL;
    var temperature = storage[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(storage[STORAGE_KEYS.TEMPERATURE]) : API_CONFIG.TEMPERATURE;
    var messages = buildMessages(message.style || 'close', message.text);

    var response = await fetch(API_CONFIG.BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, messages: messages, stream: false, max_tokens: API_CONFIG.MAX_TOKENS, temperature: temperature }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      var eb = ''; try { eb = await response.text(); } catch (e) { /* */ }
      var ei = parseApiError(response.status, eb);
      sendResponse({ success: false, error: ei.message });
      return;
    }

    var data = await response.json();
    var raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

    if (!raw) { sendResponse({ success: false, error: ERROR_MESSAGES.EMPTY_RESPONSE }); return; }

    var parsed = parseRewriteResponse(raw);
    sendResponse({ success: true, text: parsed.text, note: parsed.note || '' });

    saveSilent(message.text, parsed.text, message.style, parsed.note);

  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      sendResponse({ success: false, error: '请求超时（30秒），请检查网络连接后重试。' });
    } else {
      sendResponse({ success: false, error: e.message || ERROR_MESSAGES.NETWORK_ERROR });
    }
  }
}

// --- HELPERS ---

async function openSidePanelWithText(tab, text, style) {
  if (text) {
    await chrome.storage.session.set({
      pending_selected_text: text,
      pending_style: style || 'close',
      pending_tab_id: tab ? tab.id : null
    });
  }
  try { await chrome.sidePanel.open({ tabId: tab.id }); }
  catch (e) { await chrome.sidePanel.open({ windowId: tab.windowId }); }
}

async function handleOpenSidePanel(message, sender, sendResponse) {
  var tabId = sender.tab ? sender.tab.id : null;
  if (message.text) {
    await chrome.storage.session.set({
      pending_selected_text: message.text,
      pending_style: 'close',
      pending_tab_id: tabId
    });
  }
  try { await chrome.sidePanel.open({ tabId: tabId }); }
  catch (e) { if (sender.tab) await chrome.sidePanel.open({ windowId: sender.tab.windowId }); }
  sendResponse({ success: true });
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
  await saveSilent(original, rewritten, style, note);
  sendResponse({ success: true });
}

async function saveSilent(original, rewritten, style, note) {
  var r = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  var entries = r[STORAGE_KEYS.HISTORY] || [];
  var entry = {
    id: Date.now().toString(), timestamp: Date.now(),
    original: original.slice(0, 200) + (original.length > 200 ? '...' : ''),
    originalFull: original, rewritten: rewritten, style: style, note: note || ''
  };
  entries.unshift(entry);
  if (entries.length > HISTORY_MAX_ENTRIES) entries = entries.slice(0, HISTORY_MAX_ENTRIES);
  await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: entries });
}
