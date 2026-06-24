const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// 判断是否为开发环境 (这里简单用命令行参数判断)
const isDev = process.argv.includes('--dev');

// 动态导入 ESM 模块
async function loadPiModules() {
  const agent = await import('@earendil-works/pi-coding-agent');
  const ai = await import('@earendil-works/pi-ai');
  return { ...agent, ...ai };
}

app.whenReady().then(() => {
  // 注册 IPC Handlers
  ipcMain.handle('get-models', async () => {
    const nameMap = new Map();
    let modelList = [];
    let defaultModel = null;
    const thinkingLevels = {};
    const thinkingLevelMaps = {};

    try {
      const { AuthStorage, ModelRegistry, SettingsManager, getAgentDir, getSupportedThinkingLevels } = await loadPiModules();
      const agentDir = getAgentDir();
      const authStorage = AuthStorage.create();
      const registry = ModelRegistry.create(authStorage);
      const available = registry.getAvailable();
      modelList = available.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
      }));
      for (const m of available) {
        const key = `${m.provider}:${m.id}`;
        nameMap.set(key, m.name);
        thinkingLevels[key] = getSupportedThinkingLevels(m);
        if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
      }

      const settings = SettingsManager.create(process.cwd(), agentDir);
      const provider = settings.getDefaultProvider();
      const modelId = settings.getDefaultModel();
      if (provider) {
        defaultModel = { provider, modelId: modelId ?? available[0]?.id ?? "" };
      }
    } catch (e) {
      console.error("Failed to get models:", e);
    }

    return { 
      models: Object.fromEntries(nameMap), 
      modelList, 
      defaultModel, 
      thinkingLevels, 
      thinkingLevelMaps 
    };
  });

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
