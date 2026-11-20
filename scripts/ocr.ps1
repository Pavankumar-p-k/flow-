# ocr.ps1 - local OCR of a PNG via Windows.Media.Ocr (WinRT, no downloads).
# Prints one JSON line: {"text":"...","lang":"en-US"} or {"error":"..."}.
param([string]$Img)

$ErrorActionPreference = "Stop"
# WinRT projection types (System.WindowsRuntimeSystemExtensions) live here
Add-Type -AssemblyName System.Runtime.WindowsRuntime
# OCR text may be non-ASCII - force UTF-8 stdout so JSON never garbles.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

if (-not (Test-Path $Img)) { Write-Output ('{"error":"missing input"}'); exit 1 }

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT IAsyncOperation -> .NET Task await helper (PS 5.1 has no await).
# NOTE: single quotes - a backtick inside "..." is an escape char and would
# turn 'IAsyncOperation`1' into 'IAsyncOperation1' (no match -> null array).
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq "AsTask" -and $_.IsGenericMethod -and
  $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function AwaitOp($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait() | Out-Null
  return $t.Result
}

try {
  $file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Img).Path)) ([Windows.Storage.StorageFile])
  $stream = AwaitOp ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = AwaitOp ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = AwaitOp ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { Write-Output ('{"error":"no OCR language installed"}'); exit 1 }

  $res = AwaitOp ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $out = @{ text = $res.Text; lang = $engine.RecognizerLanguage.DisplayName } | ConvertTo-Json -Compress
  Write-Output $out
} catch {
  $msg = $_.Exception.Message -replace '"', "'"
  if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
  Write-Output ('{"error":"' + $msg + '"}')
  exit 1
}
