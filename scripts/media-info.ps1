Add-Type -AssemblyName System.Runtime.WindowsRuntime
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Await($op, $type) {
  $asTask = ([System.WindowsRuntimeSystemExtensions]).GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $netTask = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  [void]$netTask.Wait(5000)
  return $netTask.Result
}

while ($true) {
  $out = @{ active = $false }
  try {
    $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
    $mgr = Await ($mgrType.GetMethod('RequestAsync').Invoke($null, @())) $mgrType
    $s = $mgr.GetCurrentSession()
    if ($null -ne $s) {
      $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
      $props = Await ($s.GetType().GetMethod('TryGetMediaPropertiesAsync').Invoke($s, @())) $propsType
      $info = $s.GetPlaybackInfo()
      $posSec = 0.0
      $endSec = 0.0
      try { $tl = $s.GetTimelineProperties(); $posSec = [double]$tl.Position.TotalSeconds } catch {}
      try { if ($endSec -le 0) { $endSec = [double]$tl.EndTime.TotalSeconds } } catch {}
      $out = @{
        active   = $true
        title    = "$($props.Title)"
        artist   = "$($props.Artist)"
        status   = "$($info.PlaybackStatus)"
        app      = "$($s.SourceAppUserModelId)"
        position = $posSec
        duration = $endSec
      }
    }
  } catch {
    $out = @{ active = $false }
  }
  [Console]::Out.WriteLine((ConvertTo-Json $out -Compress))
  [Console]::Out.Flush()
  Start-Sleep -Seconds 2
}
