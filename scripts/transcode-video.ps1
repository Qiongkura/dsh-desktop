# Transcode HEVC/H.265 video to H.264 (high bitrate, visually lossless)
# so the desktop app can use hardware decode (HEVC has no reliable hw decode).
# Usage: powershell -File transcode-video.ps1 -InputFile "C:\...\7月15日.mp4"
param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [string]$OutputFile = '',
  [int]$Crf = 17
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ff = Join-Path $root '.toolchain\ffmpeg\ffmpeg.exe'
if (-not (Test-Path $ff)) { throw "ffmpeg not found at $ff (run the ffmpeg download step first)" }
if (-not (Test-Path $InputFile)) { throw "input not found: $InputFile" }
if ($OutputFile -eq '') { $OutputFile = [IO.Path]::ChangeExtension($InputFile, '-H264.mp4') }
Write-Host "transcoding: $InputFile -> $OutputFile (crf $Crf, visually lossless)"
& $ff -y -i $InputFile -c:v libx264 -crf $Crf -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart $OutputFile
if ($LASTEXITCODE -ne 0) { throw "ffmpeg failed (exit $LASTEXITCODE)" }
$mb = [math]::Round((Get-Item $OutputFile).Length / 1MB, 1)
Write-Host "done: $OutputFile ($mb MB)"
