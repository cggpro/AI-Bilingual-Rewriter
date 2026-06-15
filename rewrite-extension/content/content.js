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
var lastFocusedInput = null; // 追踪最后聚焦的输入框，避免百度建议层干扰
var currentTargetLang = 'en'; // 'en' or 'zh'
var activeRequests = {};      // style -> AbortController, 用于在 hideCard 时取消在途请求

function initAiRewriter() {
  // 消息监听在所有 frame 注册：iframe 编辑器仍需响应 getSelection/replaceText
  setupMessageListeners();
  // UI 与手势监听仅在顶层 frame，避免每个 iframe 重复创建卡片和监听器
  if (window.self !== window.top) return;
  createFloatingCard();
  setupUiListeners();
}
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

  var h = '<div class="card-header"><span class="card-header-text" id="cardTitle">Rewrite</span><button class="card-speak-original" id="cardSpeakOriginal" title="朗读原文">🔊</button><button class="card-settings-btn" id="cardSettingsBtn" title="设置">⚙️</button><button class="card-close">×</button></div>';
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
    h += '</div>';
    h += '<div class="result-panel-actions" id="panelActions-' + s.key + '">';
    h += '<button class="panel-action-btn primary panel-replace-btn" data-style="' + s.key + '">🔄 替换</button>';
    h += '<button class="panel-action-btn panel-speak-btn" data-style="' + s.key + '">🔊 朗读</button>';
    h += '<button class="panel-action-btn panel-copy-btn" data-style="' + s.key + '">📋 复制</button>';
    h += '</div></div>';
  });
  h += '</div>';
  floatingCard.innerHTML = h;
  document.body.appendChild(floatingCard);

  floatingCard.querySelector('.card-close').addEventListener('click', hideCard);
  floatingCard.querySelector('#cardSettingsBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    console.log('[rewrite] Settings button clicked');
    var settingsUrl = chrome.runtime.getURL('settings/settings.html');
    var done = false;
    // Try sending message to service worker first
    try {
      chrome.runtime.sendMessage({ action: 'openOptionsPage' }, function(response) {
        if (!done) {
          done = true;
          if (chrome.runtime.lastError) {
            console.warn('[rewrite] SW message failed, using direct open:', chrome.runtime.lastError.message);
            openSettingsDirect(settingsUrl);
          } else {
            console.log('[rewrite] SW opened settings:', response);
          }
        }
      });
    } catch (err) {
      console.warn('[rewrite] sendMessage threw, using direct open:', err);
      if (!done) { done = true; openSettingsDirect(settingsUrl); }
    }
    // Fallback: if SW doesn't respond within 500ms, open directly
    setTimeout(function() {
      if (!done) {
        done = true;
        console.warn('[rewrite] SW timeout, opening directly');
        openSettingsDirect(settingsUrl);
      }
    }, 500);
    function openSettingsDirect(url) {
      var a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { document.body.removeChild(a); }, 100);
    }
  });
  floatingCard.querySelector('#cardSpeakOriginal').addEventListener('click', function() {
    var text = selectionText;
    if (!text) return;
    var btn = floatingCard.querySelector('#cardSpeakOriginal');
    if (TTS.isSpeaking()) { TTS.stop(); resetSpeakBtn(btn); return; }
    getTtsRate().then(function(rate) {
      TTS.speak(text, 'auto', {
        onStart: function() { btn.textContent = '⏹️ 停止'; btn.classList.add('speaking'); },
        onEnd: function() { resetSpeakBtn(btn); },
        onError: function() { resetSpeakBtn(btn); }
      }, rate);
    });
  });
  floatingCard.querySelectorAll('.result-panel-header').forEach(function(hdr) {
    hdr.addEventListener('click', function() {
      floatingCard.querySelector('#panelBody-' + hdr.dataset.toggle).classList.toggle('open');
    });
  });
  floatingCard.querySelectorAll('.panel-copy-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); doCopy(cardResults[btn.dataset.style], btn); });
  });
  floatingCard.querySelectorAll('.panel-speak-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var style = btn.dataset.style;
      var text = cardResults[style];
      if (!text) return;
      if (TTS.isSpeaking()) { TTS.stop(); resetAllSpeakBtns(); return; }
      var lang = currentTargetLang === 'zh' ? 'zh-CN' : 'en-US';
      getTtsRate().then(function(rate) {
        TTS.speak(text, lang, {
          onStart: function() { btn.textContent = '⏹️ 停止'; btn.classList.add('speaking'); },
          onEnd: function() { resetAllSpeakBtns(); },
          onError: function() { resetAllSpeakBtns(); }
        }, rate);
      });
    });
  });
  floatingCard.querySelectorAll('.panel-replace-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); doReplace(btn.dataset.style, btn); });
  });
}

// ─── UI LISTENERS (top frame only) ───
function setupUiListeners() {
  // Card dismissal on outside interaction
  document.addEventListener('mousedown', function(e) { if (isCardVisible && !floatingCard.contains(e.target)) hideCard(); });
  document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && isCardVisible) hideCard(); });
  document.addEventListener('scroll', function(e) { if (isCardVisible && !floatingCard.contains(e.target)) hideCard(); }, true);

  // Track last focused input/textarea — handles Baidu/Google suggestion overlays
  document.addEventListener('focus', function(e) {
    var el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
      lastFocusedInput = el;
    }
  }, true);

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
    if (e.key && typeof e.key === 'string' && e.key.indexOf('Arrow') === 0 && e.shiftKey) { setTimeout(updateLastSelection, 80); }
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
}

// ─── MESSAGE LISTENERS (all frames) ───
function setupMessageListeners() {
  // Messages from service worker
  chrome.runtime.onMessage.addListener(function(m, s, r) {
    if (m.action === 'getSelection') {
      var sel = window.getSelection().toString().trim();
      var ae = document.activeElement;
      if (!sel && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
        sel = ae.value.substring(ae.selectionStart || 0, ae.selectionEnd || 0);
      }
      r({ text: sel });
      return true;
    }
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
  // Try activeElement first, fall back to lastFocusedInput (handles Baidu suggestion overlay)
  var el = getTargetInput();
  if (el) {
    var s = el.selectionStart, e = el.selectionEnd;
    if (s !== undefined && e !== undefined && s < e) {
      lastSelection.text = el.value.substring(s, e);
      lastSelection.element = el; lastSelection.info = getInfo(el);
      return;
    }
  }
  updateLastSelection();
}

// Get the real input element, falling back to lastFocusedInput
function getTargetInput() {
  var ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return ae;
  if (lastFocusedInput) {
    // Verify the tracked element is still in the DOM and has selection
    if (document.contains(lastFocusedInput)) {
      var s = lastFocusedInput.selectionStart, e = lastFocusedInput.selectionEnd;
      if (s !== undefined && e !== undefined && s < e) return lastFocusedInput;
    } else {
      lastFocusedInput = null;
    }
  }
  return null;
}

function updateLastSelection() {
  // Try activeElement first, fall back to lastFocusedInput
  var el = getTargetInput();
  if (el) {
    var s = el.selectionStart, e = el.selectionEnd;
    if (s !== undefined && e !== undefined && s < e) {
      lastSelection.text = el.value.substring(s, e);
      lastSelection.element = el; lastSelection.info = getInfo(el);
      return;
    }
  }
  var ae = document.activeElement;
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
function hideCard() {
  TTS.stop();
  // Cancel any in-flight rewrite requests so closing the card stops
  // consuming DeepSeek quota. (Per-attempt timeout is handled internally
  // by rewrite-service.js via REWRITE_TIMEOUT_MS.)
  Object.keys(activeRequests).forEach(function(style) {
    try { activeRequests[style].abort(); } catch (e) { /* ignore */ }
    delete activeRequests[style];
  });
  floatingCard.style.display = 'none';
  isCardVisible = false;
}
function resetSpeakBtn(btn) { btn.textContent = '🔊'; btn.classList.remove('speaking'); }
function resetAllSpeakBtns() {
  var btns = floatingCard.querySelectorAll('.panel-speak-btn');
  btns.forEach(function(b) { resetSpeakBtn(b); });
  var orig = floatingCard.querySelector('#cardSpeakOriginal');
  if (orig) resetSpeakBtn(orig);
}
function getTtsRate() {
  return chrome.storage.local.get(STORAGE_KEYS.TTS_RATE).then(function(r) {
    var v = r[STORAGE_KEYS.TTS_RATE];
    return (v != null) ? parseFloat(v) : 0.85;
  }).catch(function() { return 0.85; });
}

// ─── REWRITE VIA SHARED SERVICE ───
async function callDeepSeek(style, text, targetLang) {
  try {
    var stg = await chrome.storage.local.get([STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE]);
    var apiKey = stg[STORAGE_KEYS.API_KEY];
    if (!apiKey) { showErr(style, '请先在扩展设置中配置 DeepSeek API Key'); setStatus(style, '无 API Key'); return; }

    var model = stg[STORAGE_KEYS.MODEL] || 'deepseek-v4-flash';
    var temp = stg[STORAGE_KEYS.TEMPERATURE] != null ? parseFloat(stg[STORAGE_KEYS.TEMPERATURE]) : 0.7;

    // AbortController is tracked in activeRequests so hideCard() can cancel
    // in-flight requests. We intentionally do NOT add an external setTimeout
    // timeout here — rewrite-service.js owns per-attempt timeout + retry.
    // An external timeout would abort the retry loop prematurely.
    var ctrl = new AbortController();
    activeRequests[style] = ctrl;
    var panelContent = document.getElementById('panelContent-' + style);

    try {
      var result = await rewriteText({
        text: text,
        style: style,
        targetLang: targetLang,
        apiKey: apiKey,
        model: model,
        temperature: temp,
        stream: true,
        signal: ctrl.signal,
        onToken: function(delta, accumulated) {
          if (panelContent) panelContent.textContent = accumulated;
        }
      });

      document.getElementById('panelLoading-' + style).classList.add('done');

      cardResults[style] = result.text;
      cardNotes[style] = result.note || '';
      saveToHistory(text, result.text, style, result.note || '');
      document.getElementById('panelContent-' + style).textContent = result.text;
      if (result.note) {
        document.getElementById('panelNote-' + style).textContent = result.note;
        document.getElementById('panelNote-' + style).classList.add('visible');
      }
      document.getElementById('panelActions-' + style).classList.add('visible');
      var rb = floatingCard.querySelector('.panel-replace-btn[data-style="' + style + '"]');
      if (rb) rb.style.display = (targetElement || targetElementInfo) ? '' : 'none';
      setStatus(style, '✓ 完成');
    } finally {
      delete activeRequests[style];
    }
  } catch (e) {
    document.getElementById('panelLoading-' + style).classList.add('done');
    showErr(style, e.name === 'AbortError' ? '请求超时，请检查网络后重试' : (e.message || '网络错误'));
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
