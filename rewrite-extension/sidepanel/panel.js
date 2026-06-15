function $(id) { return document.getElementById(id); }
var sideResults = {};
var pendingTabId = null;

document.addEventListener('DOMContentLoaded', async function() {
  var pendingText = null;
  try {
    var r = await chrome.storage.session.get(['pending_selected_text', 'pending_style', 'pending_tab_id']);
    if (r.pending_selected_text) {
      pendingText = r.pending_selected_text;
      $('sourceText').value = r.pending_selected_text;
      $('rewriteBtn').disabled = false;
    }
    if (r.pending_tab_id) pendingTabId = r.pending_tab_id;
    // pending_style is consumed implicitly: sidepanel output is always English.
    // Clear the session keys once read.
    chrome.storage.session.remove(['pending_selected_text', 'pending_style', 'pending_tab_id']);
  } catch (e) { /* */ }

  // If no text from session storage, try to get selection from active tab
  if (!$('sourceText').value.trim()) {
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs.length && tabs[0].id) {
        pendingTabId = tabs[0].id;
        var resp = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getSelection' });
        if (resp && resp.text) {
          $('sourceText').value = resp.text;
          $('rewriteBtn').disabled = false;
        }
      }
    } catch (e) { /* content script not ready or page restricted, ignore */ }
  }

  setupEvents();

  // Auto-trigger rewrite when launched from the context menu with selected text.
  // This honors pending_selected_text instead of just pre-filling the textarea.
  if (pendingText && pendingText.trim()) {
    doRewrite(pendingText.trim());
  }
});

function setupEvents() {
  $('rewriteBtn').addEventListener('click', function() { var t = $('sourceText').value.trim(); if (t) doRewrite(t); });
  $('sourceText').addEventListener('keydown', function(e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); var t = $('sourceText').value.trim(); if (t) doRewrite(t); } });
  $('sourceText').addEventListener('input', function() { $('rewriteBtn').disabled = !$('sourceText').value.trim(); });
  $('clearSourceBtn').addEventListener('click', function() { $('sourceText').value = ''; $('rewriteBtn').disabled = true; $('resultsArea').classList.add('hidden'); $('historyPanel').classList.add('hidden'); });
  $('speakSourceBtn').addEventListener('click', function() {
    var text = $('sourceText').value.trim();
    if (!text) return;
    var btn = $('speakSourceBtn');
    if (TTS.isSpeaking()) { TTS.stop(); resetSpBtn(btn); return; }
    getTtsRate().then(function(rate) {
      TTS.speak(text, 'auto', {
        onStart: function() { btn.textContent = '⏹️ 停止'; btn.classList.add('speaking'); },
        onEnd: function() { resetSpBtn(btn); },
        onError: function() { resetSpBtn(btn); }
      }, rate);
    });
  });

  document.querySelectorAll('.rp-header').forEach(function(h) {
    h.addEventListener('click', function() { $('rpBody-' + h.dataset.toggle).classList.toggle('open'); });
  });
  document.querySelectorAll('.rp-speak-btn').forEach(function(b) {
    b.addEventListener('click', function(e) {
      e.stopPropagation();
      var text = sideResults[b.dataset.style];
      if (!text) return;
      if (TTS.isSpeaking()) { TTS.stop(); resetAllSpBtns(); return; }
      getTtsRate().then(function(rate) {
        TTS.speak(text, 'en-US', {
          onStart: function() { b.textContent = '⏹️ 停止'; b.classList.add('speaking'); },
          onEnd: function() { resetAllSpBtns(); },
          onError: function() { resetAllSpBtns(); }
        }, rate);
      });
    });
  });
  document.querySelectorAll('.rp-copy-btn').forEach(function(b) {
    b.addEventListener('click', function(e) { e.stopPropagation(); doCopy(sideResults[b.dataset.style], b); });
  });
  document.querySelectorAll('.rp-replace-btn').forEach(function(b) {
    b.addEventListener('click', function(e) {
      e.stopPropagation(); var t = sideResults[b.dataset.style]; if (!t) return;
      b.textContent = '⏳ 替换中...';
      chrome.runtime.sendMessage({ action: 'replaceText', text: t, tabId: pendingTabId }, function(r) {
        b.textContent = (r && r.success) ? '✅ 已替换' : '❌ 失败';
        setTimeout(function() { b.textContent = '🔄 替换到页面'; }, 2000);
      });
    });
  });

  $('settingsBtn').addEventListener('click', function() { chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') }); });
  $('openSettings').addEventListener('click', function(e) { e.preventDefault(); chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') }); });
  $('historyToggle').addEventListener('click', toggleHistory);
  $('clearHistoryBtn').addEventListener('click', clearHistory);
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && !$('historyPanel').classList.contains('hidden')) { $('historyPanel').classList.add('hidden'); $('resultsArea').classList.remove('hidden'); } });
}

// ─── DIRECT API CALL ───
async function doRewrite(text) {
  sideResults = {};
  $('resultsArea').classList.remove('hidden'); $('historyPanel').classList.add('hidden');
  $('rewriteBtn').disabled = true; $('rewriteBtn').innerHTML = '<span class="mini-spinner"></span> 改写中...';

  ['close','casual','formal'].forEach(function(s) {
    $('rpLoading-' + s).classList.remove('done'); $('rpError-' + s).classList.add('hidden');
    $('rpContent-' + s).textContent = ''; $('rpNote-' + s).textContent = '';
    $('rpNote-' + s).classList.remove('visible'); $('rpActions-' + s).classList.remove('visible');
    document.querySelector('.result-panel[data-style="' + s + '"] .rp-status').textContent = '改写中...';
    $('rpBody-' + s).classList.add('open');
    callApi(s, text);
  });
}

// ─── REWRITE VIA SHARED SERVICE ───
async function callApi(style, text) {
  try {
    var stg = await chrome.storage.local.get([STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE]);
    var apiKey = stg[STORAGE_KEYS.API_KEY];
    if (!apiKey) { showSErr(style, '请先在扩展设置中配置 DeepSeek API Key'); setSStat(style, '无 API Key'); checkDone(); return; }

    var model = stg[STORAGE_KEYS.MODEL] || 'deepseek-v4-flash';
    var temp = stg[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(stg[STORAGE_KEYS.TEMPERATURE]) : 0.7;

    // No external AbortController/timeout: rewrite-service.js owns per-attempt
    // timeout (REWRITE_TIMEOUT_MS) and the retry loop. An external timeout
    // would abort retries prematurely.
    var panelContent = $('rpContent-' + style);

    var result = await rewriteText({
      text: text,
      style: style,
      targetLang: 'en',
      apiKey: apiKey,
      model: model,
      temperature: temp,
      stream: true,
      onToken: function(delta, accumulated) {
        if (panelContent) panelContent.textContent = accumulated;
      }
    });

    $('rpLoading-' + style).classList.add('done');

    sideResults[style] = result.text;
    saveToHistory(text, result.text, style, result.note || '');
    $('rpContent-' + style).textContent = result.text;
    if (result.note) { $('rpNote-' + style).textContent = result.note; $('rpNote-' + style).classList.add('visible'); }
    $('rpActions-' + style).classList.add('visible');
    setSStat(style, '✓ 完成');

  } catch (e) {
    $('rpLoading-' + style).classList.add('done');
    showSErr(style, (e && e.name === 'AbortError') ? '请求超时，请检查网络后重试' : ((e && e.message) || '网络错误'));
    setSStat(style, '失败');
  }
  checkDone();
}

function showSErr(style, msg) { var e = $('rpError-' + style); e.textContent = msg; e.classList.remove('hidden'); }
function setSStat(style, txt) { var s = document.querySelector('.result-panel[data-style="' + style + '"] .rp-status'); if (s) s.textContent = txt; }
function checkDone() {
  var all = ['close','casual','formal'].every(function(s) { return $('rpLoading-' + s).classList.contains('done'); });
  if (all) { $('rewriteBtn').disabled = false; $('rewriteBtn').innerHTML = '<span>✨ 改写</span>'; }
}

// ─── HISTORY ───
function toggleHistory() {
  if ($('historyPanel').classList.contains('hidden')) {
    $('resultsArea').classList.add('hidden');
    $('historyPanel').classList.remove('hidden');
    loadHistory();
  } else {
    $('historyPanel').classList.add('hidden');
    $('resultsArea').classList.remove('hidden');
  }
}
async function loadHistory() {
  var r = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
  var entries = r[STORAGE_KEYS.HISTORY] || [];
  console.log('[History] Loaded entries:', entries.length, entries);
  var list = $('historyList'); list.innerHTML = '';
  if (!entries.length) { $('emptyHistory').classList.remove('hidden'); return; }
  $('emptyHistory').classList.add('hidden');
  entries.forEach(function(e) {
    var si = REWRITE_STYLES[e.style] || REWRITE_STYLES.close;
    var div = document.createElement('div'); div.className = 'history-item';
    div.innerHTML = '<div class="history-item-header"><span class="history-style">' + si.icon + ' ' + si.label_cn + '</span><span class="history-time">' + new Date(e.timestamp).toLocaleString('zh-CN') + '</span></div>' +
      '<div class="history-original">' + esc(e.original) + '</div><div class="history-rewritten">' + esc(e.rewritten.slice(0,180)) + (e.rewritten.length>180?'...':'') + '</div>' +
      (e.note ? '<div class="history-note">' + esc(e.note) + '</div>' : '') +
      '<div class="history-item-actions"><button class="history-copy-btn" data-text="' + encodeURIComponent(e.rewritten) + '">📋 复制</button><button class="history-delete-btn" data-id="' + e.id + '">🗑️</button></div>';
    list.appendChild(div);
  });
  list.querySelectorAll('.history-copy-btn').forEach(function(b) { b.addEventListener('click', function() { doCopy(decodeURIComponent(b.dataset.text), b); }); });
  // Re-read current history on each delete to avoid races between rapid
  // successive deletes sharing a stale closure over `entries`.
  list.querySelectorAll('.history-delete-btn').forEach(function(b) {
    b.addEventListener('click', async function() {
      try {
        var id = b.dataset.id;
        var rr = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
        var cur = (rr[STORAGE_KEYS.HISTORY] || []).filter(function(x) { return x.id !== id; });
        await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: cur });
        loadHistory();
      } catch (e) { /* ignore */ }
    });
  });
}
async function clearHistory() { if (!confirm('确定清除全部历史记录？')) return; var s = {}; s[STORAGE_KEYS.HISTORY] = []; await chrome.storage.local.set(s); loadHistory(); }

// ─── COPY ───
function doCopy(text, btn) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() { flash(btn); }).catch(function() { fbCopy(text, btn); });
  } else fbCopy(text, btn);
}
function fbCopy(text, btn) { try { var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'; ta.setAttribute('readonly',''); document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); document.execCommand('copy'); document.body.removeChild(ta); flash(btn); } catch (e) { btn.textContent = '❌'; setTimeout(function() { btn.textContent = '📋 复制'; }, 2000); } }
function flash(btn) { btn.textContent = '✅ 已复制'; setTimeout(function() { btn.textContent = '📋 复制'; }, 2000); }
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ─── TTS button helpers ───
function resetSpBtn(btn) { btn.textContent = '🔊 朗读'; btn.classList.remove('speaking'); }
function resetAllSpBtns() {
  document.querySelectorAll('.rp-speak-btn').forEach(function(b) { resetSpBtn(b); });
  var src = $('speakSourceBtn');
  if (src) resetSpBtn(src);
}
function getTtsRate() {
  return chrome.storage.local.get(STORAGE_KEYS.TTS_RATE).then(function(r) {
    var v = r[STORAGE_KEYS.TTS_RATE];
    return (v != null) ? parseFloat(v) : 0.85;
  }).catch(function() { return 0.85; });
}
