# register-watchdog.ps1 - (re)creates the AgentNotchWatchdog crash-watchdog
# task: every 1 minute, relaunch the Electron app if it is not running.
#
# The action MUST be wrapped in `conhost --headless`. Windows 11 uses Windows
# Terminal as the default console host, so a plain `powershell.exe -File ...`
# action opens (and closes) a visible terminal window on EVERY run - the user
# saw a terminal flash every minute. conhost --headless runs the same command
# with no window at all (verified: no OpenConsole/WindowsTerminal process).
#
# Battery: schtasks defaults DisallowStartIfOnBatteries and
# StopIfGoingOnBatteries to true, which silently disables the watchdog on a
# laptop running unplugged - observed live: LastRunTime stuck at 07:29 with
# NumberOfMissedRuns=434 and the notch dead for hours. Patch both to false,
# and set StartWhenAvailable so runs missed during sleep fire on wake.
#
# Idempotent: /F overwrites the existing task with the same schedule.
$ErrorActionPreference = "Stop"
$tr = "C:\Windows\System32\conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Users\peter\agent-notch\scripts\watchdog.ps1"
schtasks /Create /TN "AgentNotchWatchdog" /TR $tr /SC MINUTE /MO 1 /F | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Output "register failed (exit $LASTEXITCODE)"; exit 1 }

$settings = (Get-ScheduledTask -TaskName "AgentNotchWatchdog").Settings
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$settings.StartWhenAvailable = $true
Set-ScheduledTask -TaskName "AgentNotchWatchdog" -Settings $settings | Out-Null
Write-Output "AgentNotchWatchdog registered: headless, every 1 minute, battery-ok, catch-up on wake"
