# Generate the app icon set from a single source PNG.
#
#   pwsh -File tools/make-icons.ps1 -Source "..\icon.png"
#
# Why a PowerShell script: it is the only image toolchain available on this box
# (no sharp / ImageMagick in the project). The generated PNGs are committed to
# public/, so this only needs to run when the source artwork changes.
#
# NOTE: keep this file ASCII-only. Windows PowerShell reads .ps1 files without a
# BOM as ANSI, which mangles non-ASCII literals in the script itself.
#
# What it does:
#   1. find the opaque bounding box (the source has a fully transparent margin)
#   2. crop to it
#   3. composite onto white at several fill ratios, centered, high-quality bicubic
#   4. write favicon.ico (PNG payloads), favicon-16/32/48, apple-touch-icon,
#      and the PWA icon sizes
#
# Compositing onto white (instead of keeping transparency) is deliberate:
# bicubic downscaling of a straight-alpha image blends RGB=0,0,0 from fully
# transparent pixels into the edges and produces dark fringes. Every surface in
# the app is white, so an opaque white background looks identical and avoids it.

param(
  [Parameter(Mandatory = $true)][string]$Source,
  # NOTE: do not default this to $PSScriptRoot-based path here -- Windows
  # PowerShell 5.1 has not set $PSScriptRoot yet while binding param defaults.
  [string]$OutDir = ''
)

Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrEmpty($OutDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $OutDir = Join-Path $scriptDir '..\public'
}

function New-IconBitmap {
  param(
    [System.Drawing.Bitmap]$Content,
    [int]$Size,
    [double]$FillRatio,
    [System.Drawing.Color]$Background
  )
  $out = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  try {
    $g.Clear($Background)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    # TileFlipXY avoids the edge-clamp smear when scaling down
    $ia = New-Object System.Drawing.Imaging.ImageAttributes
    $ia.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    try {
      $target = $Size * $FillRatio
      $scale = [Math]::Min($target / $Content.Width, $target / $Content.Height)
      $dw = [int][Math]::Round($Content.Width * $scale)
      $dh = [int][Math]::Round($Content.Height * $scale)
      $dx = [int][Math]::Round(($Size - $dw) / 2.0)
      $dy = [int][Math]::Round(($Size - $dh) / 2.0)
      $dest = New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)
      $g.DrawImage($Content, $dest, 0, 0, $Content.Width, $Content.Height, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    } finally {
      $ia.Dispose()
    }
  } finally {
    $g.Dispose()
  }
  return $out
}

function Save-Png {
  param([System.Drawing.Bitmap]$Bmp, [string]$Path)
  $Bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

# --- 1. load + find opaque bbox -------------------------------------------

$src = (Resolve-Path $Source).Path
$bmp = [System.Drawing.Bitmap]::FromFile($src)
Write-Host "source: $src  $($bmp.Width)x$($bmp.Height)  $($bmp.PixelFormat)"

$w = $bmp.Width
$h = $bmp.Height
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
$data = $bmp.LockBits(
  (New-Object System.Drawing.Rectangle(0, 0, $w, $h)),
  [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
  [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
)
try {
  $stride = $data.Stride
  $bytes = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $stride
    for ($x = 0; $x -lt $w; $x++) {
      $a = $bytes[$row + $x * 4 + 3]
      if ($a -gt 8) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
} finally {
  $bmp.UnlockBits($data)
}

if ($maxX -lt 0) { throw 'source image has no opaque pixels' }
$pad = 2
$minX = [Math]::Max(0, $minX - $pad); $minY = [Math]::Max(0, $minY - $pad)
$maxX = [Math]::Min($w - 1, $maxX + $pad); $maxY = [Math]::Min($h - 1, $maxY + $pad)
Write-Host "opaque bbox: x $minX..$maxX  y $minY..$maxY  ($($maxX-$minX+1)x$($maxY-$minY+1))"

$rect = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
$content = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bmp.Dispose()

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$white = [System.Drawing.Color]::FromArgb(255, 255, 255)

# size -> fill ratio
#  - favicon: push the artwork near the edge, 16/32px have no room for padding
#  - maskable: Android adaptive icons crop to the inner 80% circle, so the
#    artwork must stay well inside that (0.58 keeps it in the safe zone)
$jobs = @(
  @{ name = 'favicon-16.png';           size = 16;  fill = 0.96 },
  @{ name = 'favicon-32.png';           size = 32;  fill = 0.94 },
  @{ name = 'favicon-48.png';           size = 48;  fill = 0.92 },
  @{ name = 'logo-96.png';              size = 96;  fill = 0.94 },
  @{ name = 'apple-touch-icon.png';     size = 180; fill = 0.86 },
  @{ name = 'icon-192.png';             size = 192; fill = 0.84 },
  @{ name = 'icon-512.png';             size = 512; fill = 0.84 },
  @{ name = 'icon-maskable-512.png';    size = 512; fill = 0.58 }
)

$made = @()
foreach ($j in $jobs) {
  $b = New-IconBitmap -Content $content -Size $j.size -FillRatio $j.fill -Background $white
  try {
    $path = Join-Path $OutDir $j.name
    Save-Png -Bmp $b -Path $path
    $made += @{ name = $j.name; size = $j.size; bytes = (Get-Item $path).Length }
  } finally {
    $b.Dispose()
  }
}

# --- favicon.ico (PNG payloads; supported by every modern browser) ---------

$icoSizes = @(16, 32, 48)
$pngBytes = @()
foreach ($s in $icoSizes) {
  $b = New-IconBitmap -Content $content -Size $s -FillRatio 0.94 -Background $white
  try {
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes += , $ms.ToArray()
    $ms.Dispose()
  } finally {
    $b.Dispose()
  }
}

$icoPath = Join-Path $OutDir 'favicon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
try {
  $bw.Write([UInt16]0)                 # reserved
  $bw.Write([UInt16]1)                 # type = icon
  $bw.Write([UInt16]$icoSizes.Count)   # image count
  $offset = 6 + 16 * $icoSizes.Count
  for ($i = 0; $i -lt $icoSizes.Count; $i++) {
    $s = $icoSizes[$i]
    $len = $pngBytes[$i].Length
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))   # width
    $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))   # height
    $bw.Write([byte]0)                 # palette count
    $bw.Write([byte]0)                 # reserved
    $bw.Write([UInt16]1)               # planes
    $bw.Write([UInt16]32)              # bits per pixel
    $bw.Write([UInt32]$len)
    $bw.Write([UInt32]$offset)
    $offset += $len
  }
  foreach ($p in $pngBytes) { $bw.Write($p) }
} finally {
  $bw.Dispose()
  $fs.Dispose()
}

Write-Host ''
foreach ($m in $made) {
  Write-Host ('  {0,-24} {1,4}x{1,-4} {2,7} bytes' -f $m.name, $m.size, $m.bytes)
}
Write-Host ('  {0,-24} {1,4}        {2,7} bytes' -f 'favicon.ico', '16/32/48', (Get-Item $icoPath).Length)
$content.Dispose()
Write-Host ''
Write-Host 'done.'
