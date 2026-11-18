# Crash watchdog for agent-notch (#11): if the Electron app is not running,
# relaunch it. Registered as a scheduled task that runs every minute.
$ErrorActionPreference = 'SilentlyContinue'

# Respect an intentional stop: if the user quits via the tray and wants it
# quiet, they can touch notch.stop (delete it to let the watchdog resume).
$stopFile = "C:\Users\peter\agent-notch\notch.stop"
if (Test-Path $stopFile) { exit 0 }

$running = Get-Process electron -ErrorAction SilentlyContinue
if ($running) { exit 0 }

# Not running - relaunch. Log the rescue so it's visible in debug.log.
$stamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
$logLine = "$stamp WATCHDOG electron not running - relaunching"
try { Add-Content -Path "C:\Users\peter\agent-notch\debug.log" -Value $logLine } catch {}

Start-Process -FilePath "C:\Users\peter\agent-notch\node_modules\electron\dist\electron.exe" -ArgumentList "." -WorkingDirectory "C:\Users\peter\agent-notch"
