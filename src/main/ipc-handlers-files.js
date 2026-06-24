const { ipcMain, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getRpcSession } = require('./rpc-manager.js');

// 简单判断是否是绝对路径
function isWindowsAbsolutePath(filePath) {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

function normalizeSlashes(filePath) {
  return filePath.replace(/\\/g, "/");
}

function filePathFromSegments(segments) {
  const joined = segments.join("/");
  const slashJoined = normalizeSlashes(joined);
  if (isWindowsAbsolutePath(slashJoined)) return slashJoined;
  return "/" + joined.replace(/^\/+/, "");
}

function encodeFilePathForApi(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}
function decodeFilePathFromApi(encoded) {
  return encoded.split("/").map(decodeURIComponent);
}

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor", ".DS_Store", ".git",
]);

const IGNORED_SUFFIXES = [".pyc"];

const IMAGE_EXT_TO_MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
  avif: "image/avif",
};

const AUDIO_EXT_TO_MIME = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  weba: "audio/webm", webm: "audio/webm",
};

const DOCUMENT_EXT_TO_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getExt(filePath) {
  return path.basename(filePath).toLowerCase().split(".").pop() || "";
}

function getImageMime(filePath) { return IMAGE_EXT_TO_MIME[getExt(filePath)] || null; }
function getAudioMime(filePath) { return AUDIO_EXT_TO_MIME[getExt(filePath)] || null; }
function getDocumentMime(filePath) { return DOCUMENT_EXT_TO_MIME[getExt(filePath)] || null; }

const EXT_TO_LANGUAGE = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby",
  go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  html: "html", htm: "html", css: "css", scss: "css", less: "css",
  json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  sql: "sql", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

function getLanguage(filePath) {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.split(".").pop() || "";
  return EXT_TO_LANGUAGE[ext] || "text";
}

function documentPreviewKind(filePath) {
  const ext = getExt(filePath);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  return null;
}

// 维护当前活跃的、被授权的工作区列表
const activeAllowedWorkspaces = new Set();

let cachedDefaultRoots = null;

async function getAllowedRoots() {
  if (cachedDefaultRoots === null) {
    cachedDefaultRoots = new Set();
    const home = os.homedir();
    try {
      const names = await fs.promises.readdir(home);
      for (const name of names) {
        if (/^pi-cwd-\d{8}$/.test(name)) {
          cachedDefaultRoots.add(path.join(home, name));
        }
      }
    } catch {
      // ignore
    }
  }

  const roots = new Set(activeAllowedWorkspaces);
  for (const root of cachedDefaultRoots) {
    roots.add(root);
  }
  return roots;
}

function isPathAllowed(target, allowedRoots) {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

const fileWatchers = new Map();

function registerFileIpcHandlers() {
  // 注册/授权一个新的工作区目录
  ipcMain.handle('register-workspace', async (e, cwd) => {
    try {
      if (typeof cwd === 'string' && cwd.trim()) {
        const absolutePath = path.resolve(cwd.trim());
        activeAllowedWorkspaces.add(absolutePath);
        return { success: true };
      }
      return { error: "Invalid path" };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('cwd-validate', async (e, cwd) => {
    try {
      const normalizedCwd = typeof cwd === 'string' ? cwd.trim() : '';
      if (!normalizedCwd) return { error: "Path is required" };
      
      let finalCwd = normalizedCwd;
      if (finalCwd === "~") finalCwd = os.homedir();
      else if (finalCwd.startsWith("~/")) finalCwd = path.resolve(os.homedir(), finalCwd.slice(2));
      else finalCwd = path.isAbsolute(finalCwd) ? finalCwd : path.resolve(finalCwd);
      
      let stat;
      try {
        stat = await fs.promises.stat(finalCwd);
      } catch {
        return { error: `Directory does not exist: ${cwd}` };
      }
      if (!stat.isDirectory()) {
        return { error: `Path is not a directory: ${cwd}` };
      }
      return { success: true, cwd: finalCwd };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('default-cwd', async () => {
    try {
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const dir = path.join(os.homedir(), `pi-cwd-${date}`);
      await fs.promises.mkdir(dir, { recursive: true });
      return { cwd: dir };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('home-dir', async () => {
    return { home: os.homedir() };
  });

  ipcMain.handle('list-dir', async (e, dirPath) => {
    try {
      const segments = decodeFilePathFromApi(dirPath);
      const filePath = filePathFromSegments(segments);
      const allowedRoots = await getAllowedRoots();
      if (!isPathAllowed(filePath, allowedRoots)) return { error: "Access denied" };
      
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return { error: "Not found" };
      }
      
      if (!stat.isDirectory()) return { error: "Not a directory" };
      
      const names = await fs.promises.readdir(filePath);
      const entriesRaw = await Promise.all(names
        .filter((name) => !IGNORED_NAMES.has(name) && !IGNORED_SUFFIXES.some((s) => name.endsWith(s)))
        .map(async (name) => {
          const full = path.join(filePath, name);
          try {
            const s = await fs.promises.stat(full);
            return {
              name,
              isDir: s.isDirectory(),
              size: s.isFile() ? s.size : 0,
              modified: s.mtime.toISOString(),
            };
          } catch {
            return null;
          }
        })
      );
      
      const entries = entriesRaw.filter(Boolean).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { entries, path: filePath };
    } catch (err) {
      return { error: String(err) };
    }
  });
  
  ipcMain.handle('read-file', async (e, reqPath) => {
    try {
      const segments = decodeFilePathFromApi(reqPath);
      const filePath = filePathFromSegments(segments);
      const allowedRoots = await getAllowedRoots();
      if (!isPathAllowed(filePath, allowedRoots)) return { error: "Access denied" };
      
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return { error: "Not found" };
      }
      
      if (!stat.isFile()) return { error: "Not a file" };
      if (stat.size > 256 * 1024) return { error: "File too large for preview (>256KB)" };
      
      const content = await fs.promises.readFile(filePath, "utf-8");
      const language = getLanguage(filePath);
      return { content, language, size: stat.size };
    } catch (err) {
      return { error: String(err) };
    }
  });
  
  ipcMain.handle('file-meta', async (e, reqPath) => {
    try {
      const segments = decodeFilePathFromApi(reqPath);
      const filePath = filePathFromSegments(segments);
      const allowedRoots = await getAllowedRoots();
      if (!isPathAllowed(filePath, allowedRoots)) return { error: "Access denied" };
      
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return { error: "Not found" };
      }
      
      if (!stat.isFile()) return { error: "Not a file" };
      
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      
      return {
        size: stat.size,
        language: getLanguage(filePath),
        mime: imageMime || audioMime || documentMime || "text/plain",
        previewKind: documentPreviewKind(filePath),
      };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('watch-file', async (e, reqPath) => {
    const segments = decodeFilePathFromApi(reqPath);
    const filePath = filePathFromSegments(segments);
    
    // Check if already watching this file for this webContents
    const watcherKey = `${e.sender.id}:${filePath}`;
    if (fileWatchers.has(watcherKey)) {
      return { success: true };
    }
    
    try {
      const watcher = fs.watch(filePath, async () => {
        try {
          const s = await fs.promises.stat(filePath);
          e.sender.send(`file-changed-${reqPath}`, { mtime: s.mtime.toISOString(), size: s.size });
        } catch {
          e.sender.send(`file-changed-${reqPath}`, { mtime: new Date().toISOString(), size: 0 });
        }
      });
      
      watcher.on('error', () => {
         e.sender.send(`file-error-${reqPath}`, { message: "Failed to watch file" });
      });
      
      fileWatchers.set(watcherKey, watcher);
      
      // Listen for webContents being destroyed to clean up watcher
      e.sender.once('destroyed', () => {
        if (fileWatchers.has(watcherKey)) {
          fileWatchers.get(watcherKey).close();
          fileWatchers.delete(watcherKey);
        }
      });
      
      return { success: true };
    } catch (err) {
      return { error: String(err) };
    }
  });

  ipcMain.handle('unwatch-file', (e, reqPath) => {
    const segments = decodeFilePathFromApi(reqPath);
    const filePath = filePathFromSegments(segments);
    const watcherKey = `${e.sender.id}:${filePath}`;
    
    if (fileWatchers.has(watcherKey)) {
      fileWatchers.get(watcherKey).close();
      fileWatchers.delete(watcherKey);
    }
    return { success: true };
  });
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapDocxPreviewHtml(bodyHtml, fileName) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

// 注册 app:// 协议拦截器 (用于加载 Next.js 静态文件)
function registerAppProtocolHandler() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      
      // out/ directory is the root of the app
      let filePath = path.join(__dirname, '..', '..', 'out', url.pathname);
      
      if (filePath.endsWith('/')) {
        filePath = path.join(filePath, 'index.html');
      }
      
      // Fallback for Next.js routing
      try {
        await fs.promises.stat(filePath);
      } catch {
        try {
          await fs.promises.stat(filePath + '.html');
          filePath += '.html';
        } catch {
          if (url.pathname !== '/' && url.pathname !== '/index.html') {
            // 只对非根路径进行 fallback
            filePath = path.join(__dirname, '..', '..', 'out', 'index.html');
          } else {
            return new Response("Not found", { status: 404 });
          }
        }
      }

      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
        '.ttf': 'font/ttf'
      };
      
      const ext = path.extname(filePath);
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      
      const data = await fs.promises.readFile(filePath);
      return new Response(data, {
        headers: { 'Content-Type': contentType }
      });
    } catch (err) {
      console.error("app protocol error:", err);
      return new Response("Not found", { status: 404 });
    }
  });
}

// 注册 pi-file:// 协议拦截器
function registerProtocolHandler() {
  protocol.handle('pi-file', async (request) => {
    try {
      const url = new URL(request.url);
      const searchParams = url.searchParams;
      const type = searchParams.get('type') || 'read';
      
      let filePathStr = decodeURIComponent(url.pathname);
      // macOS 可能是 pi-file:///Users/...
      // Windows 可能是 pi-file:///C:/Users/...
      if (filePathStr.startsWith('///')) {
        filePathStr = filePathStr.substring(2);
      } else if (filePathStr.startsWith('//')) {
        filePathStr = filePathStr.substring(1);
      }
      
      const filePath = filePathFromSegments(filePathStr.split('/').filter(Boolean));
      const allowedRoots = await getAllowedRoots();
      
      if (!isPathAllowed(filePath, allowedRoots)) {
        return new Response("Access denied", { status: 403 });
      }

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        return new Response("Not found", { status: 404 });
      }

      if (!stat.isFile()) {
        return new Response("Not a file", { status: 400 });
      }

      if (type === 'preview' && getExt(filePath) === 'docx') {
        if (stat.size > 10 * 1024 * 1024) {
          return new Response("DOCX too large for preview (>10MB)", { status: 413 });
        }
        
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml(
          { path: filePath },
          {
            externalFileAccess: false,
            convertImage: mammoth.images.dataUri,
          }
        );
        const html = wrapDocxPreviewHtml(result.value, path.basename(filePath));
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      // Handle regular read for images, audio, etc.
      const imageMime = getImageMime(filePath);
      const audioMime = getAudioMime(filePath);
      const documentMime = getDocumentMime(filePath);
      
      let contentType = imageMime || audioMime || documentMime || 'application/octet-stream';
      
      if (imageMime && stat.size > 10 * 1024 * 1024) {
        return new Response("Image too large (>10MB)", { status: 413 });
      }

      // Create a native node stream to readable stream wrapper
      const nodeStreamToReadable = (nodeStream) => {
        let closed = false;
        return new ReadableStream({
          start(controller) {
            nodeStream.on('data', chunk => {
              if (closed) return;
              try { controller.enqueue(new Uint8Array(chunk)); } 
              catch { closed = true; nodeStream.destroy(); }
            });
            nodeStream.on('end', () => {
              if (closed) return;
              closed = true;
              try { controller.close(); } catch { /* ignore */ }
            });
            nodeStream.on('error', err => {
              if (closed) return;
              closed = true;
              try { controller.error(err); } catch { /* ignore */ }
            });
          },
          cancel() {
            closed = true;
            nodeStream.destroy();
          }
        });
      };

      const encodeHeaderValue = (val) => encodeURIComponent(val).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
      const getContentDisposition = (p) => {
        const fileName = path.basename(p);
        const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
        return `inline; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
      };

      const rangeHeader = request.headers.get("range");
      const headers = {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "Accept-Ranges": "bytes",
        "Content-Disposition": getContentDisposition(filePath),
      };

      if (!rangeHeader) {
        return new Response(nodeStreamToReadable(fs.createReadStream(filePath)), {
          headers: { ...headers, "Content-Length": String(stat.size) },
        });
      }

      const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (!match) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${stat.size}` },
        });
      }

      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : stat.size - 1;
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        start = Math.max(stat.size - suffixLength, 0);
        end = stat.size - 1;
      }

      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${stat.size}` },
        });
      }

      end = Math.min(end, stat.size - 1);
      const chunkSize = end - start + 1;
      return new Response(nodeStreamToReadable(fs.createReadStream(filePath, { start, end })), {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(chunkSize),
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        },
      });

    } catch (error) {
      console.error("pi-file protocol error:", error);
      return new Response(String(error), { status: 500 });
    }
  });
}

module.exports = {
  registerFileIpcHandlers,
  registerProtocolHandler,
  registerAppProtocolHandler
};
