# Telegram Web Video Downloader

A clean and efficient userscript for downloading videos from Telegram Web, supporting both desktop and mobile browsers.

## ✨ Features

- 📱 **Mobile Support** - Fully optimized for mobile browsers
- ⚡ **Concurrent Downloads** - Multi-chunk parallel downloading for faster speeds
- ⏸️ **Pause/Resume** - Support for pausing and resuming downloads
- 🧹 **Resource Management** - Comprehensive memory leak prevention

## 🔧 Technical Highlights

- **Network Interception**: Captures video URLs by hooking XMLHttpRequest/fetch
- **Chunked Downloads**: Implements resumable downloads using HTTP Range requests
- **Concurrency Control**: Parallel task execution using Promise.all
- **Dynamic Monitoring**: MutationObserver for SPA page changes
- **Task Management**: ES6 Class-based download task state control

## 📦 Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Click [here to install the script](src/telegram-video-downloader.user.js) (or manually copy the code to create a new script)
3. Visit [Telegram Web](https://web.telegram.org/)
4. A download button will appear on video elements

## 🚀 Usage

1. Open Telegram Web
2. Find the video you want to download
3. Click the **⬇️ Download** button on the video
4. Monitor progress in the download manager panel
5. Supports pause, resume, and cancel operations

## ⚙️ Configuration

Customize settings by modifying the `CONFIG` object at the top of the script:

```javascript
const CONFIG = {
  CHUNK_SIZE: 512 * 1024,        // Chunk size (default 512KB)
  RETRY_COUNT: 3,                // Number of retry attempts
  CONCURRENT_DOWNLOADS: 3,       // Number of concurrent downloads
  MAX_BUFFER_SIZE: 50 * 1024 * 1024,  // Buffer limit 50MB
  OBSERVER_DEBOUNCE: 100         // DOM scan debounce delay
};
```

## 📂 Project Structure

```
telegram-video-downloader/
├── src/
│   └── telegram-video-downloader.user.js  # Main script
├── README.md
├── LICENSE
└── .gitignore
```

## ⚠️ Disclaimer

This tool is provided for educational purposes only and should be used to download **content you have legitimate access to** on Telegram.

Users are solely responsible for:
1. Complying with applicable laws and regulations
2. Respecting content copyrights
3. Not using for commercial purposes
4. Not infringing on others' privacy

**The authors assume no responsibility for any misuse of this software.**

## 🤝 Contributing

Issues and Pull Requests are welcome!

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## 📄 License

[MIT License](LICENSE)

## 🔗 Related Links

- [Tampermonkey](https://www.tampermonkey.net/)
- [Telegram Web](https://web.telegram.org/)
