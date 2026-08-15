# One-shot build of DeepSeek Harness Desktop (NSIS installer + portable exe).
# Handles two quirks of this build machine:
#   1) process token lacks SeCreateSymbolicLinkPrivilege -> winCodeSign 7z
#      extraction fails on two mac symlinks -> install a 7za wrapper that
#      swallows that specific failure (archive checksum stays untouched);
#   2) electron-builder downloads electron-builder-binaries -> run a local
#      mirror server serving the original archives so checksums match.
# Also re-renders the app icon (official DSH favicon mark) before building.
# NOTE: keep this file pure ASCII - non-ASCII bytes corrupt under GBK decoding.
$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$toolchain = Join-Path $root '.toolchain'
$mirrorPort = 18765
$sevenZipDir = Join-Path $root 'node_modules\7zip-bin\win\x64'
$mirrorBase = "http://127.0.0.1:$mirrorPort/"

function Test-SymlinkPrivilege {
  return (whoami /priv | Select-String 'SeCreateSymbolicLinkPrivilege') -ne $null
}

function Install-7zaWrapper {
  if (-not (Test-Path (Join-Path $sevenZipDir '7za.real.exe'))) {
    Move-Item (Join-Path $sevenZipDir '7za.exe') (Join-Path $sevenZipDir '7za.real.exe') -Force
  }
  $wrapperExe = Join-Path $toolchain '7za-wrapper.exe'
  if (-not (Test-Path $wrapperExe)) {
    $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path $csc)) { throw 'csc.exe not found' }
    & $csc /nologo /out:$wrapperExe /codepage:65001 (Join-Path $toolchain '7za-wrapper.cs')
    if ($LASTEXITCODE -ne 0) { throw '7za wrapper compile failed' }
  }
  Copy-Item $wrapperExe (Join-Path $sevenZipDir '7za.exe') -Force
  Write-Host '[build] 7za wrapper installed (symlink privilege missing)'
}

function Restore-7za {
  $real = Join-Path $sevenZipDir '7za.real.exe'
  if (Test-Path $real) {
    Copy-Item $real (Join-Path $sevenZipDir '7za.exe') -Force
    Write-Host '[build] 7za restored'
  }
}

function Ensure-Archive([string]$name, [string]$sub) {
  $file = Join-Path $toolchain $name
  if (-not (Test-Path $file)) {
    Write-Host "[build] downloading $name ..."
    curl.exe -sL -o $file "https://npmmirror.com/mirrors/electron-builder-binaries/$sub/$name"
  }
  return $file
}

function Start-MirrorServer {
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port $mirrorPort -WarningAction SilentlyContinue
  if ($probe.TcpTestSucceeded) {
    Write-Host "[build] mirror already running on $mirrorPort"
    return $null
  }
  Ensure-Archive 'winCodeSign-2.6.0.7z' 'winCodeSign-2.6.0'
  Ensure-Archive 'nsis-3.0.4.1.7z' 'nsis-3.0.4.1'
  Ensure-Archive 'nsis-resources-3.4.1.7z' 'nsis-resources-3.4.1'
  $p = Start-Process node -ArgumentList @((Join-Path $toolchain 'mirror-server.js'), $toolchain, $mirrorPort) -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 1
  Write-Host "[build] mirror server started (pid $($p.Id))"
  return $p
}

function Stop-MirrorServer($proc) {
  if ($null -ne $proc -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    Write-Host '[build] mirror server stopped'
  }
}

function Render-Icons {
  $basePng = Join-Path $root 'build\icon-base-512.png'
  Write-Host '[build] rendering icon ...'
  Push-Location $root
  try {
    node node_modules/electron/cli.js scripts/render-icon.cjs $basePng
    if ($LASTEXITCODE -ne 0) { throw 'icon render failed' }
  } finally {
    Pop-Location
  }
  & (Join-Path $root 'build\build-icons.ps1')
}

function Stage-Runtime {
  # 1) pnpm deploy: production-only, symlink-free closure of @deepseek-ai/dsh
  $sourceRoot = $env:DSH_SOURCE_ROOT
  if (-not $sourceRoot) { $sourceRoot = 'G:\deepseek-harness' }
  $staging = Join-Path $toolchain 'runtime-staging'
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  Write-Host "[build] deploying runtime closure from $sourceRoot ..."
  Push-Location $sourceRoot
  try {
    pnpm --filter @deepseek-ai/dsh deploy --legacy --prod `
      --config.node-linker=hoisted --config.auto-install-peers=false `
      --config.link-workspace-packages=true $staging
    if ($LASTEXITCODE -ne 0) { throw "pnpm deploy failed (exit $LASTEXITCODE)" }
  } finally {
    Pop-Location
  }
  # 2) repair: copy workspace packages pnpm deploy dropped, until the closure boots
  Write-Host '[build] repairing runtime closure ...'
  node (Join-Path $toolchain 'repair-staging.mjs') $staging $sourceRoot 3099
  if ($LASTEXITCODE -ne 0) { throw 'runtime closure repair failed' }
  # 3) stage into the project for electron-builder extraResources
  $runtimeDir = Join-Path $root 'runtime'
  if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
  Write-Host '[build] copying runtime into project ...'
  Copy-Item $staging $runtimeDir -Recurse -Force
  $sizeMB = [math]::Round(((Get-ChildItem $runtimeDir -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB)
  Write-Host "[build] runtime staged: $runtimeDir ($sizeMB MB)"
}

# ---- main ----
$wrapperInstalled = $false
$serverProc = $null
try {
  Render-Icons
  Stage-Runtime
  if (-not (Test-SymlinkPrivilege)) {
    Install-7zaWrapper
    $wrapperInstalled = $true
  }
  $serverProc = Start-MirrorServer
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = $mirrorBase
  $env:NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR = $mirrorBase
  $env:npm_config_electron_builder_binaries_mirror = $mirrorBase

  Push-Location $root
  try {
    if (Test-Path (Join-Path $root 'release')) {
      Remove-Item (Join-Path $root 'release') -Recurse -Force
    }
    node node_modules/electron-builder/cli.js --win
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed (exit $LASTEXITCODE)" }
    Write-Host '[build] done:'
    Get-ChildItem (Join-Path $root 'release') -Filter *.exe | ForEach-Object { Write-Host "  $($_.FullName)" }
  } finally {
    Pop-Location
  }
} finally {
  if ($wrapperInstalled) { Restore-7za }
  Stop-MirrorServer $serverProc
}
