param([string]$Action = "playpause")

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeMedia {
  [DllImport("user32.dll")]
  private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  private static void Tap(byte vk) {
    keybd_event(vk, 0, 0, UIntPtr.Zero);
    keybd_event(vk, 0, 2, UIntPtr.Zero);
  }
  public static void PlayPause() { Tap(0xB3); }
  public static void Next()     { Tap(0xB0); }
  public static void Prev()     { Tap(0xB1); }
  public static void Stop()     { Tap(0xB2); }
}
"@

switch ($Action) {
  "playpause" { [NativeMedia]::PlayPause() }
  "next"      { [NativeMedia]::Next() }
  "prev"      { [NativeMedia]::Prev() }
  "stop"      { [NativeMedia]::Stop() }
}
