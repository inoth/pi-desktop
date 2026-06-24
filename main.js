/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./src/main/ipc-handlers.js');
const { registerFileIpcHandlers, registerProtocolHandler, registerAppProtocolHandler } = require('./src/main/ipc-handlers-files.js');

// 注册特权协议（必须在 app.whenReady() 之前）
protocol.registerSchemesAsPrivileged([
  { scheme: 'pi-file', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
  { scheme: 'app', privileges: { secure: true, standard: true, supportFetchAPI: true } }
]);

// 判断是否为开发环境 (这里简单用命令行参数判断)
const isDev = process.argv.includes('--dev');

app.whenReady().then(() => {
  // 注册自定义协议处理器
  registerProtocolHandler();
  registerAppProtocolHandler();

  // 注册 IPC Handlers
  registerIpcHandlers();
  registerFileIpcHandlers();

  function createWindow() {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: "Pi Desktop",
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        // 推荐开启上下文隔离，更安全
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    // 防止网页 title 覆盖窗口 title
    win.on('page-title-updated', (e) => {
      e.preventDefault();
    });

    if (isDev) {
      // 阶段1开发模式：直接加载 Next.js 的本地服务
      // 这样现有的 fetch('/api/...') 都能正常工作
      win.loadURL('http://localhost:30141');
      win.webContents.openDevTools();
    } else {
      // 生产模式：加载 Next.js 静态导出的 index.html
      // 改为使用 app:// 协议加载，这样能正确解析 /_next/... 等绝对路径资源
      win.loadURL('app://./index.html');
    }
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
