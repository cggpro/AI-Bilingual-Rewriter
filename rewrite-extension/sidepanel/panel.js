function $(id) { return document.getElementById(id); }
var sideResults = {};
var pendingTabId = null;

document.addEventListener('DOMContentLoaded', async function() {
  try {
    var r = await chrome.storage.session.get(['pending_selected_text', 'pending_tab_id']);
    if (r.pending_selected_text) { $('sourceText').value = r.pending_selected_text; $('rewriteBtn').disabled = false; }
    if (r.pending_tab_id) pendingTabId = r.pending_tab_id;
    chrome.storage.session.remove(['pending_selected_text', 'pending_style', 'pending_tab_id']);
  } catch (e) { /* */ }
  setupEvents();
});

function setupEvents() {
  $('rewriteBtn').addEventListener('click', function() { var t = $('sourceText').value.trim(); if (t) doRewrite(t); });
  $('sourceText').addEventListener('keydown', function(e) { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); var t = $('sourceText').value.trim(); if (t) doRewrite(t); } });
  $('sourceText').addEventListener('input', function() { $('rewriteBtn').disabled = !$('sourceText').value.trim(); });
  $('clearSourceBtn').addEventListener('click', function() { $('sourceText').value = ''; $('rewriteBtn').disabled = true; $('resultsArea').classList.add('hidden'); $('historyPanel').classList.add('hidden'); });

  document.querySelectorAll('.rp-header').forEach(function(h) {
    h.addEventListener('click', function() { $('rpBody-' + h.dataset.toggle).classList.toggle('open'); });
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

  $('settingsBtn').addEventListener('click', function() { chrome.runtime.openOptionsPage(); });
  $('openSettings').addEventListener('click', function(e) { e.preventDefault(); chrome.runtime.openOptionsPage(); });
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

async function callApi(style, text) {
  try {
    var stg = await chrome.storage.local.get([STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE]);
    var apiKey = stg[STORAGE_KEYS.API_KEY];
    if (!apiKey) { showSErr(style, '请先在扩展设置中配置 DeepSeek API Key'); setSStat(style, '无 API Key'); checkDone(); return; }

    var model = stg[STORAGE_KEYS.MODEL] || 'deepseek-v4-flash';
    var temp = stg[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(stg[STORAGE_KEYS.TEMPERATURE]) : 0.7;
    var msgs = buildMessages(style, text);

    var ctrl = new AbortController(); var tid = setTimeout(function() { ctrl.abort(); }, 30000);
    var resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, messages: msgs, stream: false, max_tokens: 4096, temperature: temp }),
      signal: ctrl.signal
    });
    clearTimeout(tid);
    $('rpLoading-' + style).classList.add('done');

    if (!resp.ok) { var eb = ''; try { eb = await resp.text(); } catch (e) { /* */ } showSErr(style, parseApiError(resp.status, eb).message); setSStat(style, '失败'); checkDone(); return; }

    var data = await resp.json();
    var raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) { showSErr(style, ERROR_MESSAGES.EMPTY_RESPONSE); setSStat(style, '空响应'); checkDone(); return; }

    var parsed = parseRewriteResponse(raw);
    sideResults[style] = parsed.text;
    saveToHistory(text, parsed.text, style, parsed.note || '');
    $('rpContent-' + style).textContent = parsed.text;
    if (parsed.note) { $('rpNote-' + style).textContent = parsed.note; $('rpNote-' + style).classList.add('visible'); }
    $('rpActions-' + style).classList.add('visible');
    setSStat(style, '✓ 完成');

  } catch (e) {
    $('rpLoading-' + style).classList.add('done');
    showSErr(style, e.name === 'AbortError' ? '请求超时（30秒），请检查网络后重试' : (e.message || '网络错误'));
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
  list.querySelectorAll('.history-delete-btn').forEach(function(b) { b.addEventListener('click', function() { entries = entries.filter(function(x) { return x.id !== b.dataset.id; }); chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: entries }); loadHistory(); }); });
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
