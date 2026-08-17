# dsh-desktop

<div align="center">

[中文](README.md) | **English**

</div>

An Electron shell that packages the DeepSeek Harness Web GUI into a native desktop window with deep interface customization: wallpaper / frosted glass / liquid glass / splash screen / auto-transcoding, all configurable through the "Interface Settings" panel in Web settings.

- **Self-contained distribution**: The installer includes a complete DSH backend runtime (approximately 250MB production closure). Any Windows x64 user can download, install, and double-click to run without installing Node.js / pnpm / cloning the repository;
- **Interface Settings**: Wallpaper, video wallpaper, blur, transparent areas, input box/trace liquid glass, splash screen (mode/material/duration/fade), HEVC auto-transcoding... all configurable in one panel (title bar/tray "Interface Settings..." quick access, configuration persisted in Electron config);
- **Auto-detection and takeover**: Automatically detects `http://127.0.0.1:3080`: if GUI is already running, it directly takes over; otherwise, it launches the built-in backend;

## Features

| Feature | Description |
| --- | --- |
| Wallpaper Image/Video | Select image/video as interface background via title bar/tray "Interface Settings..." or Web settings (supports dynamic video wallpapers) |
| Wallpaper Blur | Independent slider (0-100px), real-time blur on wallpaper layer |
| Code Block Transparency | Independent slider (8%-100%), background color of code blocks in dialogs |
| Area Transparency Toggles | Four independent toggles for new conversation / input box / left sidebar / main interface |
| Sidebar Independent Wallpaper | Left sidebar can have a separate wallpaper (or share with main image) |
| Input Box Liquid Glass | Input area frosted glass (`backdrop-filter` + panel color gradient), independent blur slider (minimum 10px to ensure text blurs) |
| Panel Transparency | Independent slider (0-90%), panel semi-transparency strength |
| Trace Interface Glass | Shares the same glass code and slider as input box, intelligent transparency based on color saturation (preserves color bars/status labels) |
| Splash Screen | Three modes: default / follow theme / custom (image or video) |
| Animation Duration | 0-10 second slider; when video is selected, upper limit automatically equals video duration (ensures complete playback) |
| Fade-out Duration | 0-2 second slider, fade-out duration when splash screen ends |
| Click to Skip | Click anywhere during splash animation to skip (after main interface is ready) |
| HEVC Auto-transcoding | Automatically transcodes HEVC (H.265) videos to H.264 (CRF 17 visually lossless) for smooth hardware decoding |
| Video Wallpaper Protocol | `dsh-wallpaper://` privileged protocol, streams local videos (supports Range) |
| Video Sound | Optional playback of wallpaper video sound |
| Integrated Title Bar | Custom title bar: back/forward/menu/minimize/maximize/close |

## Architecture & Implementation

```
┌──────────────────────────────────────────────────┐
│  DeepSeek Harness Desktop (Electron)             │
│  ┌────────────────────────────────────────────┐  │
│  │ main.js Main Process                       │  │
│  │ · Config/Logs/Menu/Tray/Single Instance     │  │
│  │ · Backend detection & launch (attach or     │  │
│  │   built-in runtime)                        │  │
│  │ · dsh-wallpaper:// protocol (streaming)     │  │
│  │ · Wallpaper/Glass/Transparency CSS injection│  │
│  │ · Splash screen media parsing + preload     │  │
│  │ · HEVC detection + ffmpeg auto-transcode    │  │
│  │ · Settings dialog (wallpaper-dialog/)       │  │
│  └────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────┐  │
│  │ main-preload.js (before page scripts)      │  │
│  │ · Integrated title bar contextBridge       │  │
│  │ · Splash layer injection (video/image +    │  │
│  │   duration/fade/skip)                      │  │
│  │ · Splash mode exposed to page              │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
        │ attach / launch
        ▼
┌──────────────────────────────────────────────────┐
│ DSH Web GUI (http://127.0.0.1:3080)             │
│ · AppRoot loading gate (wallpaper mode doesn't   │
│   render HARNESS card)                           │
│ · Wallpaper/Glass/Transparency all controlled by │
│   CSS injected by main process                   │
└──────────────────────────────────────────────────┘
```

Key technical points:

- **Wallpaper layer**: `body::before/::after` (negative z-index, doesn't intercept input, no JS layer);
- **Liquid glass**: `::before` + `backdrop-filter` + panel color gradient, unified for image/video;
- **Splash layer**: Preload injects before page scripts execute (within 11ms of `documentElement` appearance), z-index maximum, fades out after main interface is ready + duration met;
- **Trace glass**: Intelligent transparency based on color saturation (JS polling), doesn't rely on volatile plugin class names;
- **Auto-transcoding**: Encoding detection + ffmpeg (CRF 17 visually lossless) + transcoded version priority;
- **Video duration detection**: ffmpeg `-i` parses `Duration`, drives animation duration slider upper limit.

## Directory Structure

| Path | Description |
| --- | --- |
| `main.js` | Electron main process: backend management, wallpaper/glass/transparency injection, splash screen, transcoding, settings dialog |
| `main-preload.js` | Main window preload: title bar capabilities + splash layer injection + mode exposure |
| `wallpaper-dialog/` | Interface settings dialog (frameless, draggable,置顶 on main window) |
| `titlebar/` | Integrated title bar injection (CSS/JS/preload) |
| `close-dialog/` | Close confirmation dialog (hide to tray / exit directly) |
| `scripts/build-dist.ps1` | One-click build: render icon → deploy built-in runtime → repair closure → electron-builder |
| `scripts/transcode-video.ps1` | Manual transcoding script (HEVC → H.264 CRF 17) |
| `scripts/update-release.ps1` | Upload build artifacts to GitHub Release |
| `.toolchain/` | Build toolchain (7za wrapper, mirror server, closure repair, ffmpeg) |

## 📦 Environment Dependencies

```bash
Node.js + pnpm (required for building)
DSH repository checkout (can override with `DSH_SOURCE_ROOT`)
Network (npmmirror mirror)
```

## Install & Usage

```powershell
npm install     # Install electron + electron-builder (via npmmirror mirror)
npm start       # Launch in development mode (attach local 3080 or launch backend per config)
```

Package exe:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-dist.ps1
```

Build machine requirements: Node.js + pnpm, DSH repository checkout (can override with `DSH_SOURCE_ROOT`), network (npmmirror). Output: portable exe + ZIP, approximately 300-400MB (includes complete backend + ffmpeg).

## Usage Example

```powershell
# Development mode launch
npm start

# Package executable
powershell -ExecutionPolicy Bypass -File scripts\build-dist.ps1

# Run smoke test
npm run smoke
```

## Configuration

Configuration file: `%APPDATA%\DeepSeek Harness Desktop\config.json`; logs in same directory `logs/`.

| Key | Description | Default |
| --- | --- | --- |
| `wallpaper` | Wallpaper image/video path | none |
| `sidebarWallpaper` | Sidebar independent wallpaper | share main image |
| `wallpaperBlur` | Wallpaper blur px | 18 |
| `wallpaperCodeAlpha` | Code block transparency | 0.45 |
| `transparentNewSession/Input/Sidebar/Main` | Area transparency toggles | true |
| `wallpaperVideoSound` | Video wallpaper sound | false |
| `glassBlur` | Input box/trace glass blur px | 10 |
| `panelAlpha` | Panel transparency | 0.55 |
| `splashMode` | Splash screen mode default/follow/custom | default |
| `splashFile` | Custom splash material | none |
| `splashDuration` | Animation duration (seconds) | 0 |
| `splashFade` | Fade-out duration (seconds) | 0.5 |

## Testing

```powershell
npm run smoke   # Launch → wait for page load complete → print SMOKE_OK/SMOKE_FAIL and exit
```

## Contributing

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/xxx`)
3. Commit your changes (`git commit -m 'feat: add xxx'`)
4. Push to the branch (`git push origin feature/xxx`)
5. Open a Pull Request

## License

This project uses the [MIT](LICENSE) license.

## Contact

- GitHub: https://github.com/Qiongkura
- WeChat: Qiongkura

## Known Limitations

- The built-in runtime does not include `pnpm`, so plugin installation/management features in the GUI are unavailable;
- The built-in runtime is based on the DSH repository version at build time, requiring repackaging to follow upstream updates;
- If the port is occupied by another program, it will take over directly, please confirm that the port indeed runs DSH GUI;
- HEVC transcoding takes several minutes first time (CRF 17 high bitrate), during which the original file is used (may stutter), automatically switches to transcoded version after completion.

## Related Projects

This project is built on [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), responsible for desktop packaging and interface customization; DSH core capabilities, plugin system, and Web UI come from the official project.
