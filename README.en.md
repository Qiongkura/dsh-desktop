# DeepSeek Harness Desktop

<div align="center">

[中文](README.md) | **English**

</div>

An Electron shell that packages the DeepSeek Harness Web GUI into a native desktop window:

- **Self-contained distribution**: The installer includes a complete DSH backend runtime (`resources/runtime`, approximately 250MB production closure). Any Windows x64 user can download, install, and **double-click to run** without installing Node.js / pnpm / cloning the DSH repository;
- Automatic detection of `http://127.0.0.1:3080`: If the GUI is already running, it directly takes over (avoids restarting the backend);
- Otherwise, it launches the built-in backend (built-in node.exe + `@deepseek-ai/dsh`'s `lib/bin.js`), then opens the window when ready;
- Clicking the × prompts a DeepSeek Harness-style query: **Hide to System Tray** or **Exit Directly**. After hiding, the application and backend continue running in the background, the taskbar icon disappears, and clicking/right-clicking the system tray icon restores or exits;
- Supports single instance (re-launching while hidden restores the window), opening external links in the system browser, and menu bar shortcuts;
- **Custom wallpaper**: Menu "File → Set Wallpaper…" selects an image, and the interface panel becomes a frosted glass effect; also supports `--wallpaper=<image path>` / `DSH_WALLPAPER` / config option `wallpaper`;
- Built-in mode isolates DSH_HOME to the application data directory (`%APPDATA%\DeepSeek Harness Desktop\home`), without interfering with existing installations;
- Can be packaged as a green single-file exe (portable) or an unpack-and-use ZIP package.

## How It Works

```
┌───────────────────────────────┐
│  DeepSeek Harness Desktop     │  (Electron)
│  ┌───────────┐   ┌─────────┐  │
│  │ Main       │──▶│ Detect  │── Found → Take over (external service)
│  │ Process    │   │ 3080    │  │
│  │ main.js    │   └─────────┘  │
│  │           │                │
│  │           │   ┌─────────┐  │
│  │           │──▶│ Built-in│── Built-in node.exe + lib/bin.js web
│  │           │   │ Backend │    (resources/runtime, pnpm deploy closure)
│  │           │   └─────────┘  └── Native window loads GUI
│  └─────┬─────┘
└────────┼──────────────────────────┘
  External mode: DSH_ROOT / --dsh-root specifies repository (G:\deepseek-harness or other)
```

## Directory Structure

| Path | Description |
| --- | --- |
| `main.js` | Electron main process: configuration parsing, backend process management, window, tray, and close dialog |
| `close-dialog/` | Close confirmation dialog (DSH-style frameless window): `index.html` + `preload.js` (button results sent back to main process) |
| `scripts/render-icon.cjs` | Uses Electron to render the GUI official favicon (`apps/web/public/favicon.svg`, default black without fill) into a 512px icon base image (light rounded square + black official logo) |
| `build/build-icons.ps1` | Generates `build/icon.png` (512) and `build/icon.ico` (16~256 multi-size) from the base image |
| `scripts/build-dist.ps1` | One-click build: render icon → deploy built-in runtime → repair closure → electron-builder |
| `.toolchain/repair-staging.mjs` | Iteratively supplements missing workspace packages from pnpm deploy until the built-in runtime can start |
| `build/node.exe` | Built-in Node runtime packaged during build (copied from local `node`), backend prioritizes it for startup |
| `.npmrc` | Uses npmmirror mirror (registry / electron / electron-builder-binaries) |

> Note: `scripts/*.ps1`, `build/*.ps1` must remain pure ASCII (comments in English) — non-ASCII bytes will corrupt scripts under GBK decoding (tested to swallow line breaks and cause variable assignment failures).

## Development Run

```powershell
npm install     # Install electron + electron-builder (via npmmirror mirror)
npm start       # Launch desktop app directly in development mode
```

## Packaging exe

Self-contained distribution (recommended, output approximately 300~400MB, includes complete backend):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-dist.ps1
```

Build machine requirements: Node.js + pnpm, DSH repository checkout (`G:\deepseek-harness`, can be overridden with `DSH_SOURCE_ROOT`), network (npmmirror). Process:

1. `pnpm deploy` produces `@deepseek-ai/dsh`'s production closure (no symlinks, runtime dependencies only);
2. `repair-staging.mjs` iteratively supplements missing workspace packages from deploy and tests startup;
3. electron-builder packages the closure with built-in node.exe into `resources/runtime`.

> Build environment notes (tested locally):
> - The local process token lacks `SeCreateSymbolicLinkPrivilege`, causing electron-builder to fail when extracting winCodeSign due to two macOS symlinks. `build-dist.ps1` temporarily installs a 7za wrapper (compiled from `.toolchain\7za-wrapper.cs`) to suppress this error, automatically restoring after build.
> - When electron-builder downloads electron-builder-binaries, `npm run` forces injection of `.npmrc` mirror addresses, so the build script calls electron-builder directly and starts a local mirror server (`.toolchain\mirror-server.js`, serving original packages) to ensure checksum consistency.

## Configuration

Priority: Environment variables > Command-line arguments > Configuration file > Defaults.

| Configuration | Environment Variable | Command-line Argument | Default |
| --- | --- | --- | --- |
| DSH repository root directory | `DSH_ROOT` | `--dsh-root=<path>` | `G:\deepseek-harness` |
| Backend port | `DSH_PORT` | `--port=<n>` | `3080` |
| Do not start backend | — | `--no-server` | Take over existing service |
| Disable tray and close dialog | — | `--no-tray` | Click × to exit directly (legacy behavior) |
| Automated verification | — | `--smoke-test` | Print `SMOKE_OK` on successful load and exit |

Configuration file is located at `%APPDATA%\DeepSeek Harness Desktop\config.json` (automatically written after first successful launch), logs at `%APPDATA%\DeepSeek Harness Desktop\logs\`.

## Tray and Close Behavior

- Clicking the main window × (or Alt+F4) prompts a DSH-style close confirmation dialog: `Cancel` / `Exit Directly` / `Hide to Tray` (default, triggered by Enter; Esc cancels). After selecting hide, the window is only hidden, not destroyed, and the backend service continues running;
- First hide displays a system tray bubble notification; subsequently, you can restore the window by clicking the tray icon, or right-click the menu to execute `Show Main Window` / `Hide Main Window` / `Open in Browser` / `Exit`;
- Application menu "File → Hide to Tray" is equivalent to hiding in the close dialog; "File → Exit" performs a true exit, terminating the backend process;
- Re-launching the app while hidden (or clicking shortcut) directly restores the main window (single instance);
- The close confirmation dialog is an independent frameless window (`close-dialog/`, distributed with installer), dark theme consistent with GUI;
- Passing `--no-tray` completely disables this feature, restoring the legacy "click × to exit" behavior (automatically disabled in smoke tests).

## Smoke Test

```powershell
npm run smoke   # Launch → wait for page load complete → print SMOKE_OK/SMOKE_FAIL and exit
```

## Relationship with Official Project

This project is built on [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

DeepSeek Harness's core capabilities, plugin system, and Web UI come from the official project. This project is mainly responsible for:

- Desktop application packaging
- Local service lifecycle management
- Desktop window and system tray integration
- Windows installer build and release
- Interface adaptation for desktop environment

If you wish to run Harness via command line or participate in core feature development, please refer to the official repository first.

## Known Limitations

- The built-in runtime does not include `pnpm`, so plugin installation/management features in the GUI are unavailable (browsing and viewing are unaffected);
- The built-in runtime is based on the DSH repository version at build time, requiring repackaging to follow upstream updates;
- `--host 0.0.0.0` is prohibited by DSH officially (security design), desktop app fixed to use `127.0.0.1`;
- If the port is occupied by another program, it will take over directly, please confirm that the port indeed runs DSH GUI.
