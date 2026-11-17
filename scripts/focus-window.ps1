param([string]$Title = "")

$ErrorActionPreference = 'SilentlyContinue'
if (-not $Title) { exit 1 }

# AppActivate matches a substring of the window title and brings it forward.
$ws = New-Object -ComObject WScript.Shell
$ok = $ws.AppActivate($Title)
if (-not $ok) {
  # Fall back: partial match against all visible windows.
  $proc = Get-Process | Where-Object { $_.MainWindowTitle -like "*$Title*" } | Select-Object -First 1
  if ($proc) { $ok = $ws.AppActivate($proc.Id) }
}
if ($ok) { exit 0 } else { exit 1 }
