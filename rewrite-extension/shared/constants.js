const STORAGE_KEYS = {
  API_KEY: 'deepseek_api_key',
  LANGUAGE: 'ui_language',
  HISTORY: 'rewrite_history',
  MODEL: 'model',
  TEMPERATURE: 'temperature',
  TTS_RATE: 'tts_rate'
};

const REWRITE_STYLES = {
  close:  { id: 'close',  icon: '📝', label_cn: '贴近原文', label_en: 'Close to Original' },
  casual: { id: 'casual', icon: '💬', label_cn: '口语化',   label_en: 'Casual' },
  formal: { id: 'formal', icon: '🏛️', label_cn: '正式',     label_en: 'Formal' }
};

const API_CONFIG = {
  BASE_URL: 'https://api.deepseek.com/v1/chat/completions',
  MODEL: 'deepseek-v4-flash',
  MAX_TOKENS: 4096,
  TEMPERATURE: 0.7,
  TIMEOUT_MS: 30000
};

const HISTORY_MAX_ENTRIES = 100;

const ERROR_MESSAGES = {
  NO_API_KEY: '请先在设置中配置 DeepSeek API Key。',
  INVALID_API_KEY: 'API Key 无效，请在设置中检查。',
  RATE_LIMITED: 'API 请求太频繁，请稍后再试。',
  NETWORK_ERROR: '网络错误，请检查网络连接。',
  EMPTY_RESPONSE: 'API 返回了空结果，请重试。',
  NO_SELECTION: '未选中文字，请先在网页上选择要改写的文字。',
  CONTEXT_LOST: '页面上下文已丢失，请重新选择文字。'
};
