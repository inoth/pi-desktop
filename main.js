/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const { registerIpcHandlers } = require('./src/main/ipc-handlers.js');

// 判断是否为开发环境 (这里简单用命令行参数判断)
const isDev = process.argv.includes('--dev');

app.whenReady().then(() => {
  // 注册 IPC Handlers
  registerIpcHandlers();

  function createWindow() {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        // 推荐开启上下文隔离，更安全
        contextIsolation: true,
        nodeIntegration: false,
      }
    });

    if (isDev) {
      // 阶段1开发模式：直接加载 Next.js 的本地服务
      // 这样现有的 fetch('/api/...') 都能正常工作
      win.loadURL('http://localhost:30141');
      win.webContents.openDevTools();
    } else {
      // 生产模式：加载 Next.js 静态导出的 index.html (后续 Phase 2 使用)
      win.loadFile(path.join(__dirname, 'out/index.html'));
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
