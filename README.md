# DeepSeek Harness 桌面端

基于 Electron 的 DeepSeek Harness 桌面客户端：把 Web 界面装进原生窗口，并自动托管 `dsh` 服务进程。

## 功能

- **原生窗口**内嵌 DSH Web 界面（默认 `http://127.0.0.1:3080`，可在设置文件中修改端口）
- **自动托管 dsh 服务**：启动应用时自动拉起 `dsh web` 服务；若端口上已有 dsh 服务则直接复用（例如你已经在浏览器里跑着一个）；退出应用时自动清理自己拉起的服务进程
- **运行时自愈**：启动时自动检查 dsh 运行依赖（17 个关键文件）是否完整；缺失或损坏时**自动从 GitHub Release 下载 `dsh-runtime.zip` 修复**（GitHub 直连 → gh-proxy 镜像自动切换，带进度显示），修复到应用数据目录 `%APPDATA%\DeepSeek Harness 桌面端\runtime`，无需管理员权限
- **托管恢复**：如果桌面端自己拉起的 dsh 子进程异常退出，会按退避策略自动重启几次，避免“一次崩溃就彻底挂掉”
- **系统托盘**：关闭窗口默认最小化到托盘；托盘菜单支持显示/隐藏、在浏览器中打开、重启服务、开机自启开关、退出
- **单实例**：重复启动只会聚焦已有窗口
- **启动状态页**：服务启动中 / 启动失败时显示状态与错误信息，可一键重试
- **服务崩溃通知**：托管的服务异常退出时发送系统通知
- **外部链接**：界面里的外链自动用系统浏览器打开

## 快速开始

```bat
start.bat
```

或：

```powershell
npm start
```

首次运行会自动 `npm install`。国内网络已配置 Electron 镜像（`.npmrc`）。

## 如何工作的

1. 主进程启动后先探测配置端口上是否已有 dsh 服务（`GET /` 响应含 `__DSH_BOOT__` 即认定为 dsh）。
2. 没有则自动定位 dsh 包（查找顺序：`settings.dshPkg` → 环境变量 `DSH_PKG` → 应用目录 `node_modules/@deepseek-ai/dsh` → npm/npx 缓存 `<cache>/_npx/*/node_modules/@deepseek-ai/dsh`，其中 npm cache 路径从 `.npmrc`/环境变量读取），用 `node <bin.js> web --port <port>` 拉起服务并轮询就绪。
3. 就绪后窗口加载服务地址；退出时杀掉自己拉起的子进程（复用的服务不会被误杀）。

## 配置

配置文件位于 Electron userData 目录：`%APPDATA%\DeepSeek Harness 桌面端\settings.json`：

```json
{
  "port": 3080,        // 服务端口；被占用时自动向后顺延寻找空闲端口
  "dshPkg": "",        // 可选：dsh 包目录（含 lib/bin.js），留空则自动探测
  "nodePath": "",      // 可选：node 可执行文件路径，留空则用 PATH 中的 node
  "openAtLogin": false,
  "closeToTray": true  // 关闭窗口时最小化到托盘
}
```

环境变量 `DSH_HOME` 会透传给托管的服务进程（默认 `%USERPROFILE%\.dsh`）。

## 调试

- `npm run start:console`（或 `electron . --console`）：把 dsh 服务输出转发到控制台
- 主进程运行日志：`%APPDATA%\DeepSeek Harness 桌面端\logs\main.log`，按 1MB 自动轮转
- 结构回归：`npm test`

## 打包（独立 exe）

已配置 electron-builder，产物在 `dist/` 目录：

| 文件 | 说明 |
|---|---|
| `DeepSeek Harness Setup 0.1.0.exe` | NSIS 安装包（推荐），可选安装目录、创建桌面快捷方式 |
| `DeepSeek Harness 0.1.0.exe` | 便携版：单文件免安装；首次启动需解压（约 3-5 分钟，受杀软扫描影响），之后秒开 |
| `win-unpacked/` | 绿色版目录：复制即可用 |

打包版特点：

- **自带 dsh 全部依赖**（约 500MB 运行时），目标机器无需 Node.js / npx / 网络
- 服务进程由打包版自带的 Electron 运行时以 Node 模式（`ELECTRON_RUN_AS_NODE`）托管，完全自包含
- 重新打包：`npx electron-builder --win`（首次需下载 NSIS 工具链，已配置国内镜像）

## 已知限制

- 若你通过其他方式（如 `npx dsh web`）手动启动了服务，桌面端会复用而非另起一个
- 打包版与源码版共享同一份 `%APPDATA%\DeepSeek Harness 桌面端` 配置与会话数据
