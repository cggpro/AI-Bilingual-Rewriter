var _historyLock = null;

async function saveToHistory(original, rewritten, style, note) {
  // Serialize writes to avoid race conditions from concurrent API calls
  while (_historyLock) { await _historyLock; }
  var resolveLock;
  _historyLock = new Promise(function(r) { resolveLock = r; });

  try {
    var r = await chrome.storage.local.get(STORAGE_KEYS.HISTORY);
    var entries = r[STORAGE_KEYS.HISTORY] || [];
    var entry = {
      id: Date.now().toString() + '_' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      original: original.slice(0, 200) + (original.length > 200 ? '...' : ''),
      originalFull: original,
      rewritten: rewritten,
      style: style,
      note: note || ''
    };
    entries.unshift(entry);
    if (entries.length > HISTORY_MAX_ENTRIES) entries = entries.slice(0, HISTORY_MAX_ENTRIES);
    await chrome.storage.local.set({ [STORAGE_KEYS.HISTORY]: entries });
    console.log('[History] Saved:', entry.id, 'style:', style, 'total:', entries.length);
  } catch (e) {
    console.error('[History] Failed to save:', e);
  } finally {
    _historyLock = null;
    resolveLock();
  }
}

function parseApiError(status, body) {
  var message = 'HTTP ' + status;
  var code = 'UNKNOWN';
  var retryable = false;

  try {
    var parsed = JSON.parse(body);
    if (parsed.error && parsed.error.message) {
      message = parsed.error.message;
    }
  } catch (e) { /* use default */ }

  switch (status) {
    case 401:
      message = 'API Key 无效，请在扩展设置中检查你的 DeepSeek API Key。';
      code = 'INVALID_API_KEY';
      break;
    case 402:
      message = 'API 余额不足，请前往 DeepSeek 平台充值。';
      code = 'INSUFFICIENT_CREDITS';
      break;
    case 429:
      message = 'API 请求太频繁，请稍后再试。';
      code = 'RATE_LIMITED';
      retryable = true;
      break;
    case 500:
    case 502:
    case 503:
      message = 'DeepSeek 服务器错误，请稍后再试。';
      code = 'SERVER_ERROR';
      retryable = true;
      break;
  }

  return { message: message, code: code, retryable: retryable };
}
