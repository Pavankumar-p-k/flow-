# Notification mirror watcher (#2): polls UserNotificationListener and emits
# one JSON line per NEW Windows toast: {id, app, texts, created}
# Existing (history) notifications are marked seen on startup and not re-emitted.
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

$listener = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications.Management, ContentType=WindowsRuntime]::Current
$accessT = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus, Windows.UI.Notifications.Management, ContentType=WindowsRuntime]

function Request-Access {
  try { $null = Await ($listener.RequestAccessAsync()) $accessT } catch {}
}
Request-Access

$seen = @{}
$seenQ = New-Object System.Collections.Queue
$MAX_SEEN = 400
$first = $true
$failStreak = 0

while ($true) {
  try {
    $kindsT = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType=WindowsRuntime]
    $unT = [Windows.UI.Notifications.UserNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]
    $listT = ([System.Collections.Generic.IReadOnlyList``1]).MakeGenericType($unT)
    $op = $listener.GetNotificationsAsync($kindsT::Toast)
    $notes = Await $op $listT
    $failStreak = 0
    foreach ($n in $notes) {
      $id = "$($n.Id)"
      if ($seen.ContainsKey($id)) { continue }
      $seen[$id] = $true
      $seenQ.Enqueue($id)
      while ($seenQ.Count -gt $MAX_SEEN) { $seen.Remove($seenQ.Dequeue()) | Out-Null }
      if ($first) { continue }
      $texts = @()
      foreach ($b in $n.Notification.Visual.Bindings) {
        foreach ($e in $b.GetTextElements()) { if ($e.Text) { $texts += "$($e.Text)" } }
      }
      $created = 0
      try { $created = ([DateTimeOffset]$n.CreationTime).ToUnixTimeMilliseconds() } catch {}
      $out = @{ id = $id; app = "$($n.AppId)"; texts = $texts; created = $created }
      [Console]::Out.WriteLine((ConvertTo-Json $out -Compress))
      [Console]::Out.Flush()
    }
    $first = $false
  } catch {
    $failStreak++
    # access may have been revoked - re-request occasionally
    if ($failStreak % 20 -eq 1) { Request-Access }
  }
  Start-Sleep -Seconds 3
}
