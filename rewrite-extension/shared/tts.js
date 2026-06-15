// Text-to-Speech utility using Web Speech API.
// Handles sentence chunking, language detection, and state management.

var TTS = (function() {
  var _speaking = false;
  var _queue = [];
  var _currentCallbacks = null;
  var _currentLang = 'en-US';
  var _currentRate = 0.85;
  var _cachedVoices = null;  // populated lazily/asynchronously below

  // Pre-warm the voice list. Chrome loads speechSynthesis voices
  // asynchronously and only fires `voiceschanged` once they're ready. By
  // kicking this off at module load, voices are usually available by the
  // time the user first clicks speak, so the very first utterance gets the
  // correct voice instead of the browser default.
  if (typeof window !== 'undefined' && window.speechSynthesis) {
    var warmVoices = window.speechSynthesis.getVoices();
    if (warmVoices && warmVoices.length) {
      _cachedVoices = warmVoices;
    }
    window.speechSynthesis.addEventListener('voiceschanged', function() {
      _cachedVoices = window.speechSynthesis.getVoices();
    });
  }

  // ─── Public API ───

  /**
   * Speak text with automatic sentence chunking.
   * @param {string} text - Text to speak
   * @param {string} lang - 'en-US' | 'zh-CN' | 'auto' (auto-detect)
   * @param {Object} callbacks - { onStart(), onEnd(), onError(message) }
   * @param {number} [rate] - Speech rate 0.5-2.0 (default 0.85)
   */
  function speak(text, lang, callbacks, rate) {
    if (!text || !text.trim()) return;

    // Stop any current speech
    stop();

    var resolvedLang = (lang === 'auto' || !lang) ? detectLang(text) : lang;
    _currentLang = resolvedLang;
    _currentCallbacks = callbacks || {};
    _currentRate = (rate != null) ? Math.max(0.5, Math.min(2.0, parseFloat(rate))) : 0.85;

    // Split into sentences for chunking (Web Speech API has implicit char limits)
    var sentences = splitSentences(text.trim());

    if (sentences.length === 0) return;

    _queue = sentences;
    _speaking = true;

    if (_currentCallbacks.onStart) _currentCallbacks.onStart();

    speakNext();
  }

  /** Stop all speech immediately */
  function stop() {
    if (_speaking) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) { /* ignore */ }
      _speaking = false;
      _queue = [];
      if (_currentCallbacks && _currentCallbacks.onEnd) {
        _currentCallbacks.onEnd();
      }
      _currentCallbacks = null;
    }
  }

  /** @returns {boolean} */
  function isSpeaking() {
    return _speaking;
  }

  /**
   * Auto-detect language based on CJK character ratio.
   * @returns {'zh-CN' | 'en-US'}
   */
  function detectLang(text) {
    // Match only CJK ideographs (\u4e00-\u9fff). Do NOT count CJK punctuation
    // (\u3000-\u303f) or fullwidth ASCII (\uff00-\uffef) — those would let
    // pure-English text with fullwidth punctuation be misclassified as Chinese.
    var cjkCount = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    var total = text.replace(/\s/g, '').length;
    if (total === 0) return 'en-US';
    return (cjkCount / total) >= 0.3 ? 'zh-CN' : 'en-US';
  }

  // ─── Internal ───

  function splitSentences(text) {
    // Split on sentence-ending punctuation, keeping the delimiter
    var raw = text.split(/(?<=[.!?。！？\n])\s*/);
    var result = [];

    for (var i = 0; i < raw.length; i++) {
      var s = raw[i].trim();
      if (!s) continue;

      // If a single chunk is still too long, split on commas/semicolons too
      if (s.length > 250) {
        var subChunks = s.split(/(?<=[,;，；：:\n])\s*/);
        for (var j = 0; j < subChunks.length; j++) {
          var sub = subChunks[j].trim();
          if (sub && sub.length > 400) {
            // Very long run without punctuation — split by word boundary every ~200 chars
            result.push.apply(result, splitLongRun(sub));
          } else if (sub) {
            result.push(sub);
          }
        }
      } else {
        result.push(s);
      }
    }

    return result;
  }

  function splitLongRun(text) {
    var chunks = [];
    var words = text.split(/\s+/);
    var current = '';

    for (var i = 0; i < words.length; i++) {
      if (current && (current + ' ' + words[i]).length > 200) {
        chunks.push(current.trim());
        current = words[i];
      } else {
        current = current ? current + ' ' + words[i] : words[i];
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.length ? chunks : [text];
  }

  function speakNext() {
    if (_queue.length === 0) {
      // Done
      _speaking = false;
      if (_currentCallbacks && _currentCallbacks.onEnd) {
        _currentCallbacks.onEnd();
      }
      _currentCallbacks = null;
      return;
    }

    var text = _queue.shift();

    // Check if speechSynthesis is available
    if (!window.speechSynthesis) {
      if (_currentCallbacks && _currentCallbacks.onError) {
        _currentCallbacks.onError('Speech synthesis not supported in this browser.');
      }
      _speaking = false;
      return;
    }

    var utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = _currentLang;
    utterance.rate = _currentRate;
    utterance.pitch = 1.0;

    // Use a default voice for the language if available
    trySetVoice(utterance, _currentLang);

    utterance.onend = function() {
      // Chrome sometimes fires onend prematurely after cancel()
      if (_speaking) speakNext();
    };

    utterance.onerror = function(e) {
      if (e.error === 'canceled' || e.error === 'interrupted') {
        // User cancelled — clean exit, don't report error
        _speaking = false;
        _queue = [];
        if (_currentCallbacks && _currentCallbacks.onEnd) {
          _currentCallbacks.onEnd();
        }
        _currentCallbacks = null;
        return;
      }
      // Real error — report and stop
      if (_currentCallbacks && _currentCallbacks.onError) {
        _currentCallbacks.onError('Speech error: ' + (e.error || 'unknown'));
      }
      _speaking = false;
      _queue = [];
      _currentCallbacks = null;
    };

    try {
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      if (_currentCallbacks && _currentCallbacks.onError) {
        _currentCallbacks.onError('Speech failed: ' + (e.message || 'unknown'));
      }
      _speaking = false;
    }
  }

  function trySetVoice(utterance, lang) {
    // Prefer the cached voice list (kept warm by the voiceschanged handler).
    var voices = _cachedVoices;
    if (!voices || voices.length === 0) {
      voices = window.speechSynthesis.getVoices();
      if (voices && voices.length) _cachedVoices = voices;
    }
    if (!voices || voices.length === 0) {
      // Voices not loaded yet — retry once when they become available.
      // For the in-flight utterance this may be too late, but subsequent
      // chunks (and any future speaks) will use the now-warmed cache.
      window.speechSynthesis.addEventListener('voiceschanged', function retry() {
        window.speechSynthesis.removeEventListener('voiceschanged', retry);
        _cachedVoices = window.speechSynthesis.getVoices();
        setBestVoice(utterance, _cachedVoices, lang);
      }, { once: true });
      return;
    }
    setBestVoice(utterance, voices, lang);
  }

  function setBestVoice(utterance, voices, lang) {
    // 1. Try exact lang match
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang === lang) {
        utterance.voice = voices[i];
        return;
      }
    }
    // 2. Try prefix match (e.g. 'zh' for 'zh-CN', 'en' for 'en-US')
    var prefix = lang.split('-')[0];
    for (var j = 0; j < voices.length; j++) {
      if (voices[j].lang.indexOf(prefix) === 0) {
        utterance.voice = voices[j];
        return;
      }
    }
    // 3. Use browser default
  }

  // ─── Exports ───

  return {
    speak: speak,
    stop: stop,
    isSpeaking: isSpeaking,
    detectLang: detectLang
  };
})();
