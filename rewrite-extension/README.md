# AI 双语改写器 / AI Bilingual Rewriter

使用 **DeepSeek AI** 驱动的 Chrome 浏览器扩展，智能改写/翻译中英文文本。像一位随身写作教练——不仅改写，还告诉你为什么这样改。

## ✨ 核心功能

- **双语改写**：中文 ↔ 英文互译改，三种风格一键切换
  - 📝 **贴近原文** — 保持原意，仅润色优化
  - 💬 **口语化** — 轻松自然的对话风格
  - 🏛️ **正式** — 专业商务书面表达
- **AI 教学反馈**：每次改写附带中文"教学注记"，像老师在批改作文
- **流式实时输出**：文字逐字出现，无需等待完整响应
- **🔊 语音朗读**：Web Speech API 驱动，支持原文和改写结果朗读，语速可调
- **原地替换**：改写结果直接替换网页上选中的原文本（支持 input / textarea / contentEditable）
- **两种触发方式**：
  - 选中文字 → **双击 Shift**（英文输出）/ **双击 Ctrl**（中文输出）
  - 右键菜单 → 侧边栏改写

## 🛡️ 可靠性

- **自动重试**：API 错误时指数退避重试（最多 3 次）
- **智能解析**：7 层降级解析器，兼容模型 JSON 格式偏差
- **结构化日志**：所有 API 错误记录到本地存储，便于排查

## 🚀 安装

### Chrome Web Store（推荐）
> 即将上架

### 开发者模式加载
1. 下载或克隆本仓库
2. 打开 Chrome → `chrome://extensions`
3. 开启「开发者模式」
4. 点击「加载已解压的扩展程序」→ 选择 `rewrite-extension/` 目录

## ⚙️ 配置

1. 在 [DeepSeek Platform](https://platform.deepseek.com/api_keys) 获取 API Key
2. 点击扩展图标 → ⚙️ 设置 → 填入 API Key
3. 可选：选择模型（V4 Flash 快速 / V4 Pro 高质量）、调节温度、朗读语速

## 🏗️ 技术架构

- **前端**：纯原生 JavaScript（无框架），Apple HIG 设计风格 CSS（支持明暗色模式）
- **平台**：Chrome Extension Manifest V3
- **API**：DeepSeek Chat Completions（`deepseek-v4-flash` / `deepseek-v4-pro`）
- **语音**：Web Speech API（浏览器内置，离线可用）

### 项目结构

```
rewrite-extension/
├── manifest.json              # 扩展清单
├── shared/                    # 共享模块
│   ├── constants.js           # 存储键名、风格枚举、API 配置
│   ├── logger.js              # 结构化日志工具
│   ├── api.js                 # 历史记录管理、API 错误解析
│   ├── prompts.js             # 6 套 System Prompt + 响应解析
│   ├── rewrite-service.js     # 统一改写服务（重试 + 流式）
│   └── tts.js                 # 语音朗读工具
├── content/                   # 内容脚本（浮动卡片）
│   ├── content.js             # 选中捕获、双击检测、API 调用、原地替换
│   └── content.css            # 浮动卡片样式
├── sidepanel/                 # 侧边栏面板
│   ├── panel.html             # UI 结构
│   ├── panel.js               # 改写逻辑、历史管理
│   └── panel.css              # 面板样式
├── background/                # Service Worker
│   └── service-worker.js      # 右键菜单、消息路由、设置页打开
├── settings/                  # 设置页
│   ├── settings.html          # UI 结构
│   ├── settings.js            # 配置读写
│   └── settings.css           # 设置页样式
├── _locales/                  # 国际化
│   ├── zh_CN/messages.json    # 中文
│   └── en/messages.json       # 英文
└── icons/                     # 扩展图标
```

## 📄 隐私

- API Key 和改写历史仅存储在浏览器本地（`chrome.storage.local`）
- 改写文本直接发送至 DeepSeek API，扩展开发者不会收集或存储
- 不包含任何分析/追踪代码

## 📝 License

MIT
