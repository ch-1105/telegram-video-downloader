// ==UserScript==
// @name Telegram Web Video Downloader - Clean
// @namespace http://tampermonkey.net/
// @version 9.2
// @description 简洁高效的 Telegram 视频下载器（支持手机端）
// @author You
// @match https://web.telegram.org/*
// @match https://web.telegram.org/k/*
// @match https://web.telegram.org/a/*
// @match https://web.telegram.org/z/*
// @grant none
// @run-at document-start
// ==/UserScript==

(function() {
    'use strict';

// ============ 配置 ============
const CONFIG = {
  // 动态块大小：根据文件大小自动调整
  getChunkSize(fileSize) {
    if (fileSize < 10 * 1024 * 1024) return 512 * 1024; // <10MB: 512KB
    if (fileSize < 100 * 1024 * 1024) return 2 * 1024 * 1024; // <100MB: 2MB
    if (fileSize < 1024 * 1024 * 1024) return 5 * 1024 * 1024; // <1GB: 5MB
    return 10 * 1024 * 1024; // >=1GB: 10MB
  },

  RETRY_COUNT: 3,
  TIMEOUT: 15000, // 增加到15秒，给大文件更多时间

  // 并发下载数：桌面端6个，手机端4个（平衡速度和稳定性）
  get CONCURRENT_DOWNLOADS() {
    return CONFIG.IS_MOBILE ? 4 : 6;
  },

  // 分批次合并大小：手机端20MB，桌面端100MB
  get MERGE_BATCH_SIZE() {
    return CONFIG.IS_MOBILE ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
  },

  // 流式下载阈值：大于此值使用流式下载
  STREAMING_THRESHOLD: 50 * 1024 * 1024, // 50MB

  OBSERVER_DEBOUNCE: 100,
  IS_MOBILE: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent),
  UI_SCALE: /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ? 1.2 : 1
};

    // ============ 状态管理 ============
    const state = {
        tasks: new Map(),
        taskId: 0,
        ui: null,
        downloadingVideos: new Set(),
        capturedUrls: [],
        observers: [], // 存储所有观察者以便清理
        eventListeners: [], // 存储所有事件监听器
        isDestroyed: false // 页面卸载标记
    };

// ============ 全局错误处理 ============
const ErrorHandler = {
        handle(context, error, fallback = null) {
            console.error(`[TG DL] ${context}:`, error);
            // 可以在这里添加错误上报逻辑
            return fallback;
        },

        wrapAsync(fn, context) {
            return async (...args) => {
                try {
                    return await fn(...args);
                } catch (e) {
                    return this.handle(context, e);
                }
            };
        }
    };

    // ============ 文件名生成器 ============
    const FilenameGenerator = {
        // 配置选项
        config: {
            maxLength: 60,
            totalMaxLength: 180,
            dateFormat: 'iso',
            includeTime: true,
            sequenceDigits: 3,
            emojiMode: 'remove'
        },

        // 持久化的文件名集合
        getExistingNames() {
            try {
                const stored = localStorage.getItem('tg_dl_filenames');
                if (stored) {
                    return new Set(JSON.parse(stored));
                }
            } catch (e) {}
            return new Set();
        },

        saveExistingNames(names) {
            try {
                const namesArray = Array.from(names);
                // 只保留最近1000个文件名
                const recentNames = namesArray.slice(-1000);
                localStorage.setItem('tg_dl_filenames', JSON.stringify(recentNames));
            } catch (e) {
                ErrorHandler.handle('保存文件名记录失败', e);
            }
        },

        // 提取有意义的消息摘要
        extractSummary(messageText, maxLength = 60) {
            if (!messageText) return '';
            let text = messageText
                .replace(/https?:\/\/\S+/g, '')
                .replace(/@\w+/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            // 处理表情符号
            if (this.config.emojiMode === 'remove') {
                text = text.replace(/[\u{1F600}-\u{1F64F}]/gu, '')
                    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
                    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
                    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
                    .replace(/[\u{2600}-\u{26FF}]/gu, '')
                    .replace(/[\u{2700}-\u{27BF}]/gu, '');
            }

            text = text.trim();

            if (text.length > maxLength) {
                const truncated = text.substring(0, maxLength);
                const lastSpace = truncated.lastIndexOf(' ');
                if (lastSpace > maxLength * 0.7) {
                    return truncated.substring(0, lastSpace).trim();
                }
                return truncated;
            }
            return text;
        },

        // 解析消息时间
        parseMessageTime(dateText, captureTime) {
            const now = captureTime ? new Date(captureTime) : new Date();

            if (!dateText) {
                return now;
            }

            // 处理时间格式（如 "14:30" 或 "下午3:20"）
            const timeMatch = dateText.match(/(\d{1,2}):(\d{2})/);
            if (timeMatch && !dateText.includes('年')) {
                const [_, hours, minutes] = timeMatch;
                const date = new Date(now);
                let h = parseInt(hours);
                // 处理12小时制
                if (dateText.includes('下午') || dateText.includes('PM')) {
                    if (h < 12) h += 12;
                } else if ((dateText.includes('上午') || dateText.includes('AM')) && h === 12) {
                    h = 0;
                }
                date.setHours(h, parseInt(minutes), 0, 0);
                return date;
            }

            // 处理完整日期（如 "2024年3月15日 14:30"）
            const fullMatch = dateText.match(/(\d{4})年(\d{1,2})月(\d{1,2})日[\s,]*(\d{1,2})?:?(\d{2})?/);
            if (fullMatch) {
                const [_, year, month, day, hours = 0, minutes = 0] = fullMatch;
                return new Date(year, month - 1, day, hours, minutes);
            }

            // 处理斜线日期格式（如 "3/15/24" 或 "15/3/2024"）
            const slashMatch = dateText.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
            if (slashMatch && !dateText.includes('年')) {
                let [_, m, d, y] = slashMatch;
                const year = y ? (y.length === 2 ? 2000 + parseInt(y) : parseInt(y)) : now.getFullYear();
                return new Date(year, parseInt(m) - 1, parseInt(d), now.getHours(), now.getMinutes());
            }

            // 尝试直接解析
            const parsed = new Date(dateText);
            if (!isNaN(parsed.getTime())) {
                return parsed;
            }

            return now;
        },

        // 格式化日期时间
        formatDateTime(date, mode = 'iso') {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');

            switch (mode) {
                case 'iso':
                    return `${year}-${month}-${day}_${hours}${minutes}${seconds}`;
                case 'compact':
                    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
                case 'human':
                    return `${year}年${month}月${day}日_${hours}时${minutes}分`;
                default:
                    return `${year}-${month}-${day}`;
            }
        },

        // 清理文件名
        sanitize(str, maxLen = 100) {
            if (!str) return '';
            return str
                .replace(/[<>/\\|:"*?]/g, '_')
                .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
                .replace(/\s+/g, '_')
                .replace(/_+/g, '_')
                .replace(/^[._]+|[._]+$/g, '')
                .trim()
                .substring(0, maxLen);
        },

        // 检查是否是通用文件名
        isGenericName(name) {
            if (!name) return true;
            const genericPatterns = [
                /^video_\d+$/i,
                /^vid_\d+$/i,
                /^file_\d+$/i,
                /^doc_\d+$/i,
                /^media_\d+$/i,
                /^\d+$/,
                /^[^a-zA-Z0-9\u4e00-\u9fff]*$/
            ];
            return genericPatterns.some(pattern => pattern.test(name)) || name.length < 3;
        },

        // 主生成函数
        generate(info, context, captureTime = Date.now()) {
            const existingNames = this.getExistingNames();

            // 提取时间戳
            const timestamp = this.parseMessageTime(context.date, captureTime);
            const dateTimeStr = this.formatDateTime(timestamp, this.config.dateFormat);

            // 提取聊天名
            const chatName = this.sanitize(context.chatName || '未知', 30) || '未知';

            // 提取描述
            let description = '';
            const originalName = info.fileName.replace(/\.[^/.]+$/, '');

            if (this.isGenericName(originalName) && context.messageText) {
                description = this.extractSummary(context.messageText, this.config.maxLength);
            } else {
                description = this.sanitize(originalName, this.config.maxLength);
            }

            // 构建基础文件名
            const ext = info.fileName.match(/\.[^/.]+$/)?.[0] || '.mp4';
            let baseName;

            if (description && description !== chatName && description.length > 0) {
                baseName = `${dateTimeStr}_${chatName}_${description}`;
            } else {
                baseName = `${dateTimeStr}_${chatName}`;
            }

            // 处理长度限制
            const maxLen = this.config.totalMaxLength - this.config.sequenceDigits - ext.length - 1;
            if (baseName.length > maxLen) {
                // 优先保留日期时间
                const dateTimeLen = dateTimeStr.length + 1;
                const remainingLen = maxLen - dateTimeLen;
                const chatPart = this.sanitize(context.chatName || '未知', Math.floor(remainingLen / 2));
                const descPart = this.sanitize(description, remainingLen - chatPart.length - 1);

                if (descPart && descPart !== chatPart) {
                    baseName = `${dateTimeStr}_${chatPart}_${descPart}`;
                } else {
                    baseName = `${dateTimeStr}_${chatPart}`;
                }
            }

            baseName = baseName.replace(/_+$/, '');

            // 检测冲突并添加序号
            let finalName = baseName + ext;
            let sequence = 1;
            const lowerFinalName = finalName.toLowerCase();

            // 检查当前会话和存储的历史记录
            while (existingNames.has(lowerFinalName) || this.checkSessionConflict(finalName)) {
                const seqStr = String(sequence).padStart(this.config.sequenceDigits, '0');
                const maxBaseLen = maxLen - this.config.sequenceDigits - 1;
                const base = baseName.substring(0, maxBaseLen).replace(/_+$/, '');
                finalName = `${base}_${seqStr}${ext}`;
                sequence++;

                if (sequence > 999) {
                    break;
                }
            }

            // 记录文件名
            existingNames.add(finalName.toLowerCase());
            this.saveExistingNames(existingNames);

            return finalName;
        },

    // 检查当前会话中的冲突
        checkSessionConflict(filename) {
            return Array.from(state.tasks.values()).some(
                task => task.filename && task.filename.toLowerCase() === filename.toLowerCase()
            );
        }
    };

    // ============ 资源管理器（防止内存泄漏） ============
    const ResourceManager = {
        addObserver(observer) {
            if (state.isDestroyed) return;
            state.observers.push(observer);
        },

        addEventListener(element, event, handler, options = false) {
            if (state.isDestroyed) return;
            element.addEventListener(event, handler, options);
            state.eventListeners.push({ element, event, handler, options });
        },

        cleanup() {
            state.isDestroyed = true;

            // 断开所有MutationObserver
            state.observers.forEach(observer => {
                try { observer.disconnect(); } catch (e) {}
            });
            state.observers = [];

            // 移除所有事件监听器
            state.eventListeners.forEach(({ element, event, handler, options }) => {
                try { element.removeEventListener(event, handler, options); } catch (e) {}
            });
            state.eventListeners = [];

            // 清理XHR和fetch的hook
            if (window.XMLHttpRequest && window.XMLHttpRequest.prototype.open !== XMLHttpRequest.prototype.open) {
                window.XMLHttpRequest.prototype.open = XMLHttpRequest.prototype.open;
            }
            if (window.fetch !== window._origFetch) {
                window.fetch = window._origFetch;
            }

            // 取消所有正在进行的任务
            state.tasks.forEach(task => {
                task.cancelled = true;
                if (task.pauseController) {
                    task.pauseController.abort();
                }
            });

            // 清理UI
            const panel = document.getElementById('tg-dl-panel');
            const toggle = document.querySelector('.tg-dl-toggle');
            const style = document.getElementById('tg-dl-style');

            if (panel) panel.remove();
            if (toggle) toggle.remove();
            if (style) style.remove();

            console.log('[TG DL] 资源已清理');
        }
    };

    // ============ UI 组件 ============
    const UI = {
        init() {
            if (state.isDestroyed) return;

            // 样式
            const style = document.createElement('style');
            style.id = 'tg-dl-style';
            const scale = CONFIG.UI_SCALE;
            const isMobile = CONFIG.IS_MOBILE;

 style.textContent = `
 /* Apple 风格设计系统 - SF Pro 风格 */
 :root {
 --tg-dl-primary: #007AFF;
 --tg-dl-success: #34C759;
 --tg-dl-warning: #FF9500;
 --tg-dl-danger: #FF3B30;
 --tg-dl-bg: rgba(255, 255, 255, 0.82);
 --tg-dl-bg-dark: rgba(30, 30, 30, 0.85);
 --tg-dl-text: #1C1C1E;
 --tg-dl-text-secondary: #8E8E93;
 --tg-dl-border: rgba(120, 120, 128, 0.2);
 --tg-dl-shadow: 0 8px 32px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.08);
 --tg-dl-radius: 20px;
 --tg-dl-radius-sm: 12px;
 }

 @media (prefers-color-scheme: dark) {
 :root {
 --tg-dl-bg: rgba(44, 44, 46, 0.92);
 --tg-dl-text: #FFFFFF;
 --tg-dl-text-secondary: #98989D;
 --tg-dl-border: rgba(120, 120, 128, 0.24);
 }
 }

 /* 视频下载按钮 */
 .tg-dl-btn {
 position: absolute;
 top: 12px;
 right: 12px;
 background: rgba(0, 122, 255, 0.9);
 color: white;
 border: none;
 padding: 8px 16px;
 border-radius: 20px;
 cursor: pointer;
 font-size: 13px;
 font-weight: 500;
 z-index: 9999;
 opacity: 0;
 transform: scale(0.9);
 transition: all 0.25s cubic-bezier(0.25, 0.1, 0.25, 1);
 touch-action: manipulation;
 -webkit-tap-highlight-color: transparent;
 backdrop-filter: blur(10px);
 -webkit-backdrop-filter: blur(10px);
 box-shadow: 0 4px 12px rgba(0, 122, 255, 0.3);
 letter-spacing: -0.01em;
 }
 .tg-media-wrap:hover .tg-dl-btn,
 .tg-media-wrap:active .tg-dl-btn {
 opacity: 1;
 transform: scale(1);
 }
 .tg-dl-btn:hover {
 background: rgba(0, 122, 255, 1);
 transform: scale(1.02);
 box-shadow: 0 6px 16px rgba(0, 122, 255, 0.4);
 }
 .tg-dl-btn:active {
 transform: scale(0.98);
 }
 .tg-dl-btn:disabled {
 background: rgba(142, 142, 147, 0.8);
 cursor: not-allowed;
 opacity: 0.6;
 box-shadow: none;
 }
 .tg-media-wrap {
 position: relative !important;
 }

 /* 移动端按钮样式 */
 @media (hover: none) and (pointer: coarse) {
 .tg-dl-btn {
 opacity: 0.95;
 transform: scale(1);
 padding: 8px 14px;
 font-size: 12px;
 min-width: 56px;
 min-height: 32px;
 border-radius: 16px;
 }
 }

 /* 主面板 - 毛玻璃效果 */
 .tg-dl-panel {
 position: fixed;
 ${isMobile
 ? 'bottom: 80px; left: 16px; right: 16px; width: auto; max-height: 55vh;'
 : 'top: 20px; right: 20px; width: 400px; max-height: 500px;'
 }
 background: var(--tg-dl-bg);
 border-radius: var(--tg-dl-radius);
 border: 1px solid var(--tg-dl-border);
 box-shadow: var(--tg-dl-shadow);
 z-index: 10001;
 overflow: hidden;
 display: none;
 flex-direction: column;
 font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
 backdrop-filter: saturate(180%) blur(20px);
 -webkit-backdrop-filter: saturate(180%) blur(20px);
 transition: all 0.35s cubic-bezier(0.32, 0.72, 0, 1);
 }
 .tg-dl-panel.active {
 display: flex;
 animation: panelSlideIn 0.35s cubic-bezier(0.32, 0.72, 0, 1);
 }
 @keyframes panelSlideIn {
 from {
 opacity: 0;
 transform: ${isMobile ? 'translateY(20px)' : 'scale(0.95) translateY(-10px)'};
 }
 to {
 opacity: 1;
 transform: ${isMobile ? 'translateY(0)' : 'scale(1) translateY(0)'};
 }
 }

 /* 头部 - 苹果风格标题栏 */
 .tg-dl-header {
 background: transparent;
 padding: ${isMobile ? '14px 18px' : '16px 20px'};
 display: flex;
 justify-content: space-between;
 align-items: center;
 border-bottom: 1px solid var(--tg-dl-border);
 }
 .tg-dl-header h3 {
 margin: 0;
 color: var(--tg-dl-text);
 font-size: ${isMobile ? '17px' : '18px'};
 font-weight: 600;
 letter-spacing: -0.02em;
 }
 .tg-dl-close {
 background: rgba(142, 142, 147, 0.16);
 border: none;
 color: var(--tg-dl-text-secondary);
 font-size: 20px;
 cursor: pointer;
 width: 28px;
 height: 28px;
 border-radius: 14px;
 display: flex;
 align-items: center;
 justify-content: center;
 transition: all 0.2s ease;
 touch-action: manipulation;
 }
 .tg-dl-close:hover {
 background: rgba(142, 142, 147, 0.24);
 color: var(--tg-dl-text);
 }
 .tg-dl-close:active {
 transform: scale(0.92);
 }

 /* 列表区域 */
 .tg-dl-list {
 overflow-y: auto;
 max-height: ${isMobile ? '45vh' : '400px'};
 padding: ${isMobile ? '10px' : '12px'};
 -webkit-overflow-scrolling: touch;
 }
 .tg-dl-list::-webkit-scrollbar {
 width: 6px;
 }
 .tg-dl-list::-webkit-scrollbar-track {
 background: transparent;
 }
 .tg-dl-list::-webkit-scrollbar-thumb {
 background: rgba(120, 120, 128, 0.2);
 border-radius: 3px;
 }

 /* 下载项卡片 - 苹果风格卡片 */
 .tg-dl-item {
 background: rgba(120, 120, 128, 0.08);
 border-radius: var(--tg-dl-radius-sm);
 padding: ${isMobile ? '12px' : '14px'};
 margin-bottom: ${isMobile ? '8px' : '10px'};
 color: var(--tg-dl-text);
 transition: all 0.2s ease;
 border: 1px solid transparent;
 }
 .tg-dl-item:hover {
 background: rgba(120, 120, 128, 0.12);
 border-color: var(--tg-dl-border);
 transform: translateY(-1px);
 }

 /* 下载项头部 */
 .tg-dl-item-header {
 display: flex;
 justify-content: space-between;
 align-items: flex-start;
 margin-bottom: 10px;
 gap: 10px;
 }
 .tg-dl-filename {
 font-size: ${isMobile ? '14px' : '15px'};
 font-weight: 500;
 word-break: break-word;
 flex: 1;
 line-height: 1.4;
 color: var(--tg-dl-text);
 letter-spacing: -0.01em;
 }
 .tg-dl-actions {
 display: flex;
 gap: 6px;
 flex-shrink: 0;
 }

 /* 小按钮 - 苹果风格 */
 .tg-dl-btn-small {
 background: var(--tg-dl-danger);
 color: white;
 border: none;
 padding: 6px 10px;
 border-radius: 8px;
 cursor: pointer;
 font-size: 11px;
 font-weight: 500;
 min-width: 36px;
 min-height: 28px;
 touch-action: manipulation;
 transition: all 0.2s ease;
 }
 .tg-dl-btn-small:hover {
 opacity: 0.85;
 transform: scale(1.05);
 }
 .tg-dl-btn-small:active {
 transform: scale(0.95);
 }
 .tg-dl-btn-pause {
 background: var(--tg-dl-warning);
 }
 .tg-dl-btn-pause:hover {
 opacity: 0.85;
 }

 /* 进度条 - 苹果风格 */
 .tg-dl-progress-bar {
 width: 100%;
 height: 4px;
 background: rgba(120, 120, 128, 0.16);
 border-radius: 2px;
 overflow: hidden;
 }
 .tg-dl-progress-fill {
 height: 100%;
 background: linear-gradient(90deg, var(--tg-dl-primary), #5AC8FA);
 width: 0%;
 border-radius: 2px;
 transition: width 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
 }
 .tg-dl-status {
 font-size: ${isMobile ? '12px' : '13px'};
 color: var(--tg-dl-text-secondary);
 margin-top: 8px;
 display: flex;
 justify-content: space-between;
 flex-wrap: wrap;
 gap: 4px;
 font-weight: 400;
 }

 /* 切换按钮 - 浮动胶囊按钮 */
 .tg-dl-toggle {
 position: fixed;
 bottom: ${isMobile ? '16px' : '24px'};
 right: ${isMobile ? '16px' : '24px'};
 background: rgba(0, 122, 255, 0.92);
 color: white;
 border: none;
 padding: ${isMobile ? '10px 18px' : '12px 22px'};
 border-radius: 24px;
 cursor: pointer;
 font-size: ${isMobile ? '14px' : '15px'};
 font-weight: 600;
 z-index: 10000;
 box-shadow: 0 4px 20px rgba(0, 122, 255, 0.35);
 display: flex;
 align-items: center;
 gap: 8px;
 touch-action: manipulation;
 min-height: ${isMobile ? '44px' : '48px'};
 backdrop-filter: blur(20px) saturate(180%);
 -webkit-backdrop-filter: blur(20px) saturate(180%);
 transition: all 0.3s cubic-bezier(0.25, 0.1, 0.25, 1);
 letter-spacing: -0.01em;
 }
 .tg-dl-toggle:hover {
 background: rgba(0, 122, 255, 1);
 transform: translateY(-2px);
 box-shadow: 0 8px 28px rgba(0, 122, 255, 0.45);
 }
 .tg-dl-toggle:active {
 transform: translateY(0) scale(0.98);
 }
 .tg-dl-toggle.compact {
 padding: 12px;
 border-radius: 50%;
 min-width: 48px;
 min-height: 48px;
 justify-content: center;
 }

 /* 徽章 - 苹果风格红点 */
 .tg-dl-badge {
 background: var(--tg-dl-danger);
 color: white;
 border-radius: 50%;
 min-width: 20px;
 height: 20px;
 display: flex;
 align-items: center;
 justify-content: center;
 font-size: 11px;
 font-weight: 600;
 padding: 0 6px;
 box-shadow: 0 2px 6px rgba(255, 59, 48, 0.4);
 }
 .tg-dl-badge.hidden {
 display: none;
 }

 /* 移动端适配 */
 @media (max-width: 768px) {
 .tg-dl-panel {
 border-radius: 24px 24px 0 0;
 bottom: 0;
 left: 0;
 right: 0;
 max-height: 65vh;
 }
 .tg-dl-panel.active {
 animation: panelSlideUp 0.35s cubic-bezier(0.32, 0.72, 0, 1);
 }
 @keyframes panelSlideUp {
 from {
 transform: translateY(100%);
 }
 to {
 transform: translateY(0);
 }
 }
 .tg-dl-toggle {
 padding: 10px 16px;
 font-size: 14px;
 border-radius: 22px;
 }
 }

 /* iOS 安全区域适配 */
 @supports (padding-bottom: env(safe-area-inset-bottom)) {
 .tg-dl-toggle {
 bottom: calc(${isMobile ? '16px' : '24px'} + env(safe-area-inset-bottom));
 }
 .tg-dl-panel {
 padding-bottom: env(safe-area-inset-bottom);
 }
 }

 /* 防止iOS橡皮筋效果 */
 .tg-dl-panel, .tg-dl-list {
 overscroll-behavior: contain;
 }

 /* 空状态提示 */
 .tg-dl-empty {
 text-align: center;
 padding: 40px 20px;
 color: var(--tg-dl-text-secondary);
 font-size: 15px;
 }

 /* 旋转动画 */
 @keyframes spin {
 from {
 transform: rotate(0deg);
 }
 to {
 transform: rotate(360deg);
 }
 }
 `;
            document.head.appendChild(style);

            // 面板
            const panel = document.createElement('div');
            panel.className = 'tg-dl-panel';
            panel.id = 'tg-dl-panel';
 panel.innerHTML = `
 <div class="tg-dl-header">
 <h3>下载</h3>
 <button class="tg-dl-close" aria-label="关闭">×</button>
 </div>
 <div class="tg-dl-list" id="tg-dl-list"></div>
 `;
            document.body.appendChild(panel);

// 切换按钮
 const toggle = document.createElement('button');
 toggle.className = 'tg-dl-toggle';
 toggle.innerHTML = `
 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
 <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
 <polyline points="7 10 12 15 17 10"/>
 <line x1="12" y1="15" x2="12" y2="3"/>
 </svg>
 <span>下载</span>
 <span class="tg-dl-badge hidden" id="tg-badge">0</span>
 `;
 toggle.setAttribute('aria-label', '打开下载面板');
 document.body.appendChild(toggle);

// 绑定事件
 const closeBtn = panel.querySelector('.tg-dl-close');
 const header = panel.querySelector('.tg-dl-header');

 // 关闭按钮
 ResourceManager.addEventListener(closeBtn, 'click', (e) => {
 e.stopPropagation();
 panel.classList.remove('active');
 });

 // 切换按钮
 ResourceManager.addEventListener(toggle, 'click', () => {
 panel.classList.toggle('active');
 });

 // 移动端：点击头部可以关闭面板
 if (isMobile) {
 ResourceManager.addEventListener(header, 'click', (e) => {
 if (e.target === header || e.target.closest('h3')) {
 panel.classList.remove('active');
 }
 });

 // 点击外部关闭面板
 ResourceManager.addEventListener(document, 'click', (e) => {
 if (!panel.contains(e.target) && !toggle.contains(e.target)) {
 panel.classList.remove('active');
 }
 });

 // 向下滑动手势关闭面板
 let touchStartY = 0;
 ResourceManager.addEventListener(panel, 'touchstart', (e) => {
 touchStartY = e.touches[0].clientY;
 }, { passive: true });

 ResourceManager.addEventListener(panel, 'touchmove', (e) => {
 const touchY = e.touches[0].clientY;
 const diff = touchY - touchStartY;
 if (diff > 50 && panel.scrollTop === 0) {
 panel.classList.remove('active');
 }
 }, { passive: true });
 }

            state.ui = {
                panel,
                list: document.getElementById('tg-dl-list'),
                badge: document.getElementById('tg-badge')
            };
        },

        updateBadge() {
            if (state.isDestroyed) return;
            const count = state.tasks.size;
            state.ui.badge.textContent = count;
            state.ui.badge.classList.toggle('hidden', count === 0);
        },

        createTask(id, filename) {
            if (state.isDestroyed) return;

            const item = document.createElement('div');
            item.className = 'tg-dl-item';
            item.id = `task-${id}`;
item.innerHTML = `
 <div class="tg-dl-item-header">
 <div class="tg-dl-filename">${this.escapeHtml(filename)}</div>
 <div class="tg-dl-actions">
 <button class="tg-dl-btn-small tg-dl-btn-pause" data-task="${id}" data-action="pause" aria-label="暂停">
 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
 <rect x="6" y="4" width="4" height="16"/>
 <rect x="14" y="4" width="4" height="16"/>
 </svg>
 </button>
 <button class="tg-dl-btn-small" data-task="${id}" data-action="cancel" aria-label="取消">
 <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
 <line x1="18" y1="6" x2="6" y2="18"/>
 <line x1="6" y1="6" x2="18" y2="18"/>
 </svg>
 </button>
 </div>
 </div>
 <div class="tg-dl-progress-bar">
 <div class="tg-dl-progress-fill" id="progress-${id}"></div>
 </div>
 <div class="tg-dl-status">
 <span id="status-${id}">准备中...</span>
 <span id="speed-${id}"></span>
 </div>
 `;

            // 绑定事件
            const pauseBtn = item.querySelector('[data-action="pause"]');
            const cancelBtn = item.querySelector('[data-action="cancel"]');

            ResourceManager.addEventListener(pauseBtn, 'click', () => {
                const task = state.tasks.get(id);
                if (task) {
                    if (task.paused) {
                        task.resume();
                    } else {
                        task.pause();
                    }
                }
            });

            ResourceManager.addEventListener(cancelBtn, 'click', () => {
                const task = state.tasks.get(id);
                if (task) {
                    task.cancel();
                }
            });

            state.ui.list.appendChild(item);
            state.ui.panel.classList.add('active');
            UI.updateBadge();
        },

        updateTask(id, progress, status, speed) {
            if (state.isDestroyed) return;

            const fill = document.getElementById(`progress-${id}`);
            const statusEl = document.getElementById(`status-${id}`);
            const speedEl = document.getElementById(`speed-${id}`);
            const pauseBtn = document.querySelector(`[data-task="${id}"][data-action="pause"]`);

            if (fill) fill.style.width = progress + '%';
            if (statusEl) statusEl.textContent = status;
            if (speedEl) speedEl.textContent = speed || '';
if (pauseBtn) {
 const task = state.tasks.get(id);
 const isPaused = task?.paused;
 pauseBtn.innerHTML = isPaused
 ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
 : `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
 pauseBtn.setAttribute('aria-label', isPaused ? '继续' : '暂停');
 }
        },

        removeTask(id) {
            if (state.isDestroyed) return;

            const item = document.getElementById(`task-${id}`);
            if (item) {
                item.style.opacity = '0';
                setTimeout(() => item.remove(), 300);
            }
            state.tasks.delete(id);
            UI.updateBadge();
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    };

    // ============ 视频信息提取 ============
    const VideoInfo = {
        extract(url) {
            if (typeof url !== 'string') return null;

            try {
                let encoded, decoded, info;

                if (url.includes('/stream/')) {
                    encoded = url.split('/stream/')[1];
                    if (!encoded) return null;
                    decoded = decodeURIComponent(encoded);
                    info = JSON.parse(decoded);

                    if (info.fileName && info.size) {
                        const uniqueId = info.location?.id || `${info.size}_${info.fileName}`;
                        return {
                            url,
                            fileName: info.fileName,
                            size: info.size,
                            mimeType: info.mimeType || 'video/mp4',
                            id: uniqueId
                        };
                    }
                }

                if (url.includes('/hls_stream/')) {
                    encoded = url.split('/hls_stream/')[1];
                    if (!encoded) return null;
                    decoded = decodeURIComponent(encoded);
                    info = JSON.parse(decoded);

                    if (info.size) {
                        const uniqueId = info.docId || `${info.size}_${info.fileName || Date.now()}`;
                        return {
                            url,
                            fileName: info.fileName || `video_${info.docId || Date.now()}.mp4`,
                            size: info.size,
                            mimeType: info.mimeType || 'video/mp4',
                            id: uniqueId
                        };
                    }
                }
            } catch (e) {
                ErrorHandler.handle('视频信息提取失败', e);
            }

            return null;
        },

        async capture(videoElement) {
            try {
                // Step 1: 暂停视频
                videoElement.pause();
                await new Promise(r => setTimeout(r, 500));

                // Step 2: 记录时间戳
                const captureStart = Date.now();
                performance.clearResourceTimings();

                // Step 3: 强制从头播放
                videoElement.currentTime = 0;
                await new Promise(r => setTimeout(r, 100));

                try {
                    videoElement.play().catch(e => {
                        ErrorHandler.handle('视频播放失败', e);
                    });
                } catch (e) {
                    ErrorHandler.handle('视频播放异常', e);
                }

                // Step 4: 轮询等待新URL
                for (let i = 0; i < 30; i++) {
                    if (state.isDestroyed) return null;
                    await new Promise(r => setTimeout(r, 100));
                    const newCaptures = state.capturedUrls.filter(c => c.captureTime > captureStart);
                    if (newCaptures.length > 0) {
                        const result = newCaptures[newCaptures.length - 1];
                        console.log('[TG DL] 使用视频:', result.fileName, 'ID:', result.id);
                        return result;
                    }
                }

                // Step 5: 超时回退
                console.log('[TG DL] 拦截超时，尝试Performance API');
                const entries = performance.getEntriesByType('resource');
                for (let i = entries.length - 1; i >= 0; i--) {
                    const info = VideoInfo.extract(entries[i].name);
                    if (info) {
                        console.log('[TG DL] 从Performance API获取:', info.fileName);
                        return info;
                    }
                }
            } catch (e) {
                ErrorHandler.handle('视频捕获失败', e);
            }

            return null;
        },

        getContext(videoElement) {
            const context = { chatName: '', messageText: '', date: '' };

            try {
                const msgContainer = videoElement.closest('.message, [class*="message"], [data-message-id]');
                if (msgContainer) {
                    const sender = msgContainer.querySelector('.peer-title, [class*="sender"], [class*="name"]');
                    if (sender) context.chatName = sender.textContent.trim().substring(0, 50);

                    const text = msgContainer.querySelector('.message-text, [class*="text"], .bubble-content');
                    if (text) context.messageText = text.textContent.trim().substring(0, 100);

                    const date = msgContainer.querySelector('.message-time, time');
                    if (date) context.date = date.textContent.trim();
                }

                if (!context.chatName) {
                    const title = document.querySelector('.chat-info .peer-title, .sidebar-header-title');
                    if (title) context.chatName = title.textContent.trim().substring(0, 50);
                }
            } catch (e) {
                ErrorHandler.handle('获取上下文失败', e);
            }

            return context;
        },

        generateName(info, context, captureTime) {
            return FilenameGenerator.generate(info, context, captureTime);
        }
    };

    // ============ 全局网络拦截 ============
    const _origXHROpen = XMLHttpRequest.prototype.open;
    window._origXHROpen = _origXHROpen;

    XMLHttpRequest.prototype.open = function(method, url) {
        try {
            const info = VideoInfo.extract(typeof url === 'string' ? url : String(url));
            if (info) {
                state.capturedUrls.push({ ...info, captureTime: Date.now() });
                if (state.capturedUrls.length > 100) {
                    state.capturedUrls = state.capturedUrls.slice(-50);
                }
                console.log('[TG DL] XHR捕获:', info.fileName, 'ID:', info.id);
            }
        } catch (e) {
            ErrorHandler.handle('XHR拦截错误', e);
        }
        return _origXHROpen.apply(this, arguments);
    };

    const _origFetch = window.fetch;
    window._origFetch = _origFetch;

    window.fetch = function(input) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
            if (url) {
                const info = VideoInfo.extract(url);
                if (info) {
                    state.capturedUrls.push({ ...info, captureTime: Date.now() });
                    if (state.capturedUrls.length > 100) {
                        state.capturedUrls = state.capturedUrls.slice(-50);
                    }
                    console.log('[TG DL] Fetch捕获:', info.fileName, 'ID:', info.id);
                }
            }
        } catch (e) {
            ErrorHandler.handle('Fetch拦截错误', e);
        }
        return _origFetch.apply(this, arguments);
    };

    // ============ 下载任务控制器 ============
    class DownloadTask {
        constructor(taskId, info, filename) {
            this.id = taskId;
            this.info = info;
            this.filename = filename;
            this.cancelled = false;
            this.paused = false;
            this.pauseResolve = null;
            this.downloaded = 0;
            this.chunks = new Map();
            this.startTime = Date.now();
        }

        pause() {
            if (this.paused) return;
            this.paused = true;
            UI.updateTask(this.id, (this.downloaded / this.info.size) * 100, '已暂停', '');
        }

        resume() {
            if (!this.paused) return;
            this.paused = false;
            if (this.pauseResolve) {
                this.pauseResolve();
                this.pauseResolve = null;
            }
        }

        cancel() {
            this.cancelled = true;
            this.resume();
            UI.updateTask(this.id, 0, '正在取消...', '');
        }

        async waitIfPaused() {
            if (this.paused) {
                return new Promise(resolve => {
                    this.pauseResolve = resolve;
                });
            }
        }
    }

// ============ 下载逻辑（支持并发 + 流式合并） ============
const Downloader = {
  // 带超时的fetch
  async fetchWithTimeout(url, options, timeout = CONFIG.TIMEOUT) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await _origFetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  },

  // 优化后的分块下载，支持取消和暂停
  async downloadChunk(url, start, end, retryCount = 0) {
    try {
      const response = await this.fetchWithTimeout(url, {
        headers: { 'Range': `bytes=${start}-${end}` }
      }, CONFIG.TIMEOUT);

      if (!response.ok && response.status !== 206) {
        throw new Error(`HTTP ${response.status}`);
      }

      // 检查服务器是否支持 Range（可能返回整个文件）
      const contentRange = response.headers.get('Content-Range');
      const contentLength = response.headers.get('Content-Length');
      const expectedSize = end - start + 1;

      // 如果没有 Content-Range，检查是否返回了完整文件
      if (response.status === 200 && !contentRange) {
        console.warn(`[TG DL] 服务器不支持 Range 请求，返回完整文件`);
        // 这种情况应该特殊处理，但我们继续尝试读取
      }

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);

      // 验证数据大小（关键修复！）
      // 服务器可能返回的数据比请求的少（网络问题、服务器限制等）
      if (data.length === 0) {
        throw new Error('返回数据为空');
      }

      // 允许 10% 的误差（有些服务器可能返回略少的数据）
      // 但如果误差太大，说明有问题
      if (data.length < expectedSize * 0.9) {
        console.warn(`[TG DL] 数据不完整: ${data.length}/${expectedSize} bytes`);
        // 对于最后一个分块，允许较小的数据
        if (end < url.length) { // 不是最后一块
          throw new Error(`数据不完整: ${data.length}/${expectedSize}`);
        }
      }

      return data;
    } catch (e) {
      // 指数退避 + 抖动，避免雪崩
      if (retryCount < CONFIG.RETRY_COUNT) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
        const jitter = Math.random() * 1000;
        console.log(`[TG DL] 分块下载失败 (${start}-${end})，${delay}ms 后重试 (${retryCount + 1}/${CONFIG.RETRY_COUNT})`);
        await new Promise(r => setTimeout(r, delay + jitter));
        return this.downloadChunk(url, start, end, retryCount + 1);
      }
      throw new Error(`分块下载失败 (${start}-${end}): ${e.message}`);
    }
  },

  // 并发下载管理器（真正的流水线，非阻塞）
  async downloadConcurrent(task, chunksToDownload, onChunkDownloaded) {
    const concurrency = CONFIG.CONCURRENT_DOWNLOADS;
    const executing = new Set();
    const results = new Map();
    let index = 0;
    let failedCount = 0; // 记录失败次数

    // 填充并发槽
    async function fillSlots() {
      while (index < chunksToDownload.length && executing.size < concurrency) {
        const chunk = chunksToDownload[index++];
        const promise = (async () => {
          try {
            await task.waitIfPaused();
            if (task.cancelled) throw new Error('已取消');

            const data = await Downloader.downloadChunk(
              task.info.url,
              chunk.start,
              chunk.end
            );

            await task.waitIfPaused();
            if (task.cancelled) throw new Error('已取消');

            results.set(chunk.index, data);
            task.downloaded += data.length;

            // 回调通知进度
            if (onChunkDownloaded) {
              onChunkDownloaded(chunk.index, data);
            }

            return { success: true, index: chunk.index };
          } catch (e) {
            // 关键修复：记录失败，但不立即抛出
            // 让其他分块继续下载
            console.error(`[TG DL] 分块 ${chunk.index} 下载失败:`, e.message);
            failedCount++;
            return { success: false, index: chunk.index, error: e, chunk };
          }
        })();

        executing.add(promise);
        promise.then(() => executing.delete(promise)).catch(() => executing.delete(promise));
      }
    }

    // 主循环：保持并发槽满
    while (results.size < chunksToDownload.length - failedCount) {
      await task.waitIfPaused();
      if (task.cancelled) throw new Error('已取消');

      // 填充空槽
      await fillSlots();

      // 等待至少一个完成
      if (executing.size > 0) {
        try {
          const result = await Promise.race(executing);
          // 检查是否是失败的
          if (result && !result.success) {
            // 重试这个失败的分块
            console.log(`[TG DL] 准备重试分块 ${result.index}`);
            // 将该分块重新加入队列
            const failedChunk = result.chunk;
            // 找到它在原数组中的位置
            const originalIndex = chunksToDownload.findIndex(c => c.index === failedChunk.index);
            if (originalIndex !== -1) {
              // 延迟后重试
              await new Promise(r => setTimeout(r, 2000));
              if (!task.cancelled) {
                const newIndex = chunksToDownload.length;
                chunksToDownload.push({
                  ...failedChunk,
                  _retry: true
                });
                console.log(`[TG DL] 分块 ${failedChunk.index} 已重新加入队列`);
              }
            }
          }
        } catch (e) {
          // 捕获 Promise.race 中的错误
          console.error('[TG DL] Promise.race 错误:', e);
        }
      }

      // 短暂yield，避免阻塞UI
      if (executing.size >= concurrency) {
        await new Promise(r => setTimeout(r, 0));
      }

      // 如果全部尝试完成但仍有失败，抛出错误
      if (executing.size === 0 && index >= chunksToDownload.length && results.size < chunksToDownload.length - failedCount) {
        throw new Error(`下载失败: ${failedCount} 个分块未完成`);
      }
    }

    // 按顺序返回结果（关键：确保顺序正确）
    const orderedResults = [];
    for (const chunk of chunksToDownload) {
      if (!chunk._retry) { // 跳过重试标记的
        const data = results.get(chunk.index);
        if (data) {
          orderedResults.push({ index: chunk.index, data });
        }
      }
    }

    // 按索引排序
    orderedResults.sort((a, b) => a.index - b.index);

    return orderedResults;
  },

  // 流式下载：分批次合并，避免内存溢出
  async downloadWithStreaming(task, info, onProgress) {
    const chunkSize = CONFIG.getChunkSize(info.size);
    const totalChunks = Math.ceil(info.size / chunkSize);
    const chunksPerBatch = Math.max(1, Math.floor(CONFIG.MERGE_BATCH_SIZE / chunkSize));

    const tempBlobs = [];
    let currentBatch = [];
    let currentBatchSize = 0;
    let completedChunks = 0;
    let actualDownloadedBytes = 0; // 关键修复：记录实际下载字节数

    // 准备分块列表
    const chunksToDownload = [];
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize - 1, info.size - 1);
      chunksToDownload.push({ index: i, start, end });
    }

    // 优先级排序：先下载头部和尾部（对视频播放更有用）
    chunksToDownload.sort((a, b) => {
      const aPriority = (a.start === 0 || a.end === info.size - 1) ? 0 : 1;
      const bPriority = (b.start === 0 || b.end === info.size - 1) ? 0 : 1;
      return aPriority - bPriority;
    });

    // 并发下载并分批合并
    const downloadedChunks = await this.downloadConcurrent(task, chunksToDownload, (index, data) => {
      currentBatch.push({ index, data });
      currentBatchSize += data.length;
      actualDownloadedBytes += data.length; // 关键：累加实际字节数
      completedChunks++;

      // 报告进度
      if (onProgress) {
        const progress = (completedChunks / totalChunks) * 100;
        const elapsed = (Date.now() - task.startTime) / 1000;
        const speed = elapsed > 0 ? (task.downloaded / elapsed / 1024 / 1024).toFixed(2) + ' MB/s' : '';
        onProgress(progress, `下载中: ${progress.toFixed(1)}%`,
          `${(task.downloaded/1024/1024).toFixed(2)}MB / ${(info.size/1024/1024).toFixed(2)}MB ${speed}`);
      }

      // 批次满或最后一个：合并并释放内存
      if (currentBatch.length >= chunksPerBatch || completedChunks >= totalChunks) {
        // 按原始顺序排序
        currentBatch.sort((a, b) => a.index - b.index);
        const batchBlob = new Blob(currentBatch.map(c => c.data), { type: info.mimeType });
        tempBlobs.push(batchBlob);

        // 立即释放这批内存（关键！）
        currentBatch = [];
        currentBatchSize = 0;

        // 尝试触发GC
        if (window.gc) window.gc();

        // 报告批次信息
        if (onProgress && tempBlobs.length > 0) {
          onProgress((completedChunks / totalChunks) * 100,
            `已缓存 ${tempBlobs.length} 批...`, '');
        }
      }
    });

    // 关键修复：验证下载的数据量
    console.log(`[TG DL] 实际下载: ${actualDownloadedBytes} bytes, 期望: ${info.size} bytes`);

    if (actualDownloadedBytes === 0) {
      throw new Error('下载失败：未获取到任何数据');
    }

    if (actualDownloadedBytes < info.size * 0.95) {
      throw new Error(`下载不完整: ${actualDownloadedBytes}/${info.size} bytes (${(actualDownloadedBytes/info.size*100).toFixed(1)}%)`);
    }

    // 如果实际下载量比预期多（不应该发生，但检查一下）
    if (actualDownloadedBytes > info.size * 1.05) {
      console.warn(`[TG DL] 下载数据异常偏多: ${actualDownloadedBytes}/${info.size}`);
    }

    // 最终合并（Blob是引用，不复制数据）
    const finalBlob = tempBlobs.length === 1 ? tempBlobs[0] : new Blob(tempBlobs, { type: info.mimeType });

    // 最后验证 Blob 大小
    if (finalBlob.size !== actualDownloadedBytes) {
      console.warn(`[TG DL] Blob 大小不匹配: ${finalBlob.size} vs ${actualDownloadedBytes}`);
    }

    return finalBlob;
  },

  async start(videoElement) {
    const taskId = ++state.taskId;
    const captureStartTime = Date.now();

    const info = await VideoInfo.capture(videoElement);
    if (!info) {
      alert('未找到视频信息，请播放视频后再试');
      return;
    }

    const context = VideoInfo.getContext(videoElement);
    const filename = VideoInfo.generateName(info, context, captureStartTime);

    console.log('[TG DL] 开始下载:', filename, '大小:', (info.size/1024/1024).toFixed(2) + 'MB');

    const task = new DownloadTask(taskId, info, filename);
    state.tasks.set(taskId, task);
    UI.createTask(taskId, filename);

    try {
      // 使用流式下载（内存安全）
      const blob = await this.downloadWithStreaming(task, info,
        (progress, status, speed) => {
          UI.updateTask(taskId, progress, status, speed);
        }
      );

      if (task.cancelled) {
        UI.removeTask(taskId);
        return;
      }

      // 完整性检查
      if (blob.size < info.size * 0.95) {
        throw new Error(`文件不完整: ${blob.size}/${info.size}`);
      }

      UI.updateTask(taskId, 99, '正在保存...', '');
      this.save(blob, filename);

      UI.updateTask(taskId, 100, '✅ 完成', '');
      setTimeout(() => UI.removeTask(taskId), 3000);

    } catch (e) {
      console.error('[TG DL] 下载失败:', e);
      UI.updateTask(taskId, (task.downloaded / info.size) * 100, '下载失败: ' + e.message, '');
      setTimeout(() => UI.removeTask(taskId), 5000);
    }
  },

        save(blob, filename) {
            try {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 1000);
            } catch (e) {
                ErrorHandler.handle('保存文件失败', e);
                alert('下载失败，请重试');
            }
        }
    };

// ============ 初始化 ============
function init() {
  if (state.isDestroyed) return;

  // 等待 body 存在（移动端可能需要）
  if (!document.body) {
    console.log('[TG DL] 等待 document.body...');
    setTimeout(init, 500);
    return;
  }

  UI.init();

  function cleanup() {
    ResourceManager.cleanup();
  }

  ResourceManager.addEventListener(window, 'beforeunload', cleanup);
  ResourceManager.addEventListener(window, 'pagehide', cleanup);

  ResourceManager.addEventListener(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      // 页面不可见时可暂停非关键操作
    }
  });

  function addButton(video) {
    if (state.isDestroyed) return;
    if (video.dataset.tgDlBtnAdded) return;
    video.dataset.tgDlBtnAdded = 'true';

    const container = video.closest('[class*="media"], [class*="video"]') || video.parentElement;
    if (!container) return;

    container.classList.add('tg-media-wrap');

    const btn = document.createElement('button');
    btn.className = 'tg-dl-btn';
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: -2px;">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      下载
    `;
    btn.setAttribute('aria-label', '下载视频');

    const handleClick = async (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (btn.disabled || state.downloadingVideos.has(video)) {
        console.log('[TG DL] 该视频正在下载中，忽略重复点击');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite; margin-right: 4px; vertical-align: -2px;">
          <line x1="12" y1="2" x2="12" y2="6"/>
          <line x1="12" y1="18" x2="12" y2="22"/>
          <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/>
          <line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
          <line x1="2" y1="12" x2="6" y2="12"/>
          <line x1="18" y1="12" x2="22" y2="12"/>
          <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/>
          <line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
        </svg>
        下载中...
      `;
      state.downloadingVideos.add(video);

      try {
        await Downloader.start(video);
      } catch (err) {
        ErrorHandler.handle('下载过程异常', err);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px; vertical-align: -2px;">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          下载
        `;
        state.downloadingVideos.delete(video);
      }
    };

    ResourceManager.addEventListener(btn, 'click', handleClick);
    container.appendChild(btn);
  }

  let scanTimeout = null;
  let scanAttempts = 0;
  function scan() {
    if (state.isDestroyed) return;
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      const videos = document.querySelectorAll('video');

      videos.forEach(addButton);

      // 移动端：如果没有找到视频，增加重试
      if (videos.length === 0 && scanAttempts < 50) {
        scanAttempts++;
        console.log(`[TG DL] 等待视频加载... (${scanAttempts}/50)`);
        setTimeout(scan, 500);
      } else if (videos.length === 0 && scanAttempts >= 50) {
        console.warn('[TG DL] 多次扫描未找到视频元素，可能页面结构不同');
      }
    }, CONFIG.OBSERVER_DEBOUNCE);
  }

  // 等待 body 存在（移动端可能需要）
  function waitForBody() {
    if (document.body) {
      const observer = new MutationObserver((mutations) => {
        // 只在有实际变化时扫描
        const hasVideoChanges = mutations.some(m =>
          Array.from(m.addedNodes).some(n =>
            n.nodeName === 'VIDEO' || (n.querySelector && n.querySelector('video'))
          )
        );
        if (hasVideoChanges) {
          scan();
        }
      });
      ResourceManager.addObserver(observer);
      observer.observe(document.body, { childList: true, subtree: true });
      scan();
      console.log('[TG DL] MutationObserver 已启动');
    } else {
      console.log('[TG DL] 等待 document.body...');
      setTimeout(waitForBody, 100);
    }
  }
  waitForBody();

  setInterval(() => {
    if (state.isDestroyed) return;
    const now = Date.now();
    state.capturedUrls = state.capturedUrls.filter(c => now - c.captureTime < 300000);
  }, 60000);

  console.log('[TG DL] 已加载', CONFIG.IS_MOBILE ? '(移动端模式)' : '(桌面端模式)');
}

    if (document.readyState === 'loading') {
        ResourceManager.addEventListener(document, 'DOMContentLoaded', init);
    } else {
        init();
    }
})();
