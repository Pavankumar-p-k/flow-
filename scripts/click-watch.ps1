# Click-to-skip watcher: the intro overlay is click-through (so it never
# blocks the mouse), which means its own renderer can never see a click.
# This tiny poller watches the left button and drops a flag file the moment
# it is pressed; main.js picks the flag up and skips the intro.
param([string]$FlagPath)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class NotchClickWatch {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
}
'@

while ($true) {
  if (([NotchClickWatch]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0) {
    try { Set-Content -Path $FlagPath -Value ((Get-Date).ToString("o")) -ErrorAction Stop } catch {}
    break
  }
  Start-Sleep -Milliseconds 33
}
