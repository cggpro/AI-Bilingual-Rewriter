// Unified rewrite service with retry, streaming, and error logging.
// Depends on: constants.js, prompts.js, api.js, logger.js

var REWRITE_API_URL = 'https://api.deepseek.com/v1/chat/completions';
var REWRITE_MAX_RETRIES = 3;           // additional retries after first attempt
var REWRITE_RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff
var REWRITE_MAX_TOKENS = 4096;
var REWRITE_TIMEOUT_MS = 30000;

/**
 * Core rewrite function. All components use this single entry point.
 *
 * @param {Object} options
 * @param {string}  options.text        - Text to rewrite
 * @param {string}  options.style       - 'close' | 'casual' | 'formal'
 * @param {string}  options.targetLang  - 'en' | 'zh'
 * @param {string}  options.apiKey      - DeepSeek API key
 * @param {string}  [options.model]     - Model name (default from API_CONFIG)
 * @param {number}  [options.temperature] - Temperature 0-2 (default from API_CONFIG)
 * @param {boolean} [options.stream]    - Use SSE streaming (default true)
 * @param {AbortSignal} [options.signal] - External abort signal (user cancellation)
 * @param {number}  [options.timeoutMs] - Per-attempt timeout (default 30000)
 * @param {Function} [options.onToken]  - Called with (deltaText, accumulatedText) during streaming
 * @returns {Promise<{text: string, note: string}>}
 */
function rewriteText(options) {
  var text = options.text;
  var style = options.style || 'close';
  var targetLang = options.targetLang || 'en';
  var apiKey = options.apiKey;
  var model = options.model || (typeof API_CONFIG !== 'undefined' ? API_CONFIG.MODEL : 'deepseek-v4-flash');
  var temperature = options.temperature != null ? options.temperature :
    (typeof API_CONFIG !== 'undefined' ? API_CONFIG.TEMPERATURE : 0.7);
  var useStream = options.stream !== false; // default true
  var externalSignal = options.signal;
  var onToken = options.onToken || function() {};
  var timeoutMs = options.timeoutMs || REWRITE_TIMEOUT_MS;

  var messages = buildMessagesFor(style, text, targetLang);

  return attemptRequest(0);

  // ─── Per-attempt dispatcher ───

  function attemptRequest(attempt) {
    // Check external abort before each attempt
    if (externalSignal && externalSignal.aborted) {
      return Promise.reject(createAbortError());
    }

    // Per-attempt abort controller for timeout
    var ctrl = new AbortController();
    var tid = setTimeout(function() { ctrl.abort(); }, timeoutMs);

    // Link external signal so user cancellation aborts this attempt too
    var onExternalAbort = null;
    if (externalSignal) {
      onExternalAbort = function() { ctrl.abort(); };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }

    // Only the very first attempt uses streaming; retries use non-streaming for reliability
    var shouldStream = (attempt === 0) && useStream;

    var requestPromise = shouldStream
      ? streamRequest(apiKey, model, messages, temperature, ctrl.signal, onToken)
      : normalRequest(apiKey, model, messages, temperature, ctrl.signal);

    return requestPromise.then(function(result) {
      clearTimeout(tid);
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      return result;
    }, function(err) {
      clearTimeout(tid);
      if (onExternalAbort && externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      return handleError(err, attempt);
    });
  }

  // ─── Retry decision ───

  function handleError(err, attempt) {
    // Never retry user-initiated abort
    if (err.name === 'AbortError') {
      Logger.info('api', 'Request aborted', { style: style, targetLang: targetLang });
      throw err;
    }

    var retryable = isRetryableError(err);

    if (attempt < REWRITE_MAX_RETRIES && retryable) {
      var delay = REWRITE_RETRY_DELAYS[attempt];
      Logger.warn('api.retry',
        'Retry ' + (attempt + 1) + '/' + REWRITE_MAX_RETRIES + ' in ' + delay + 'ms',
        { style: style, targetLang: targetLang, error: err.message, status: err.status }
      );

      return sleep(delay).then(function() {
        return attemptRequest(attempt + 1);
      });
    }

    // Final failure — log and throw
    Logger.error('api',
      'Rewrite failed after ' + (attempt + 1) + ' attempt(s)',
      { style: style, targetLang: targetLang, error: err.message, status: err.status, retryable: retryable }
    );
    throw err;
  }
}

// ─── Error classification ───

function isRetryableError(err) {
  // Network errors (TypeError from fetch, or message patterns)
  if (err.name === 'TypeError') return true;
  if (err.message && err.message.indexOf('Failed to fetch') !== -1) return true;
  if (err.message && err.message.indexOf('NetworkError') !== -1) return true;
  // Stream parse errors
  if (err.message && err.message.indexOf('Stream') !== -1) return true;
  // HTTP status-based
  if (err.status) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false; // 4xx (non-429) not retryable
  }
  return false; // unknown — be conservative, don't retry
}

function createAbortError() {
  var err = new Error('Request aborted');
  err.name = 'AbortError';
  return err;
}

// ─── Non-streaming request ───

function normalRequest(apiKey, model, messages, temperature, signal) {
  return fetch(REWRITE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: model,
      messages: messages,
      stream: false,
      max_tokens: REWRITE_MAX_TOKENS,
      temperature: temperature
    }),
    signal: signal
  }).then(function(resp) {
    if (!resp.ok) {
      return resp.text().then(function(eb) {
        var ei = parseApiError(resp.status, eb);
        var err = new Error(ei.message);
        err.status = resp.status;
        err.code = ei.code;
        throw err;
      }, function() {
        var err = new Error('HTTP ' + resp.status);
        err.status = resp.status;
        throw err;
      });
    }
    return resp.json();
  }).then(function(data) {
    var raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!raw) {
      var emptyErr = new Error(typeof ERROR_MESSAGES !== 'undefined' ? ERROR_MESSAGES.EMPTY_RESPONSE : 'Empty response from API');
      throw emptyErr;
    }
    return parseRewriteResponse(raw);
  });
}

// ─── Streaming (SSE) request ───

function streamRequest(apiKey, model, messages, temperature, signal, onToken) {
  var accumulated = '';

  return fetch(REWRITE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
    body: JSON.stringify({
      model: model,
      messages: messages,
      stream: true,
      max_tokens: REWRITE_MAX_TOKENS,
      temperature: temperature
    }),
    signal: signal
  }).then(function(resp) {
    if (!resp.ok) {
      return resp.text().then(function(eb) {
        var ei = parseApiError(resp.status, eb);
        var err = new Error(ei.message);
        err.status = resp.status;
        err.code = ei.code;
        throw err;
      }, function() {
        var err = new Error('HTTP ' + resp.status);
        err.status = resp.status;
        throw err;
      });
    }

    // Browser lacks ReadableStream — degrade to non-streaming
    if (!resp.body || !resp.body.getReader) {
      Logger.info('api', 'ReadableStream not available, falling back to non-streaming');
      return normalRequest(apiKey, model, messages, temperature, signal);
    }

    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    // Cancel reader if aborted
    var onAbort = function() {
      try { reader.cancel(); } catch (e) { /* ignore */ }
    };
    signal.addEventListener('abort', onAbort, { once: true });

    function readNext() {
      return reader.read().then(function(result) {
        if (result.done) {
          signal.removeEventListener('abort', onAbort);
          return parseRewriteResponse(accumulated);
        }

        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\n');
        // Keep last potentially-incomplete line in buffer
        buffer = lines.pop() || '';

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.indexOf('data: ') !== 0) continue;
          var data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            var parsed = JSON.parse(data);
            var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
            if (delta && delta.content) {
              accumulated += delta.content;
              onToken(delta.content, accumulated);
            }
          } catch (e) {
            // Skip malformed SSE chunks
            if (data.length > 4 && data !== '[DONE]') {
              Logger.warn('api.stream', 'Skipped malformed SSE chunk', { data: data.slice(0, 100) });
            }
          }
        }

        return readNext();
      }, function(err) {
        // Reader error — clean up and propagate
        try { reader.cancel(); } catch (e) { /* ignore */ }
        signal.removeEventListener('abort', onAbort);
        throw err;
      });
    }

    return readNext();
  });
}

// ─── Utilities ───

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}
