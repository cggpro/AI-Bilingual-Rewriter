function $(id) { return document.getElementById(id); }

var apiKeyInput = $('apiKey');
var saveApiKeyBtn = $('saveApiKeyBtn');
var testApiBtn = $('testApiBtn');
var toggleKeyVisibility = $('toggleKeyVisibility');
var apiStatus = $('apiStatus');
var modelSelect = $('modelSelect');
var temperatureRange = $('temperatureRange');
var tempValue = $('tempValue');
var clearHistoryBtn = $('clearHistoryBtn');
var historyCount = $('historyCount');
var ttsRateRange = $('ttsRateRange');
var ttsRateValue = $('ttsRateValue');

// Read from chrome.storage.local directly — no service worker needed
document.addEventListener('DOMContentLoaded', async function() {
  await loadSettings();
  loadVersion();
  setupEventListeners();
});

async function loadVersion() {
  try {
    var manifest = chrome.runtime.getManifest();
    $('versionText').textContent = manifest.name + ' v' + manifest.version;
  } catch (e) {
    $('versionText').textContent = 'AI Rewriter';
  }
}

async function loadSettings() {
  try {
    var result = await chrome.storage.local.get([
      STORAGE_KEYS.API_KEY, STORAGE_KEYS.MODEL, STORAGE_KEYS.TEMPERATURE, STORAGE_KEYS.HISTORY, STORAGE_KEYS.TTS_RATE
    ]);

    if (result[STORAGE_KEYS.API_KEY]) apiKeyInput.value = result[STORAGE_KEYS.API_KEY];
    if (result[STORAGE_KEYS.MODEL]) modelSelect.value = result[STORAGE_KEYS.MODEL];
    if (result[STORAGE_KEYS.TEMPERATURE] != null) {
      temperatureRange.value = result[STORAGE_KEYS.TEMPERATURE];
      tempValue.textContent = result[STORAGE_KEYS.TEMPERATURE];
    }
    if (result[STORAGE_KEYS.TTS_RATE] != null) {
      ttsRateRange.value = result[STORAGE_KEYS.TTS_RATE];
      ttsRateValue.textContent = result[STORAGE_KEYS.TTS_RATE];
    }
    var entries = result[STORAGE_KEYS.HISTORY] || [];
    historyCount.textContent = entries.length + ' 条记录';
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
}

function setupEventListeners() {
  saveApiKeyBtn.addEventListener('click', async function() {
    var key = apiKeyInput.value.trim();
    if (!key) { showStatus('请输入 API Key。', 'error'); return; }
    if (!key.startsWith('sk-')) { showStatus('API Key 格式不正确，应以 "sk-" 开头。', 'error'); return; }

    try {
      var s = {}; s[STORAGE_KEYS.API_KEY] = key;
      await chrome.storage.local.set(s);
      showStatus('API Key 保存成功！', 'success');
    } catch (e) {
      showStatus('保存失败: ' + (e.message || '未知错误'), 'error');
    }
  });

  testApiBtn.addEventListener('click', async function() {
    var key = apiKeyInput.value.trim();
    if (!key) { showStatus('请先输入 API Key。', 'error'); return; }

    testApiBtn.disabled = true;
    testApiBtn.textContent = '测试中...';
    showStatus('正在测试连接...', 'info', false);

    try {
      var controller = new AbortController();
      var timeout = setTimeout(function() { controller.abort(); }, 15000);

      var response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: 'Reply with exactly: "OK"' },
            { role: 'user', content: 'Test' }
          ],
          stream: false,
          max_tokens: 10
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      testApiBtn.disabled = false;
      testApiBtn.textContent = '测试连接';

      if (response.ok) {
        showStatus('连接成功！API Key 有效。', 'success');
      } else if (response.status === 401) {
        showStatus('API Key 无效，请检查是否正确。', 'error');
      } else if (response.status === 402) {
        showStatus('API 余额不足，请前往平台充值。', 'error');
      } else {
        var eb = ''; try { eb = await response.text(); } catch (e) { /* */ }
        showStatus('服务器错误 (HTTP ' + response.status + '): ' + eb.slice(0, 100), 'error');
      }
    } catch (e) {
      testApiBtn.disabled = false;
      testApiBtn.textContent = '测试连接';
      if (e.name === 'AbortError') {
        showStatus('连接超时，请检查网络。', 'error');
      } else {
        showStatus('网络错误: ' + (e.message || '未知错误'), 'error');
      }
    }
  });

  toggleKeyVisibility.addEventListener('click', function() {
    var isPassword = apiKeyInput.type === 'password';
    apiKeyInput.type = isPassword ? 'text' : 'password';
    toggleKeyVisibility.innerHTML = isPassword ? '🙈' : '👁️';
  });

  temperatureRange.addEventListener('input', function() {
    tempValue.textContent = temperatureRange.value;
  });
  temperatureRange.addEventListener('change', async function() {
    var s = {}; s[STORAGE_KEYS.TEMPERATURE] = parseFloat(temperatureRange.value);
    await chrome.storage.local.set(s);
    showStatus('温度已更新。', 'success');
  });

  ttsRateRange.addEventListener('input', function() {
    ttsRateValue.textContent = ttsRateRange.value;
  });
  ttsRateRange.addEventListener('change', async function() {
    var s = {}; s[STORAGE_KEYS.TTS_RATE] = parseFloat(ttsRateRange.value);
    await chrome.storage.local.set(s);
    showStatus('朗读语速已更新。', 'success');
  });

  modelSelect.addEventListener('change', async function() {
    var s = {}; s[STORAGE_KEYS.MODEL] = modelSelect.value;
    await chrome.storage.local.set(s);
    showStatus('模型已更新。', 'success');
  });

  clearHistoryBtn.addEventListener('click', async function() {
    if (!confirm('确定要清除全部改写历史记录吗？')) return;
    var s = {}; s[STORAGE_KEYS.HISTORY] = [];
    await chrome.storage.local.set(s);
    historyCount.textContent = '0 条记录';
    showStatus('历史记录已清除。', 'success');
  });
}

function showStatus(message, type, autoHide) {
  apiStatus.textContent = message;
  apiStatus.className = 'status-message ' + type;
  apiStatus.classList.remove('hidden');
  if (autoHide !== false) {
    setTimeout(function() { apiStatus.classList.add('hidden'); }, 3000);
  }
}
