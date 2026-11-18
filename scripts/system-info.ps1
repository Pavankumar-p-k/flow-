# Live system snapshot for the assistant: foreground window, visible windows,
# and per-browser tab counts (UI Automation walks the real tab strip).
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class SysWin {
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  private delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString();
  }
  public static int PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return unchecked((int)p); }
  public static IntPtr Foreground() { return GetForegroundWindow(); }
  public static List<IntPtr> Visible() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h) && Title(h).Length > 1) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

$lines = @()

# --- foreground window ---
$fh = [SysWin]::Foreground()
if ($fh -ne [IntPtr]::Zero) {
  $p = Get-Process -Id ([SysWin]::PidOf($fh)) -ErrorAction SilentlyContinue
  $pname = if ($p) { $p.ProcessName } else { "?" }
  $lines += "FOREGROUND: [$pname] " + [SysWin]::Title($fh)
}

# --- visible windows ---
$wins = [SysWin]::Visible()
$lines += "WINDOWS OPEN ($($wins.Count)):"
foreach ($h in $wins) {
  $p = Get-Process -Id ([SysWin]::PidOf($h)) -ErrorAction SilentlyContinue
  $pname = if ($p) { $p.ProcessName } else { "?" }
  $t = [SysWin]::Title($h)
  if ($t.Length -gt 90) { $t = $t.Substring(0, 90) + "..." }
  $lines += "  - [$pname] $t"
}

# --- browser tab counts via UI Automation ---
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $tabCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::TabItem)
  $browsers = @("chrome", "msedge", "firefox", "brave", "opera")
  foreach ($h in $wins) {
    $p = Get-Process -Id ([SysWin]::PidOf($h)) -ErrorAction SilentlyContinue
    if (-not $p -or $browsers -notcontains $p.ProcessName.ToLower()) { continue }
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      $tabs = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
      $t = [SysWin]::Title($h)
      if ($t.Length -gt 45) { $t = $t.Substring(0, 45) + "..." }
      $lines += "TABS [$($p.ProcessName)] '$t': $($tabs.Count)"
    } catch {
      $lines += "TABS [$($p.ProcessName)]: n/a"
    }
  }
} catch {
  $lines += "TABS: UI Automation unavailable"
}

$lines -join "`n"
