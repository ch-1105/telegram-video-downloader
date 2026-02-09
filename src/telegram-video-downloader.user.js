// ==UserScript==
// @name Telegram Web Video Downloader - Clean
// @namespace http://tampermonkey.net/
// @version 9.2
// @description 简洁高效的 Telegram 视频下载器（支持手机端）
// @author You
// @match https://web.telegram.org/*
// @grant none
// @run-at document-start
// ==/UserScript==

(function() {
    'use strict';

    // ============ 配置 ============
    const CONFIG = {
        CHUNK_SIZE: 512 * 1024,
        RETRY_COUNT: 3,
        TIMEOUT: 3000,
        CONCURRENT_DOWNLOADS: 3, // 并发下载数
        MAX_BUFFER_SIZE: 50 * 1024 * 1024, // 50MB 缓冲区限制
        OBSERVER_DEBOUNCE: 100, // MutationObserver 防抖延迟
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
                /* 桌面端样式 */
                .tg-dl-btn {
                    position: absolute;
                    top: ${8 * scale}px;
                    right: ${8 * scale}px;
                    background: #ff4757;
                    color: white;
                    border: none;
                    padding: ${6 * scale}px ${12 * scale}px;
                    border-radius: ${4 * scale}px;
                    cursor: pointer;
                    font-size: ${12 * scale}px;
                    z-index: 9999;
                    opacity: 0;
                    transition: opacity 0.2s;
                    touch-action: manipulation;
                    -webkit-tap-highlight-color: transparent;
                }
                .tg-media-wrap:hover .tg-dl-btn,
                .tg-media-wrap:active .tg-dl-btn {
                    opacity: 1;
                }
                .tg-dl-btn:disabled {
                    background: #888;
                    cursor: not-allowed;
                    opacity: 0.7;
                }
                .tg-media-wrap {
                    position: relative !important;
                }

                /* 移动端按钮样式 - 始终可见 */
                @media (hover: none) and (pointer: coarse) {
                    .tg-dl-btn {
                        opacity: 1;
                        padding: ${10 * scale}px ${16 * scale}px;
                        font-size: ${14 * scale}px;
                        min-width: 60px;
                        min-height: 36px;
                    }
                }

                .tg-dl-panel {
                    position: fixed;
                    ${isMobile ? 'top: 10px; left: 10px; right: 10px; width: auto;' : 'top: 20px; right: 20px; width: 380px;'}
                    max-height: ${isMobile ? '60vh' : '450px'};
                    background: #2f3542;
                    border-radius: ${12 * scale}px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                    z-index: 10001;
                    overflow: hidden;
                    display: none;
                    flex-direction: column;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                .tg-dl-panel.active {
                    display: flex;
                }
                .tg-dl-header {
                    background: #1e272e;
                    padding: ${15 * scale}px ${20 * scale}px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .tg-dl-header h3 {
                    margin: 0;
                    color: white;
                    font-size: ${16 * scale}px;
                }
                .tg-dl-close {
                    background: none;
                    border: none;
                    color: #fff;
                    font-size: ${20 * scale}px;
                    cursor: pointer;
                    opacity: 0.7;
                    padding: ${8 * scale}px;
                    min-width: ${36 * scale}px;
                    min-height: ${36 * scale}px;
                    touch-action: manipulation;
                }
                .tg-dl-close:hover, .tg-dl-close:active {
                    opacity: 1;
                }
                .tg-dl-list {
                    overflow-y: auto;
                    max-height: ${isMobile ? '50vh' : '350px'};
                    padding: ${10 * scale}px;
                    -webkit-overflow-scrolling: touch;
                }
                .tg-dl-item {
                    background: #3d3d3d;
                    border-radius: ${8 * scale}px;
                    padding: ${12 * scale}px;
                    margin-bottom: ${10 * scale}px;
                    color: white;
                }
                .tg-dl-item-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: flex-start;
                    margin-bottom: ${8 * scale}px;
                    gap: ${8 * scale}px;
                }
                .tg-dl-filename {
                    font-size: ${13 * scale}px;
                    word-break: break-all;
                    flex: 1;
                    margin-right: ${10 * scale}px;
                }
                .tg-dl-actions {
                    display: flex;
                    gap: ${6 * scale}px;
                }
                .tg-dl-btn-small {
                    background: #ff4757;
                    color: white;
                    border: none;
                    padding: ${4 * scale}px ${8 * scale}px;
                    border-radius: ${4 * scale}px;
                    cursor: pointer;
                    font-size: ${11 * scale}px;
                    min-width: ${44 * scale}px;
                    min-height: ${28 * scale}px;
                    touch-action: manipulation;
                }
                .tg-dl-btn-small:hover, .tg-dl-btn-small:active {
                    background: #ff3838;
                }
                .tg-dl-btn-pause {
                    background: #ffa502;
                }
                .tg-dl-btn-pause:hover, .tg-dl-btn-pause:active {
                    background: #ff9500;
                }
                .tg-dl-progress-bar {
                    width: 100%;
                    height: ${6 * scale}px;
                    background: #555;
                    border-radius: ${3 * scale}px;
                    overflow: hidden;
                }
                .tg-dl-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #ff4757, #ffa502);
                    width: 0%;
                    transition: width 0.3s;
                }
                .tg-dl-status {
                    font-size: ${11 * scale}px;
                    color: #aaa;
                    margin-top: ${5 * scale}px;
                    display: flex;
                    justify-content: space-between;
                    flex-wrap: wrap;
                    gap: ${4 * scale}px;
                }
                .tg-dl-toggle {
                    position: fixed;
                    bottom: ${isMobile ? '80px' : '20px'};
                    right: ${20 * scale}px;
                    background: #ff4757;
                    color: white;
                    border: none;
                    padding: ${12 * scale}px ${20 * scale}px;
                    border-radius: ${30 * scale}px;
                    cursor: pointer;
                    font-size: ${14 * scale}px;
                    z-index: 10000;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                    display: flex;
                    align-items: center;
                    gap: ${8 * scale}px;
                    touch-action: manipulation;
                    min-height: ${44 * scale}px;
                }
                .tg-dl-toggle:hover, .tg-dl-toggle:active {
                    background: #ff3838;
                }
                .tg-dl-badge {
                    background: #2ed573;
                    color: white;
                    border-radius: 50%;
                    width: ${20 * scale}px;
                    height: ${20 * scale}px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: ${11 * scale}px;
                    font-weight: bold;
                }
                .tg-dl-badge.hidden {
                    display: none;
                }

                /* 移动端特定优化 */
                @media (max-width: 768px) {
                    .tg-dl-panel {
                        border-radius: ${16 * scale}px;
                    }
                    .tg-dl-toggle {
                        padding: ${14 * scale}px ${24 * scale}px;
                        font-size: ${15 * scale}px;
                    }
                }

                /* 防止iOS橡皮筋效果 */
                .tg-dl-panel, .tg-dl-list {
                    overscroll-behavior: contain;
                }
            `;
            document.head.appendChild(style);

            // 面板
            const panel = document.createElement('div');
            panel.className = 'tg-dl-panel';
            panel.id = 'tg-dl-panel';
            panel.innerHTML = `
                <div class="tg-dl-header">
                    <h3>📥 下载管理</h3>
                    <button class="tg-dl-close" aria-label="关闭">×</button>
                </div>
                <div class="tg-dl-list" id="tg-dl-list"></div>
            `;
            document.body.appendChild(panel);

            // 切换按钮
            const toggle = document.createElement('button');
            toggle.className = 'tg-dl-toggle';
            toggle.innerHTML = '⬇️ 下载 <span class="tg-dl-badge hidden" id="tg-badge">0</span>';
            toggle.setAttribute('aria-label', '打开下载面板');
            document.body.appendChild(toggle);

            // 绑定事件
            const closeBtn = panel.querySelector('.tg-dl-close');
            ResourceManager.addEventListener(closeBtn, 'click', () => {
                panel.classList.remove('active');
            });

            ResourceManager.addEventListener(toggle, 'click', () => {
                panel.classList.toggle('active');
            });

            // 点击外部关闭面板（移动端优化）
            if (isMobile) {
                ResourceManager.addEventListener(document, 'click', (e) => {
                    if (!panel.contains(e.target) && !toggle.contains(e.target)) {
                        panel.classList.remove('active');
                    }
                });
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
                        <button class="tg-dl-btn-small tg-dl-btn-pause" data-task="${id}" data-action="pause" aria-label="暂停">⏸</button>
                        <button class="tg-dl-btn-small" data-task="${id}" data-action="cancel" aria-label="取消">✕</button>
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
                pauseBtn.textContent = task?.paused ? '▶' : '⏸';
                pauseBtn.setAttribute('aria-label', task?.paused ? '继续' : '暂停');
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

    // ============ 下载逻辑（支持并发） ============
    const Downloader = {
        async downloadChunk(url, start, end, retryCount = 0) {
            try {
                const response = await _origFetch(url, {
                    headers: { 'Range': `bytes=${start}-${end}` }
                });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const blob = await response.blob();
                const arrayBuffer = await blob.arrayBuffer();
                return new Uint8Array(arrayBuffer);
            } catch (e) {
                if (retryCount < CONFIG.RETRY_COUNT - 1) {
                    await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
                    return this.downloadChunk(url, start, end, retryCount + 1);
                }
                throw e;
            }
        },

        async downloadChunksConcurrent(task, chunksToDownload) {
            const downloadPromises = chunksToDownload.map(async ({ index, start, end }) => {
                if (task.chunks.has(index)) {
                    return { index, data: task.chunks.get(index) };
                }

                await task.waitIfPaused();
                if (task.cancelled) throw new Error('已取消');

                const data = await this.downloadChunk(task.info.url, start, end);

                await task.waitIfPaused();
                if (task.cancelled) throw new Error('已取消');

                task.chunks.set(index, data);
                task.downloaded += data.length;

                return { index, data };
            });

            return Promise.all(downloadPromises);
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

            console.log('[TG DL] 开始下载:', filename);

            const task = new DownloadTask(taskId, info, filename);
            state.tasks.set(taskId, task);
            UI.createTask(taskId, filename);

            const totalChunks = Math.ceil(info.size / CONFIG.CHUNK_SIZE);
            const chunksToDownload = [];
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CONFIG.CHUNK_SIZE;
                const end = Math.min(start + CONFIG.CHUNK_SIZE - 1, info.size - 1);
                chunksToDownload.push({ index: i, start, end });
            }

            try {
                const batchSize = CONFIG.CONCURRENT_DOWNLOADS;
                for (let i = 0; i < chunksToDownload.length; i += batchSize) {
                    if (task.cancelled) {
                        UI.removeTask(taskId);
                        return;
                    }

                    await task.waitIfPaused();

                    const batch = chunksToDownload.slice(i, i + batchSize);
                    await this.downloadChunksConcurrent(task, batch);

                    const progress = (task.downloaded / info.size) * 100;
                    const elapsed = (Date.now() - task.startTime) / 1000;
                    const speed = elapsed > 0 ? (task.downloaded / elapsed / 1024 / 1024).toFixed(2) + ' MB/s' : '';

                    UI.updateTask(
                        taskId,
                        progress,
                        `下载中: ${progress.toFixed(1)}%`,
                        `${(task.downloaded/1024/1024).toFixed(2)}MB / ${(info.size/1024/1024).toFixed(2)}MB ${speed}`
                    );

                    if (i > 0 && i % (batchSize * 3) === 0) {
                        await new Promise(r => setTimeout(r, 50));
                    }
                }

                if (task.cancelled) {
                    UI.removeTask(taskId);
                    return;
                }

                UI.updateTask(taskId, 99, '正在合并...', '');

                const chunks = [];
                for (let i = 0; i < totalChunks; i++) {
                    chunks.push(task.chunks.get(i));
                }

                const blob = new Blob(chunks, { type: info.mimeType });

                if (blob.size < info.size * 0.95) {
                    throw new Error(`文件不完整: ${blob.size}/${info.size}`);
                }

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
            btn.innerHTML = '⬇️ 下载';
            btn.setAttribute('aria-label', '下载视频');

            const handleClick = async (e) => {
                e.stopPropagation();
                e.preventDefault();

                if (btn.disabled || state.downloadingVideos.has(video)) {
                    console.log('[TG DL] 该视频正在下载中，忽略重复点击');
                    return;
                }

                btn.disabled = true;
                btn.innerHTML = '⏳';
                state.downloadingVideos.add(video);

                try {
                    await Downloader.start(video);
                } catch (err) {
                    ErrorHandler.handle('下载过程异常', err);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = '⬇️ 下载';
                    state.downloadingVideos.delete(video);
                }
            };

            ResourceManager.addEventListener(btn, 'click', handleClick);
            container.appendChild(btn);
        }

        let scanTimeout = null;
        function scan() {
            if (state.isDestroyed) return;
            if (scanTimeout) clearTimeout(scanTimeout);
            scanTimeout = setTimeout(() => {
                document.querySelectorAll('video').forEach(addButton);
            }, CONFIG.OBSERVER_DEBOUNCE);
        }

        const observer = new MutationObserver(scan);
        ResourceManager.addObserver(observer);
        observer.observe(document.body, { childList: true, subtree: true });

        scan();

        setInterval(() => {
            if (state.isDestroyed) return;
            const now = Date.now();
            state.capturedUrls = state.capturedUrls.filter(c => now - c.captureTime < 300000);
        }, 60000);

        console.log('[TG Downloader v9.2] 已加载', CONFIG.IS_MOBILE ? '(移动端模式)' : '(桌面端模式)');
    }

    if (document.readyState === 'loading') {
        ResourceManager.addEventListener(document, 'DOMContentLoaded', init);
    } else {
        init();
    }
})();
