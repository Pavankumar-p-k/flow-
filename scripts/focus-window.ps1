param([string]$Title = "")

$ErrorActionPreference = 'SilentlyContinue'
if (-not $Title) { exit 1 }

# Bring a window forward, even against Windows' foreground-lock (which
# silently denies SetForegroundWindow to a process that didn't get the last
# input event — that's why a plain AppActivate "succeeds" but nothing moves).
#   1. find the window: title substring -> process NAME match (mspaint -> Paint)
#   2. AttachThreadInput to the current foreground thread (unlocks focus)
#   3. tap ALT (also unlocks) + ShowWindow(restore) + SetForegroundWindow
# Retries ~5s so a just-launched app has time to open its window.

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FocWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static int PidOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return unchecked((int)p); }

  public static List<IntPtr> ByTitle(string sub) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        string t = Title(h);
        if (t.Length > 1 && t.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0) list.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> ByProcess(string name) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      if (IsWindowVisible(h)) {
        int pid = PidOf(h);
        try {
          var p = System.Diagnostics.Process.GetProcessById(pid);
          if (p.ProcessName.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 && Title(h).Length > 1) list.Add(h);
        } catch {}
      }
      return true;
    }, IntPtr.Zero);
    return list;
  }

  private delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);

  public static bool Activate(IntPtr h) {
    // unlock the foreground: attach our input queue to the current holder's
    ShowWindow(h, 9); // SW_RESTORE (also undoes minimize)
    IntPtr fg = GetForegroundWindow();
    uint fgTid; GetWindowThreadProcessId(fg, out fgTid);
    uint myTid = GetCurrentThreadId();
    bool attached = false;
    if (fgTid != 0 && fgTid != myTid) attached = AttachThreadInput(myTid, fgTid, true);
    // ALT tap tells Windows we're allowed to change focus
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    bool ok = SetForegroundWindow(h);
    if (attached) AttachThreadInput(myTid, fgTid, false);
    return ok;
  }
}
"@

for ($i = 0; $i -lt 10; $i++) {
  $hwnd = [IntPtr]::Zero

  # 1. window title contains $Title
  $byTitle = [FocWin]::ByTitle($Title)
  if ($byTitle.Count -gt 0) { $hwnd = $byTitle[0] }

  # 2. process name matches (mspaint -> "Paint", notepad -> "Untitled - Notepad")
  if ($hwnd -eq [IntPtr]::Zero) {
    $byProc = [FocWin]::ByProcess($Title)
    if ($byProc.Count -gt 0) { $hwnd = $byProc[0] }
  }

  if ($hwnd -ne [IntPtr]::Zero) {
    if ([FocWin]::Activate($hwnd)) {
      # confirm it really came forward before declaring success
      Start-Sleep -Milliseconds 150
      if ([FocWin]::GetForegroundWindow() -eq $hwnd) { exit 0 }
      # still denied — retry
    }
  }
  Start-Sleep -Milliseconds 500
}
exit 1
