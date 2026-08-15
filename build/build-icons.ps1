# Build icons from the 512x512 base rendered by scripts/render-icon.cjs:
#   build/icon.png  (512, used by electron-builder)
#   build/icon.ico  (multi-size 16/24/32/48/64/128/256, PNG-compressed entries)
# Usage: pwsh -File build/build-icons.ps1
# NOTE: keep this file pure ASCII - non-ASCII bytes corrupt under GBK decoding.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = $PSScriptRoot
$base = Join-Path $outDir 'icon-base-512.png'
if (-not (Test-Path $base)) {
  throw "missing $base - first run: npx electron scripts/render-icon.cjs $base"
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)

function Resize-Png([string]$src, [int]$size, [string]$dest) {
  $srcImg = [System.Drawing.Image]::FromFile($src)
  $bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($srcImg, 0, 0, $size, $size)
  $g.Dispose()
  $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $srcImg.Dispose()
}

# 1) icon.png - resized to 512
Resize-Png $base 512 (Join-Path $outDir 'icon.png')

# 2) multi-size ICO (PNG-in-ICO, Vista+)
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-icon-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmpDir | Out-Null
try {
  $pngFiles = @()
  foreach ($s in $sizes) {
    $f = Join-Path $tmpDir "icon-$s.png"
    Resize-Png $base $s $f
    $pngFiles += $f
  }

  $icoPath = Join-Path $outDir 'icon.ico'
  $ms = [System.IO.MemoryStream]::new()
  $bw = [System.IO.BinaryWriter]::new($ms)
  $count = $sizes.Count
  # ICO header
  $bw.Write([uint16]0)          # reserved
  $bw.Write([uint16]1)          # type = icon
  $bw.Write([uint16]$count)     # entry count

  $offsets = @()
  $offset = 6 + 16 * $count
  $blobs = @()
  foreach ($i in 0..($count - 1)) {
    $blob = [System.IO.File]::ReadAllBytes($pngFiles[$i])
    $blobs += , $blob
    $offsets += $offset
    $offset += $blob.Length
  }
  for ($i = 0; $i -lt $count; $i++) {
    $s = $sizes[$i]
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # width
    $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))  # height
    $bw.Write([byte]0)                                        # color count
    $bw.Write([byte]0)                                        # reserved
    $bw.Write([uint16]1)                                      # planes
    $bw.Write([uint16]32)                                     # bpp
    $bw.Write([uint32]$blobs[$i].Length)                      # size
    $bw.Write([uint32]$offsets[$i])                           # offset
  }
  foreach ($blob in $blobs) { $bw.Write($blob) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
  $bw.Dispose()
  $ms.Dispose()
  Write-Host "icons written: $icoPath (sizes $($sizes -join '/'))"
} finally {
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
