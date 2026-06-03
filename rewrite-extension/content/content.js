var floatingCard = null;
var selectionText = '';
var targetElement = null;
var targetElementInfo = null;
var isCardVisible = false;
var cardResults = {};
var cardNotes = {};
var shiftPresses = [];
var ctrlPresses = [];
var ctrlComboUsed = false;
var lastSelection = { text: '', element: null, info: null };
var currentTargetLang = 'en'; // 'en' or 'zh'

function initAiRewriter() { createFloatingCard(); setupListeners(); }
initAiRewriter();

// ─── CREATE CARD ───
function createFloatingCard() {
  if (document.getElementById('ai-rewriter-floating-card')) return;
  floatingCard = document.createElement('div');
  floatingCard.id = 'ai-rewriter-floating-card';

  var styles = [
    { key: 'close', icon: '📝', labelEn: 'Close to Original', labelZh: '贴近原文', hintEn: 'polish, keep structure', hintZh: '保持原意，仅润色优化' },
    { key: 'casual', icon: '💬', labelEn: 'Casual', labelZh: '口语化', hintEn: 'conversational style', hintZh: '轻松自然的对话风格' },
    { key: 'formal', icon: '🏛️', labelEn: 'Formal', labelZh: '正式', hintEn: 'professional tone', hintZh: '专业商务书面表达' }
  ];

  var h = '<div class="card-header"><span class="card-header-text" id="cardTitle">Rewrite</span><button class="card-close">×</button></div>';
  h += '<div class="card-preview" id="cardPreview"></div><div class="card-results">';

  styles.forEach(function(s) {
    h += '<div class="result-panel" data-style="' + s.key + '">';
    h += '<div class="result-panel-header" data-toggle="' + s.key + '">';
    h += '<span class="panel-style-label"><span class="panel-style-icon">' + s.icon + '</span><span class="panel-label-text">' + s.labelEn + '</span></span>';
    h += '<span class="panel-status">' + s.hintEn + '</span></div>';
    h += '<div class="result-panel-body open" id="panelBody-' + s.key + '">';
    h += '<div class="result-panel-loading" id="panelLoading-' + s.key + '"><span class="mini-spinner"></span>改写中...</div>';
    h += '<div class="result-panel-error hidden" id="panelError-' + s.key + '"></div>';
    h += '<div class="result-panel-content" id="panelContent-' + s.key + '"></div>';
    h += '<div class="result-panel-note" id="panelNote-' + s.key + '"></div>';
    h += '<div class="result-panel-actions" id="panelActions-' + s.key + '">';
    h += '<button class="panel-action-btn primary panel-replace-btn" data-style="' + s.key + '">🔄 替换</button>';
    h += '<button class="panel-action-btn panel-copy-btn" data-style="' + s.key + '">📋 复制</button>';
    h += '</div></div></div>';
  });
  h += '</div>';
  floatingCard.innerHTML = h;
  document.body.appendChild(floatingCard);

  floatingCard.querySelector('.card-close').addEventListener('click', hideCard);
  floatingCard.querySelectorAll('.result-panel-header').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      floatingCard.querySelector('#panelBody-' + hdr.dataset.toggle).classList.toggle('open');
    });
  });
  floatingCard.querySelectorAll('.panel-copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); doCopy(cardResults[btn.dataset.style], btn); });
  });
  floatingCard.querySelectorAll('.panel-replace-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); doReplace(btn.dataset.style, btn); });
  });
  document.addEventListener('mousedown', function(e) { if (isCardVisible && !floatingCard.contains(e.target)) hideCard(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && isCardVisible) hideCard(); });
  document.addEventListener('scroll', function() { if (isCardVisible) hideCard(); }, true);
}

// ─── LISTENERS ───
function setupListeners() {
  // Selection tracking
  document.addEventListener('mouseup', function(e) {
    setTimeout(function() {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        var s = e.target.selectionStart, end = e.target.selectionEnd;
        if (s !== undefined && end !== undefined && s < end) {
          lastSelection.text = e.target.value.substring(s, end);
          lastSelection.element = e.target; lastSelection.info = getInfo(e.target);
          return;
        }
      }
      updateLastSelection();
    }, 80);
  });

  document.addEventListener('keyup', function(e) {
    if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
      setTimeout(function() {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
          var s = e.target.selectionStart, end = e.target.selectionEnd;
          if (s !== undefined && end !== undefined && s < end) {
            lastSelection.text = e.target.value.substring(s, end);
            lastSelection.element = e.target; lastSelection.info = getInfo(e.target);
            return;
          }
        }
        updateLastSelection();
      }, 100);
    }
    if (e.key.startsWith('Arrow') && e.shiftKey) { setTimeout(updateLastSelection, 80); }
    if (e.key === 'Shift') {
      var cutoff = Date.now() - 800;
      shiftPresses = shiftPresses.filter(function(t) { return t > cutoff; });
    }
  });

  document.addEventListener('selectionchange', updateLastSelection);

  // ===== DOUBLE-SHIFT (English output) =====
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Shift' || e.repeat) return;
    var now = Date.now();
    shiftPresses.push(now);
    if (shiftPresses.length > 2) shiftPresses = shiftPresses.slice(-2);
    if (shiftPresses.length === 2 && (shiftPresses[1] - shiftPresses[0]) < 500) {
      shiftPresses = [];
      currentTargetLang = 'en';
      captureCurrentSelection();
      if (lastSelection.text) {
        selectionText = lastSelection.text;
        targetElement = lastSelection.element;
        targetElementInfo = lastSelection.info;
        showCard(lastSelection.text, 'en');
      }
    }
  }, true);

  // ===== DOUBLE-CTRL (Chinese output) =====
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Control') {
      if (!e.repeat) { ctrlPresses.push(Date.now()); ctrlComboUsed = false; }
      if (ctrlPresses.length > 4) ctrlPresses = ctrlPresses.slice(-4);
    }
    // Any other key pressed while Ctrl is held = it's a shortcut (Ctrl+C etc)
    if (e.key !== 'Control' && e.ctrlKey) { ctrlComboUsed = true; }
  }, true);

  document.addEventListener('keyup', function(e) {
    if (e.key === 'Control') {
      if (ctrlComboUsed) {
        // Ctrl was used in a combo shortcut — clear taps
        ctrlPresses = [];
        ctrlComboUsed = false;
      } else if (ctrlPresses.length >= 2) {
        var last = ctrlPresses[ctrlPresses.length - 1];
        var prev = ctrlPresses[ctrlPresses.length - 2];
        if (last - prev < 500) {
          ctrlPresses = [];
          currentTargetLang = 'zh';
          captureCurrentSelection();
          if (lastSelection.text) {
            selectionText = lastSelection.text;
            targetElement = lastSelection.element;
            targetElementInfo = lastSelection.info;
            showCard(lastSelection.text, 'zh');
          }
        }
      }
      // Clean old presses
      var cutoff = Date.now() - 800;
      ctrlPresses = ctrlPresses.filter(function(t) { return t > cutoff; });
    }
  }, true);

  // Messages from service worker
  chrome.runtime.onMessage.addListener(function(m, s, r) {
    if (m.action === 'replaceText') {
      var el = targetElement;
      if (!el && m.elementInfo) { try { el = document.querySelector(m.elementInfo.selector); } catch (e) { /* */ } }
      if (!el) {
        var ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('[contenteditable="true"]'))) {
          el = ae;
        }
      }
      r({ success: el ? replaceInElement(el, m.text) : false });
      return true;
    }
  });
}

function captureCurrentSelection() {
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    var s = ae.selectionStart, e = ae.selectionEnd;
    if (s !== undefined && e !== undefined && s < e) {
      lastSelection.text = ae.value.substring(s, e);
      lastSelection.element = ae; lastSelection.info = getInfo(ae);
      return;
    }
  }
  updateLastSelection();
}

function updateLastSelection() {
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
    var s = ae.selectionStart, e = ae.selectionEnd;
    if (s !== undefined && e !== undefined && s < e) {
      lastSelection.text = ae.value.substring(s, e);
      lastSelection.element = ae; lastSelection.info = getInfo(ae);
      return;
    }
  }
  if (ae && (ae.isContentEditable || ae.closest('[contenteditable="true"]'))) {
    var sel = window.getSelection(), t = sel.toString().trim();
    if (t) { lastSelection.text = t; lastSelection.element = getTargetFromSelection(sel); lastSelection.info = getInfo(lastSelection.element); return; }
  }
  var sel = window.getSelection(), t = sel.toString().trim();
  if (t) { lastSelection.text = t; lastSelection.element = getTargetFromSelection(sel); lastSelection.info = getInfo(lastSelection.element); }
}

// ─── TARGET ───
function getTargetFromSelection(sel) {
  if (!sel.rangeCount) return null;
  var el = sel.getRangeAt(0).commonAncestorContainer;
  while (el && el.nodeType === 3) el = el.parentElement;
  if (!el) return null;
  var t = el.tagName ? el.tagName.toLowerCase() : '';
  if (t === 'textarea' || t === 'input') return el;
  if (el.isContentEditable) return el;
  return el.closest('textarea, input, [contenteditable="true"]') || null;
}
function getInfo(el) {
  if (!el) return null;
  var t = el.tagName ? el.tagName.toLowerCase() : '', s = t;
  if (el.id) s = '#' + CSS.escape(el.id);
  else if (el.name) s = t + '[name="' + CSS.escape(el.name) + '"]';
  else if (el.className && typeof el.className === 'string') {
    var cs = el.className.trim().split(/\s+/).slice(0, 3).map(function(c) { return '.' + CSS.escape(c); }).join('');
    if (cs) s += cs;
  }
  if (el.placeholder) s += '[placeholder="' + CSS.escape(el.placeholder) + '"]';
  return { tagName: t, selector: s, isContentEditable: el.isContentEditable || false };
}

// ─── SHOW CARD ───
function showCard(text, targetLang) {
  currentTargetLang = targetLang || 'en';
  var isZh = currentTargetLang === 'zh';

  // Update header and labels
  floatingCard.querySelector('#cardTitle').textContent = isZh ? 'Rewrite — 中文' : 'Rewrite — English';

  var styles = ['close', 'casual', 'formal'];
  var labelsEn = ['Close to Original', 'Casual', 'Formal'];
  var labelsZh = ['贴近原文', '口语化', '正式'];
  var hintsEn = ['polish, keep structure', 'conversational style', 'professional tone'];
  var hintsZh = ['保持原意，仅润色优化', '轻松自然的对话风格', '专业商务书面表达'];

  styles.forEach(function(s, i) {
    var labelEl = floatingCard.querySelector('.result-panel[data-style="' + s + '"] .panel-label-text');
    var hintEl = floatingCard.querySelector('.result-panel[data-style="' + s + '"] .panel-status');
    if (labelEl) labelEl.textContent = isZh ? labelsZh[i] : labelsEn[i];
    if (hintEl) hintEl.textContent = isZh ? hintsZh[i] : hintsEn[i];
  });

  floatingCard.style.left = '50%'; floatingCard.style.top = '50%';
  floatingCard.style.transform = 'translate(-50%, -50%)';
  floatingCard.style.display = 'flex'; isCardVisible = true;
  cardResults = {}; cardNotes = {};
  floatingCard.querySelector('#cardPreview').textContent = text.length > 120 ? text.slice(0, 120) + '...' : text;

  styles.forEach(function(s) {
    floatingCard.querySelector('#panelBody-' + s).classList.add('open');
    floatingCard.querySelector('#panelLoading-' + s).classList.remove('done');
    floatingCard.querySelector('#panelError-' + s).classList.add('hidden');
    floatingCard.querySelector('#panelContent-' + s).textContent = '';
    floatingCard.querySelector('#panelNote-' + s).textContent = '';
    floatingCard.querySelector('#panelNote-' + s).classList.remove('visible');
    floatingCard.querySelector('#panelActions-' + s).classList.remove('visible');
    var st = floatingCard.querySelector('.result-panel[data-style="' + s + '"] .panel-status');
    if (st) st.textContent = '改写中...';
    callDeepSeek(s, text, currentTargetLang);
  });
}
function hideCard() { floatingCard.style.display = 'none'; isCardVisible = false; }

// ─── DIRECT API CALL ───
async function callDeepSeek(style, text, targetLang) {
  try {
    var stg = await chrome.storage.local.get([STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE]);
    var apiKey = stg[STORAGE_KEYS.API_KEY];
    if (!apiKey) { showErr(style, '请先在扩展设置中配置 DeepSeek API Key'); setStatus(style, '无 API Key'); return; }

    var model = stg[STORAGE_KEYS.MODEL] || 'deepseek-v4-flash';
    var temp = stg[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(stg[STORAGE_KEYS.TEMPERATURE]) : 0.7;
    var msgs = buildMessagesFor(style, text, targetLang);

    var ctrl = new AbortController();
    var tid = setTimeout(function() { ctrl.abort(); }, 30000);

    var resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: model, messages: msgs, stream: false, max_tokens: 4096, temperature: temp }),
      signal: ctrl.signal
    });
    clearTimeout(tid);
    document.getElementById('panelLoading-' + style).classList.add('done');

    if (!resp.ok) {
      var eb = ''; try { eb = await resp.text(); } catch (e) { /* */ }
      showErr(style, parseApiError(resp.status, eb).message); setStatus(style, '失败'); return;
    }

    var data = await resp.json();
    var raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) { showErr(style, ERROR_MESSAGES.EMPTY_RESPONSE); setStatus(style, '空响应'); return; }

    var parsed = parseRewriteResponse(raw);
    cardResults[style] = parsed.text; cardNotes[style] = parsed.note || '';
    saveToHistory(text, parsed.text, style, parsed.note || '');
    document.getElementById('panelContent-' + style).textContent = parsed.text;
    if (parsed.note) {
      document.getElementById('panelNote-' + style).textContent = parsed.note;
      document.getElementById('panelNote-' + style).classList.add('visible');
    }
    document.getElementById('panelActions-' + style).classList.add('visible');
    var rb = floatingCard.querySelector('.panel-replace-btn[data-style="' + style + '"]');
    if (rb) rb.style.display = (targetElement || targetElementInfo) ? '' : 'none';
    setStatus(style, '✓ 完成');
  } catch (e) {
    document.getElementById('panelLoading-' + style).classList.add('done');
    showErr(style, e.name === 'AbortError' ? '请求超时（30秒），请检查网络后重试' : (e.message || '网络错误'));
    setStatus(style, '失败');
  }
}

function showErr(style, msg) { var e = document.getElementById('panelError-' + style); if (e) { e.textContent = msg; e.classList.remove('hidden'); } }
function setStatus(style, txt) { var s = floatingCard.querySelector('.result-panel[data-style="' + style + '"] .panel-status'); if (s) s.textContent = txt; }

// ─── REPLACE ───
function doReplace(style, btn) {
  var t = cardResults[style]; if (!t) return;
  if (!targetElement && targetElementInfo) { try { targetElement = document.querySelector(targetElementInfo.selector); } catch (e) { /* */ } }
  if (!targetElement) {
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) targetElement = ae;
  }
  if (!targetElement) return;
  var ok = replaceInElement(targetElement, t);
  btn.textContent = ok ? '✅ 已替换' : '❌ 失败'; btn.disabled = true;
  setTimeout(function() { btn.textContent = '🔄 替换'; btn.disabled = false; }, 1500);
}

function replaceInElement(el, newText) {
  try {
    var tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      var start = el.selectionStart || 0, end = el.selectionEnd || el.value.length;
      if (start < end && el.value.substring(start, end) === selectionText) { el.setRangeText(newText, start, end, 'select'); }
      else { el.value = newText; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable || el.closest('[contenteditable="true"]')) {
      var ed = el.isContentEditable ? el : el.closest('[contenteditable="true"]');
      if (!ed) return false;
      var sel = window.getSelection(), rng = document.createRange();
      if (selectionText && ed.textContent.indexOf(selectionText) >= 0) {
        var si = ed.textContent.indexOf(selectionText);
        var ni = getTextNode(ed, si, si + selectionText.length);
        if (ni) { rng.setStart(ni.node, ni.startOffset); rng.setEnd(ni.node, ni.endOffset); }
        else rng.selectNodeContents(ed);
      } else rng.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(rng);
      if (document.queryCommandSupported('insertText')) document.execCommand('insertText', false, newText);
      else ed.textContent = newText;
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  } catch (e) { return false; }
}

function getTextNode(el, so, eo) {
  var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false), cc = 0, n;
  while (n = w.nextNode()) { var l = n.textContent.length; if (so >= cc && so <= cc + l) return { node: n, startOffset: so - cc, endOffset: Math.min(eo - cc, l) }; cc += l; }
  return null;
}

// ─── COPY ───
function doCopy(text, btn) {
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() { flashBtn(btn, '✅ 已复制'); }).catch(function() { fbCopy(text, btn); });
  } else fbCopy(text, btn);
}
function fbCopy(text, btn) {
  try { var ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px'; ta.setAttribute('readonly',''); document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, ta.value.length); document.execCommand('copy'); document.body.removeChild(ta); flashBtn(btn, '✅ 已复制'); } catch (e) { flashBtn(btn, '❌'); }
}
function flashBtn(btn, txt) { btn.textContent = txt; setTimeout(function() { btn.textContent = '📋 复制'; }, 2000); }
