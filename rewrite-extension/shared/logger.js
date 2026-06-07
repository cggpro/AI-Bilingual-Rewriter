// Structured logging utility for AI Rewriter
// Persists to chrome.storage.local, max 50 entries FIFO

var LOG_STORAGE_KEY = 'error_logs';
var LOG_MAX_ENTRIES = 50;

var Logger = {
  _writeQueue: null,

  _enqueue: function(entry) {
    var self = this;
    // Chain writes to avoid races
    var prev = self._writeQueue || Promise.resolve();
    self._writeQueue = prev.then(function() {
      return chrome.storage.local.get(LOG_STORAGE_KEY);
    }).then(function(r) {
      var logs = r[LOG_STORAGE_KEY] || [];
      logs.unshift(entry);
      if (logs.length > LOG_MAX_ENTRIES) logs = logs.slice(0, LOG_MAX_ENTRIES);
      return chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs });
    }).catch(function(e) {
      // If storage write fails, at least we have the console output
      console.error('[Logger] Failed to persist:', e);
    });
    return self._writeQueue;
  },

  _log: function(level, context, message, data) {
    var entry = {
      timestamp: Date.now(),
      level: level,
      context: context,
      message: message
    };
    if (data !== undefined) entry.data = data;

    // Console output — always
    var prefix = '[' + level.toUpperCase() + '][' + context + ']';
    switch (level) {
      case 'error':
        console.error(prefix, message, data || '');
        break;
      case 'warn':
        console.warn(prefix, message, data || '');
        break;
      default:
        console.log(prefix, message, data || '');
    }

    // Persist
    this._enqueue(entry);
  },

  error: function(context, message, data) {
    this._log('error', context, message, data);
  },

  warn: function(context, message, data) {
    this._log('warn', context, message, data);
  },

  info: function(context, message, data) {
    this._log('info', context, message, data);
  },

  getLogs: function() {
    return chrome.storage.local.get(LOG_STORAGE_KEY).then(function(r) {
      return r[LOG_STORAGE_KEY] || [];
    });
  },

  clear: function() {
    return chrome.storage.local.set({ [LOG_STORAGE_KEY]: [] });
  }
};
