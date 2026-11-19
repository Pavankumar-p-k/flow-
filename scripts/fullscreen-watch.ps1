# fullscreen-watch.ps1 - reports foreground full-screen state as JSON lines.
#
# Full-screen = the foreground window covers an entire monitor AND has no
# caption bar (maximized windows keep WS_CAPTION, games/F11 video do not).
# Prints one JSON line per check (heartbeat ~1.2s; main.js dedupes):
#   {"on":true,"app":"chrome"}  /  {"on":false,"app":""}
#
# -SelfTest runs the classifier against synthetic rects and exits.
# ASCII only (PS 5.1 parser breaks on non-ASCII in .ps1).
param([switch]$SelfTest)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FSW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Test-Cover($r, $screens) {
  # within 2px slack: DPI rounding must not defeat the check
  foreach ($s in $screens) {
    if ($r.Left -le ($s.Left + 2) -and $r.Top -le ($s.Top + 2) -and
        $r.Right -ge ($s.Right - 2) -and $r.Bottom -ge ($s.Bottom - 2)) { return $true }
  }
  return $false
}

# style bit checks + coverage together = "is this a true full-screen app"
function Test-Fullscreen($style, $r, $screens) {
  $caption = ($style -band 0x00C00000) -ne 0   # WS_CAPTION
  if ($caption) { return $false }
  return (Test-Cover $r $screens)
}

if ($SelfTest) {
  $fails = 0
  $screen = @{ Left = 0; Top = 0; Right = 1920; Bottom = 1080 }
  $screens = @($screen)
  $cases = @(
    @{ n = "borderless covering screen = full"; s = 0x00000000; r = @{ Left = 0; Top = 0; Right = 1920; Bottom = 1080 }; want = $true },
    @{ n = "caption covering screen (maximized) = not"; s = 0x00C00000; r = @{ Left = 0; Top = 0; Right = 1920; Bottom = 1080 }; want = $false },
    @{ n = "borderless windowed = not"; s = 0x00000000; r = @{ Left = 100; Top = 100; Right = 900; Bottom = 700 }; want = $false },
    @{ n = "borderless but not reaching edge = not"; s = 0; r = @{ Left = 0; Top = 0; Right = 1800; Bottom = 1080 }; want = $false },
    @{ n = "caption + smaller = not"; s = 0x00C00000; r = @{ Left = 0; Top = 0; Right = 800; Bottom = 600 }; want = $false }
  )
  foreach ($c in $cases) {
    $got = Test-Fullscreen ([int]$c.s) ([pscustomobject]$c.r) $screens
    if ($got -eq $c.want) { Write-Output ("SELFTEST PASS " + $c.n) }
    else { $fails++; Write-Output ("SELFTEST FAIL " + $c.n + " got=" + $got) }
  }
  if ($fails -gt 0) { exit 1 }
  exit 0
}

while ($true) {
  $on = $false
  $app = ""
  try {
    $h = [FSW]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $style = [FSW]::GetWindowLong($h, -16)   # GWL_STYLE
      $r = New-Object FSW+RECT
      if ([FSW]::GetWindowRect($h, [ref]$r)) {
        $screens = @()
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
          $screens += @{ Left = $s.Bounds.Left; Top = $s.Bounds.Top; Right = $s.Bounds.Right; Bottom = $s.Bounds.Bottom }
        }
        if (Test-Fullscreen $style $r $screens) {
          $on = $true
          [uint32]$wpid = 0
          [void][FSW]::GetWindowThreadProcessId($h, [ref]$wpid)
          try { $app = (Get-Process -Id $wpid -ErrorAction Stop).ProcessName } catch { $app = "" }
        }
      }
    }
  } catch {}
  $line = @{ on = $on; app = $app } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1200
}
