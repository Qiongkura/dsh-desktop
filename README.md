# DeepSeek Harness Desktop（DSH 桌面端）

把 DeepSeek Harness 的 Web GUI 装进原生桌面窗口的 Electron 壳：

- **自包含发行版**：安装包内置完整的 DSH 后端运行时（`resources/runtime`，约
  250MB 生产闭包），任何 Windows x64 用户下载安装后**双击即用**，无需安装
  Node.js / pnpm / 拉取 DSH 仓库；
- 自动探测 `http://127.0.0.1:3080`：GUI 已在运行就直接接管（不重复启动后端）；
- 否则启动内置后端（内置 node.exe + `@deepseek-ai/dsh` 的 `lib/bin.js`），就绪后打开窗口；
- 点 × 会弹出 DeepSeek Harness 风格的询问：**隐藏到系统托盘** 或 **直接退出**；隐藏后应用与
  后端继续在后台运行，任务栏图标消失，单击/右键系统托盘图标即可恢复或退出；
- 支持单实例（托盘隐藏时再次启动会恢复窗口）、系统浏览器打开外链、菜单栏快捷操作；
- **自定义壁纸**：菜单「文件 → 设置壁纸…」选择图片，界面面板变为毛玻璃效果；
  也支持 `--wallpaper=<图片路径>` / `DSH_WALLPAPER` / 配置项 `wallpaper`；
- 内置模式把 DSH_HOME 隔离到应用数据目录（`%APPDATA%\DeepSeek Harness Desktop\home`），不干扰本机已有安装；
- 可打包为绿色单文件 exe（portable）或解压即用的 ZIP 包。

## 工作原理

```
┌───────────────────────────────┐
│  DeepSeek Harness Desktop     │  (Electron)
│  ┌───────────┐   ┌─────────┐  │
│  │ 主进程     │──▶│ 探测 3080│── 有 → 接管（外部服务）
│  │ main.js   │   └─────────┘  │
│  │           │                │
│  │           │   ┌─────────┐  │
│  │           │──▶│ 内置后端  │── 内置 node.exe + lib/bin.js web
│  │           │   │ runtime │    （resources/runtime，pnpm deploy 闭包）
│  │           │   └─────────┘  └── 原生窗口加载 GUI
│  └─────┬─────┘
└────────┼──────────────────────────┘
  外部模式：DSH_ROOT / --dsh-root 指定仓库（G:\deepseek-harness 或其它）


## 目录结构

| 路径 | 说明 |
| --- | --- |
| `main.js` | Electron 主进程：配置解析、后端进程管理、窗口、托盘与关闭询问 |
| `close-dialog/` | 关闭确认对话框（DSH 风格无边框窗口）：`index.html` + `preload.js`（按钮结果回传主进程） |
| `scripts/render-icon.cjs` | 用 Electron 把 GUI 官方 favicon（`apps/web/public/favicon.svg`，无 fill 默认黑色）渲染成 512px 图标底图（浅色圆角方块 + 黑色官方标） |
| `build/build-icons.ps1` | 由底图生成 `build/icon.png`（512）与 `build/icon.ico`（16~256 多尺寸） |
| `scripts/build-dist.ps1` | 一键构建：渲染图标 → 部署内置运行时 → 修复闭包 → electron-builder |
| `.toolchain/repair-staging.mjs` | 迭代补齐 pnpm deploy 漏掉的工作区包，直到内置运行时能启动 |
| `build/node.exe` | 打包时内置的 Node 运行时（从本机 `node` 复制），后端优先用它启动 |
| `.npmrc` | 使用 npmmirror 镜像（registry / electron / electron-builder-binaries） |

> 注意：`scripts/*.ps1`、`build/*.ps1` 必须保持纯 ASCII（注释用英文）——非 ASCII
> 字节在 GBK 解码下会损坏脚本（实测会吞掉换行、导致变量赋值失效）。

## 开发运行

```powershell
npm install     # 安装 electron + electron-builder（走 npmmirror 镜像）
npm start       # 直接以开发模式启动桌面端
```

## 打包 exe

自包含发行版（推荐，产物约 300~400MB，内置完整后端）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-dist.ps1
```

构建机要求：Node.js + pnpm、DSH 仓库 checkout（`G:\deepseek-harness`，可用
`DSH_SOURCE_ROOT` 覆盖）、网络（npmmirror）。流程：

1. `pnpm deploy` 产出 `@deepseek-ai/dsh` 的生产闭包（无符号链接、仅运行时依赖）；
2. `repair-staging.mjs` 迭代补齐 deploy 漏掉的工作区包并实测启动；
3. electron-builder 将闭包与内置 node.exe 一起打进 `resources/runtime`。

> 构建环境注意事项（本机实测）：
> - 本机进程 token 没有 `SeCreateSymbolicLinkPrivilege`，electron-builder 解压
>   winCodeSign 时因两个 mac 符号链接失败。`build-dist.ps1` 会临时安装一个
>   7za 包装器（`.toolchain\7za-wrapper.cs` 编译而来）吞掉该错误，构建完自动还原。
> - electron-builder 下载 electron-builder-binaries 时，`npm run` 会强制注入
>   `.npmrc` 的镜像地址，因此构建脚本直接调用 electron-builder，并起本地镜像
>   服务器（`.toolchain\mirror-server.js`，原包直供）保证校验和一致。

## 配置

优先级：环境变量 > 命令行参数 > 配置文件 > 默认值。

| 配置 | 环境变量 | 命令行参数 | 默认值 |
| --- | --- | --- | --- |
| DSH 仓库根目录 | `DSH_ROOT` | `--dsh-root=<路径>` | `G:\deepseek-harness` |
| 后端端口 | `DSH_PORT` | `--port=<n>` | `3080` |
| 不拉起后端 | — | `--no-server` | 接管已有服务 |
| 禁用托盘与关闭询问 | — | `--no-tray` | 点 × 直接退出（旧行为） |
| 自动化验证 | — | `--smoke-test` | 加载成功打印 `SMOKE_OK` 并退出 |

配置文件位于 `%APPDATA%\DeepSeek Harness Desktop\config.json`（首次成功启动后自动写入），日志在 `%APPDATA%\DeepSeek Harness Desktop\logs\`。

## 托盘与关闭行为

- 点主窗口 ×（或 Alt+F4）弹出 DSH 风格的关闭确认框：`取消` / `直接退出` / `隐藏到托盘`（默认，
  回车触发；Esc 取消）。选择隐藏后窗口仅隐藏不销毁，后端服务继续运行；
- 首次隐藏会弹出系统托盘气泡提示；之后可从托盘图标单击恢复窗口、右键菜单执行
  `显示主窗口` / `隐藏主窗口` / `在浏览器中打开` / `退出`；
- 应用菜单「文件 → 隐藏到托盘」等效于关闭询问中的隐藏；「文件 → 退出」为真正退出，
  会回收后端进程；
- 托盘隐藏状态下再次启动应用（或点击快捷方式）会直接恢复主窗口（单实例）；
- 关闭确认框为独立无边框窗口（`close-dialog/`，随安装包分发），暗色主题与 GUI 一致；
- 传 `--no-tray` 可完全禁用该特性，恢复「点 × 即退出」的旧行为（冒烟测试自动禁用）。

## 冒烟测试

```powershell
npm run smoke   # 启动 → 等待页面加载完成 → 打印 SMOKE_OK/SMOKE_FAIL 并退出
```

## 与官方项目的关系

本项目基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。

DeepSeek Harness 的核心能力、插件系统和 Web UI 来自官方项目。本项目主要负责：

- 桌面应用封装
- 本地服务生命周期管理
- 桌面窗口和系统托盘集成
- Windows 安装包构建与发布
- 桌面环境下的界面适配

如果你希望通过命令行运行 Harness，或者参与核心功能开发，请优先查看官方仓库。

## 已知限制

- 内置运行时不含 `pnpm`，GUI 里的插件安装/管理功能不可用（浏览、查看不受影响）；
- 内置运行时基于构建当时的 DSH 仓库版本，需重新打包才能跟随上游更新；
- `--host 0.0.0.0` 被 DSH 官方禁止（安全性设计），桌面端固定使用 `127.0.0.1`；
- 端口被其他程序占用时会直接接管，请确认该端口上确实是 DSH GUI。
