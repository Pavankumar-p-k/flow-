param([string]$Target = "screen", [string]$Title = "")

# Captures a fresh screenshot and prints the saved PNG path (single line).
#   -Target screen          -> whole (virtual) screen
#   -Target window          -> window currently in front
#   -Target window -Title X -> focus the window whose title contains X, capture it
#                              (falls back to the foreground window if not found)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class ShotWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindByTitle(string sub) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length > 1 && t.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$dir = "C:\Users\peter\OneDrive\Pictures\Screenshots"
if (-not (Test-Path $dir)) {
  $dir = Join-Path $env:USERPROFILE "Pictures\Screenshots"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
}
$name = "notch-" + (Get-Date -Format "yyyy-MM-dd-HHmmss") + ".png"
$path = Join-Path $dir $name

$rect = $null
$hwnd = [IntPtr]::Zero

if ($Target -eq "window") {
  if ($Title) { $hwnd = [ShotWin]::FindByTitle($Title) }
  if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [ShotWin]::GetForegroundWindow() }
  if ($hwnd -ne [IntPtr]::Zero) {
    [void][ShotWin]::ShowWindow($hwnd, 9)        # SW_RESTORE (undoes minimize)
    [void][ShotWin]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 450                # let it come forward & paint
    $r = New-Object ShotWin+RECT
    if ([ShotWin]::GetWindowRect($hwnd, [ref]$r)) { $rect = $r }
  }
}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen

if ($rect -and ($rect.Right - $rect.Left) -gt 40 -and ($rect.Bottom - $rect.Top) -gt 40 -and $rect.Left -gt -32000) {
  # clamp to the virtual screen so multi-monitor setups never go out of bounds
  $x = [Math]::Max($rect.Left, $vs.X)
  $y = [Math]::Max($rect.Top, $vs.Y)
  $w = [Math]::Min($rect.Right, $vs.X + $vs.Width) - $x
  $h = [Math]::Min($rect.Bottom, $vs.Y + $vs.Height) - $y
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
} else {
  $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size $vs.Width, $vs.Height))
}

$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $path
