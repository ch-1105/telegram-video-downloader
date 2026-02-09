# Telegram Web Video Downloader

一个简洁高效的 Telegram Web 视频下载器用户脚本，支持桌面端和移动端。

## ✨ 特性

- 📱 **移动端适配** - 完美支持手机浏览器
- ⚡ **并发下载** - 多分片同时下载，提升速度
- 🛡️ **防重复** - 自动检测并避免文件名冲突

## 📦 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击[这里安装脚本](src/telegram-video-downloader.user.js)（或手动复制代码创建新脚本）
3. 访问 [Telegram Web](https://web.telegram.org/)
4. 视频右上角会出现下载按钮

## 🚀 使用

1. 打开 Telegram Web
2. 找到要下载的视频
3. 点击视频上的 **⬇️ 下载** 按钮
4. 在下载管理面板中查看进度
5. 支持暂停、继续、取消操作

## ⚙️ 配置

脚本顶部 `CONFIG` 对象可自定义：

```javascript
const CONFIG = {
  CHUNK_SIZE: 512 * 1024,        // 分片大小（默认 512KB）
  RETRY_COUNT: 3,                // 失败重试次数
  CONCURRENT_DOWNLOADS: 3,       // 并发下载数
  MAX_BUFFER_SIZE: 50 * 1024 * 1024,  // 缓冲区限制 50MB
  OBSERVER_DEBOUNCE: 100         // DOM 扫描防抖延迟
};
```

## 📂 项目结构

```
telegram-video-downloader/
├── src/
│   └── telegram-video-downloader.user.js  # 主脚本
├── README.md
├── LICENSE
└── .gitignore
```

## ⚠️ 免责声明

本工具仅供学习交流使用，用于下载**用户自己有权访问**的 Telegram 内容。

使用者需自行承担以下责任：
1. 遵守当地法律法规
2. 尊重内容版权
3. 不用于商业用途
4. 不侵犯他人隐私

**作者不对任何滥用行为负责。**

## 📝 更新日志

### v9.2
- 重构代码结构，模块化设计
- 添加完整的资源管理和清理机制
- 优化移动端体验
- 添加下载任务暂停/恢复功能
- 实现智能文件名生成

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

[MIT License](LICENSE)

## 🔗 相关

- [Tampermonkey](https://www.tampermonkey.net/)
- [Telegram Web](https://web.telegram.org/)
