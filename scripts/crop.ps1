# crop.ps1 - crop a PNG to a rectangle (region screenshot / OCR input).
# Print the output path on success, "ERR ..." on failure (exit 1).
param([string]$In, [int]$X = 0, [int]$Y = 0, [int]$W = 0, [int]$H = 0, [string]$Out)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $In)) { Write-Output "ERR missing input"; exit 1 }
if (-not $Out) { Write-Output "ERR missing output"; exit 1 }

$img = [System.Drawing.Image]::FromFile($In)
try {
  if ($W -le 0 -or $H -le 0) { $W = $img.Width; $H = $img.Height }
  $x = [Math]::Max(0, $X)
  $y = [Math]::Max(0, $Y)
  $w = [Math]::Min($W, $img.Width - $x)
  $h = [Math]::Min($H, $img.Height - $y)
  if ($w -lt 1 -or $h -lt 1) { Write-Output "ERR empty region"; exit 1 }

  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $src = New-Object System.Drawing.Rectangle $x, $y, $w, $h
  $dst = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $g.DrawImage($img, $dst, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output $Out
} finally {
  $img.Dispose()
}
