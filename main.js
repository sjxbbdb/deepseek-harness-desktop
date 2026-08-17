'use strict';

/**
 * DeepSeek Harness 桌面端 —— 主进程
 *
 * 功能：
 *  - 内嵌 DSH Web 界面（默认 http://127.0.0.1:3080）
 *  - 自动托管 dsh 服务进程（检测到已有服务则复用，退出时清理自启进程）
 *  - 系统托盘（隐藏/显示、浏览器打开、重启服务、开机自启、退出）
 *  - 单实例锁、启动状态页、服务崩溃通知
 */

const {
  app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain,
} = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

process.on('unhandledRejection', (err) => console.error('[main] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[main] uncaughtException:', err));

const LOG_FILE = path.join(__dirname, 'main-debug.log');
function dlog(...args) {
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + args.join(' ') + '\n'); } catch {}
}

dlog('--- app start ---', process.pid, 'userData:', app.getPath('userData'));

const APP_NAME = 'DeepSeek Harness';
const DEFAULT_PORT = 3080;
const BOOT_POLL_INTERVAL = 600;      // 就绪轮询间隔 ms
const BOOT_POLL_TIMEOUT = 120000;    // 启动等待上限
const READY_MARKER = '__DSH_BOOT__'; // dsh HTML 特征串

// ---- 运行时自愈（缺依赖自动下载） ----
const RUNTIME_TAG = 'v0.1.1';          // dsh-runtime.zip 所在的 Release tag
const RUNTIME_ASSET = 'dsh-runtime.zip'; // 运行时依赖包（node_modules 全集）
const RUNTIME_MIRRORS = [
  'https://github.com/sjxbbdb/deepseek-harness-desktop/releases/download/' + RUNTIME_TAG + '/' + RUNTIME_ASSET,
  'https://gh-proxy.com/https://github.com/sjxbbdb/deepseek-harness-desktop/releases/download/' + RUNTIME_TAG + '/' + RUNTIME_ASSET,
  'https://ghproxy.net/https://github.com/sjxbbdb/deepseek-harness-desktop/releases/download/' + RUNTIME_TAG + '/' + RUNTIME_ASSET,
];
// 运行时完整性关键文件（相对 node_modules/；缺任一即触发自愈）
const CRITICAL_FILES = [
  '@deepseek-ai/dsh/lib/bin.js',
  '@deepseek-ai/dsh/package.json',
  '@deepseek-ai/dsh-web-app/package.json',
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/dsh-headless/package.json',
  '@deepseek-ai/dsh-web-frontend/package.json',
  '@deepseek-ai/cordis/package.json',
  '@deepseek-ai/cordis-plugin-loader/package.json',
  'commander/package.json',
  'js-yaml/package.json',
  'yaml/package.json',
  'express/package.json',
  'react/package.json',
  'react-dom/package.json',
  'ws/package.json',
  'node-pty/prebuilds/win32-x64/pty.node',
];

let mainWindow = null;
let tray = null;
let child = null;          // 我们托管启动的 dsh 子进程
let childExited = false;
let serviceUrl = null;
let settings = loadSettings();
dlog('settings:', JSON.stringify(settings));
let quitting = false;
let bootTimer = null;

/* ------------------------------------------------------------------ */
/* 设置文件（userData/settings.json）                                  */
/* ------------------------------------------------------------------ */
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const s = JSON.parse(raw);
    return {
      port: Number(s.port) || DEFAULT_PORT,
      dshPkg: typeof s.dshPkg === 'string' ? s.dshPkg : '',
      nodePath: typeof s.nodePath === 'string' ? s.nodePath : '',
      openAtLogin: !!s.openAtLogin,
      closeToTray: s.closeToTray !== false,
    };
  } catch {
    return { port: DEFAULT_PORT, dshPkg: '', nodePath: '', openAtLogin: false, closeToTray: true };
  }
}

function saveSettings() {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[dsh-desktop] 保存设置失败:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* dsh 可执行入口定位                                                  */
/* ------------------------------------------------------------------ */
function npmCacheRoots() {
  const roots = [];
  // 1) 环境变量
  if (process.env.NPM_CONFIG_CACHE) roots.push(process.env.NPM_CONFIG_CACHE);
  // 2) 用户 .npmrc 的 cache 配置
  const npmrc = path.join(process.env.USERPROFILE || '', '.npmrc');
  try {
    for (const line of fs.readFileSync(npmrc, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*cache\s*=\s*(.+?)\s*$/);
      if (m) roots.push(m[1].trim().replace(/^"(.*)"$/, '$1'));
    }
  } catch { /* ignore */ }
  // 3) npm 默认位置
  roots.push(path.join(process.env.LOCALAPPDATA || '', 'npm-cache'));
  return [...new Set(roots)];
}

function runtimeRoot() {
  // 运行时依赖根目录（内置优先，自愈下载的次之）
  return path.join(app.getPath('userData'), 'runtime');
}

function findDshBin() {
  const candidates = [];
  if (settings.dshPkg) candidates.push(path.join(settings.dshPkg, 'lib', 'bin.js'));
  if (process.env.DSH_PKG) candidates.push(path.join(process.env.DSH_PKG, 'lib', 'bin.js'));
  candidates.push(path.join(__dirname, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  candidates.push(path.join(runtimeRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));

  // npx 缓存：<npm-cache>/_npx/*/node_modules/@deepseek-ai/dsh/lib/bin.js
  for (const root of npmCacheRoots()) {
    try {
      const npxRoot = path.join(root, '_npx');
      if (fs.existsSync(npxRoot)) {
        for (const dir of fs.readdirSync(npxRoot)) {
          const p = path.join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
          if (fs.existsSync(p)) candidates.push(p);
        }
      }
    } catch { /* ignore */ }
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 运行时自愈：缺依赖时自动从 Release 下载 dsh-runtime.zip           */
/* ------------------------------------------------------------------ */
function checkRuntimeIntegrity() {
  // 返回缺失的关键文件（相对当前可用 runtime 根）；完全无 runtime 时返回标志
  const roots = [__dirname, runtimeRoot()];
  let root = null;
  for (const r of roots) {
    if (fs.existsSync(path.join(r, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) { root = r; break; }
  }
  if (!root) return ['<dsh-runtime-missing>'];
  return CRITICAL_FILES.filter((f) => !fs.existsSync(path.join(root, 'node_modules', f)));
}

function runtimeUrls() {
  const urls = [];
  if (settings.runtimeUrl && typeof settings.runtimeUrl === 'string') urls.push(settings.runtimeUrl);
  return urls.concat(RUNTIME_MIRRORS);
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const attempt = (u, redirectsLeft) => {
      let req;
      try {
        req = https.get(u, { headers: { 'User-Agent': 'dsh-desktop' } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            res.resume();
            if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
            let loc = res.headers.location;
            try { loc = new URL(loc, u).href; } catch { /* keep raw */ }
            return attempt(loc, redirectsLeft - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error('HTTP ' + res.statusCode));
          }
          const total = Number(res.headers['content-length']) || 0;
          let received = 0;
          const out = fs.createWriteStream(dest);
          res.on('data', (chunk) => {
            received += chunk.length;
            if (onProgress) onProgress(received, total);
          });
          res.pipe(out);
          out.on('finish', () => { out.close(() => resolve()); });
          res.on('error', (e) => { out.destroy(); reject(e); });
          out.on('error', (e) => { out.destroy(); reject(e); });
        });
      } catch (e) { return reject(e); }
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('download timeout')));
    };
    attempt(url, 5);
  });
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', zipPath, '-C', destDir], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d) => { err += d; });
    tar.on('error', (e) => reject(e));
    tar.on('exit', (code) => {
      if (code === 0) return resolve();
      // 回退：PowerShell Expand-Archive
      const ps = spawn('powershell', ['-NoProfile', '-Command',
        "Expand-Archive -LiteralPath '" + zipPath + "' -DestinationPath '" + destDir + "' -Force"], { stdio: ['ignore', 'ignore', 'ignore'] });
      ps.on('error', (e) => reject(new Error('tar & ps failed: ' + (err || e.message))));
      ps.on('exit', (code2) => (code2 === 0 ? resolve() : reject(new Error('extract failed: ' + (err || '').slice(0, 300)))));
    });
  });
}

async function ensureDshRuntime(onProgress) {
  const destDir = runtimeRoot();
  const zipPath = path.join(destDir, 'dsh-runtime.zip');
  try { fs.mkdirSync(destDir, { recursive: true }); } catch (e) {
    dlog('runtime dir create failed:', e.message);
    return false;
  }
  for (const url of runtimeUrls()) {
    try {
      dlog('runtime download:', url);
      await downloadFile(url, zipPath, (received, total) => {
        if (onProgress && total > 0) {
          onProgress(Math.min(99, Math.round((received / total) * 100)));
        }
      });
      const st = fs.statSync(zipPath);
      if (st.size < 30 * 1024 * 1024) throw new Error('runtime package too small: ' + st.size);
      await extractZip(zipPath, destDir);
      fs.rmSync(zipPath, { force: true });
      dlog('runtime installed, integrity now:', checkRuntimeIntegrity().length === 0 ? 'OK' : 'issues remain');
      return checkRuntimeIntegrity().length === 0;
    } catch (e) {
      dlog('runtime fetch failed:', url, '-', e.message);
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
    }
  }
  return false;
}

function findNode() {
  // 打包后：用 electron.exe 以纯 Node 模式运行（无需外部 node）
  if (app.isPackaged) {
    return { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  if (settings.nodePath && fs.existsSync(settings.nodePath)) return { file: settings.nodePath, env: {} };
  if (process.env.DSH_NODE && fs.existsSync(process.env.DSH_NODE)) return { file: process.env.DSH_NODE, env: {} };
  return { file: 'node', env: {} }; // 交给 PATH
}

/* ------------------------------------------------------------------ */
/* dsh 服务健康检查                                                    */
/* ------------------------------------------------------------------ */
function probeService(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      // 响应已开始：取消空闲超时（chunked 响应间隙会误触发 timeout），用总超时兜底
      req.setTimeout(0);
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { res.destroy(); done(body.includes(READY_MARKER) ? 'dsh' : 'other'); });
      res.on('error', () => { res.destroy(); done(null); });
    });
    const total = setTimeout(() => { req.destroy(); done(null); }, timeoutMs + 2000);
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.on('close', () => clearTimeout(total));
  });
}

/* 在当前端口找可用的 dsh 服务：先看配置端口，再看备用端口 */
async function findExistingService() {
  for (let port = settings.port; port < settings.port + 20; port++) {
    const kind = await probeService(port);
    if (kind === 'dsh') return port;
    if (kind === 'other') break; // 端口被别的程序占用，不再继续
  }
  return null;
}

async function startDshService(onStatus) {
  const existing = await findExistingService();
  dlog('findExistingService ->', existing);
  if (existing !== null) {
    serviceUrl = 'http://127.0.0.1:' + existing;
    onStatus('ready', { url: serviceUrl, managed: false, port: existing });
    return;
  }

  // 找可用端口（从配置端口开始，跳过被占用/非 dsh 的）
  let port = settings.port;
  for (let i = 0; i < 20; i++) {
    const kind = await probeService(port, 800);
    if (kind === null) break; // 空闲
    if (kind === 'other') { port++; continue; }
    // kind === 'dsh' 已在上面的 findExistingService 处理过，理论到不了这里
  }

  // 依赖完整性自检：缺依赖自动下载修复（dsh-runtime.zip）
  const issues = checkRuntimeIntegrity();
  if (issues.length > 0) {
    dlog('runtime integrity issues:', issues.join(', '));
    publishStatus({ state: 'downloading', progress: 0, message: '检测到运行依赖缺失，正在自动下载 Harness 运行时…' });
    const ok = await ensureDshRuntime((p) => {
      publishStatus({ state: 'downloading', progress: p, message: '正在下载 Harness 运行时 ' + p + '%' });
    });
    dlog('ensureDshRuntime ->', ok);
  }

  const dshBin = findDshBin();
  dlog('findDshBin ->', dshBin);
  if (!dshBin) {
    onStatus('error', { message: '未找到 dsh 运行时代码，且自动下载失败。请检查网络连接后点击重试。' });
    return;
  }

  const nodeCmd = findNode();
  onStatus('starting', { port });
  dlog('spawn:', nodeCmd.file, dshBin, '--port', port);
  console.log('[main] spawn:', nodeCmd.file, dshBin, '--port', port, 'cwd:', app.getPath('userData'));

  child = spawn(nodeCmd.file, [dshBin, 'web', '--port', String(port)], {
    cwd: app.getPath('userData'),
    env: { ...process.env, ...nodeCmd.env },
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let bootLog = '';
  child.on('error', (err) => console.error('[main] child spawn error:', err));
  child.stdout.on('data', (d) => { bootLog += d; if (process.argv.includes('--console')) process.stdout.write('[dsh] ' + d); });
  child.stderr.on('data', (d) => { bootLog += d; if (process.argv.includes('--console')) process.stderr.write('[dsh] ' + d); });

  child.on('exit', (code, signal) => {
    childExited = true;
    child = null;
    if (!quitting) {
      notify('dsh 服务已停止', '服务进程退出 (code=' + code + ', signal=' + signal + ')。可点击托盘菜单「重启服务」。');
      if (mainWindow && !mainWindow.isDestroyed() && serviceUrl) {
        showBootPage({ state: 'stopped', message: '服务已停止，点击下方按钮重启。' });
      }
    }
  });

  const deadline = Date.now() + BOOT_POLL_TIMEOUT;
  await new Promise((resolve) => {
    const poll = async () => {
      const kind = await probeService(port, 800);
      if (kind === 'dsh') {
        dlog('poll ready on port', port);
        serviceUrl = 'http://127.0.0.1:' + port;
        onStatus('ready', { url: serviceUrl, managed: true, port });
        resolve();
        return;
      }
      if (childExited) {
        dlog('poll childExited');
        onStatus('error', { message: 'dsh 服务启动失败，请查看控制台日志。\n\n' + bootLog.slice(-800) });
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        onStatus('error', { message: '等待 dsh 服务就绪超时（' + BOOT_POLL_TIMEOUT / 1000 + 's）。' });
        resolve();
        return;
      }
      setTimeout(poll, BOOT_POLL_INTERVAL);
    };
    poll();
  });
}

function stopDshService() {
  if (child && !childExited) {
    childExited = true; // 避免 exit 回调再触发通知
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
function showBootPage(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.loadFile(path.join(__dirname, 'boot.html'), { query: { state: JSON.stringify(payload || { state: 'starting' }) } });
}

async function openMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    icon: path.join(__dirname, 'icons', 'icon.png'),
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('close', (e) => {
    if (settings.closeToTray && !quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部链接一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || url.startsWith(serviceUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  ipcMain.removeHandler('desktop:action');
  ipcMain.handle('desktop:action', async (_evt, action) => {
    if (action === 'retry') {
      await startDshService(publishStatus);
      if (serviceUrl && mainWindow) mainWindow.loadURL(serviceUrl);
    }
    if (action === 'quit') {
      quitting = true;
      app.quit();
    }
    return true;
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  showBootPage({ state: 'starting' });
  await startDshService(publishStatus);
  if (serviceUrl && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(serviceUrl);
  }
}

function publishStatus(stateOrPayload, extra) {
  // 兼容 onStatus('ready', {...}) 与 publishStatus({state:'ready',...}) 两种调用
  const payload = typeof stateOrPayload === 'string'
    ? Object.assign({ state: stateOrPayload }, extra || {})
    : stateOrPayload;
  dlog('publishStatus:', payload.state, payload.port || '');
  try {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('desktop:status', payload); } catch { /* ignore */ }
  }
  if (payload.state === 'ready') {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(payload.url);
  }
  if (payload.state === 'error' && mainWindow && !mainWindow.isDestroyed()) {
    showBootPage({ state: 'error', message: payload.message });
  }
  if (payload.state === 'stopped') showBootPage(payload);
  if (payload.state === 'ready' && payload.managed) {
    notify('dsh 服务已就绪', APP_NAME + ' 服务已启动：' + payload.url);
  }
  } catch (err) {
    dlog('publishStatus ERROR:', err.message);
  }
}

/* ------------------------------------------------------------------ */
/* 托盘                                                                */
/* ------------------------------------------------------------------ */
function createTray() {
  const iconPath = path.join(__dirname, 'icons', 'tray.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip(APP_NAME);
  tray.on('click', () => toggleWindow());
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: '显示 / 隐藏窗口', click: () => toggleWindow() },
    { label: '在浏览器中打开', click: () => { if (serviceUrl) shell.openExternal(serviceUrl); } },
    { type: 'separator' },
    { label: '重启服务', click: () => restartService() },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: settings.openAtLogin,
      click: (item) => {
        settings.openAtLogin = item.checked;
        app.setLoginItemSettings({ openAtLogin: item.checked });
        saveSettings();
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

async function restartService() {
  stopDshService();
  serviceUrl = null;
  showBootPage({ state: 'starting', message: '正在重启 dsh 服务…' });
  await startDshService(publishStatus);
  if (serviceUrl && mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(serviceUrl);
}

/* ------------------------------------------------------------------ */
/* 通知                                                                */
/* ------------------------------------------------------------------ */
function notify(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body }).show();
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 应用生命周期                                                        */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(async () => {
    if (process.platform !== 'win32') {
      app.setAppUserModelId('com.dsh.desktop');
    }
    createTray();
    await openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
      else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    stopDshService();
  });

  app.on('window-all-closed', (e) => {
    // 托盘常驻：不自动退出（macOS 之外也一样）
  });
}
