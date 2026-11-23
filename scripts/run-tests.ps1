# run-tests.ps1 — the whole test suite, one command.
#   - auto-discovers scripts\test-*.js
#   - EXCLUDES test-continue: it drives the REAL assistant and opens real
#     apps (no assertions, not part of the suite)
#   - a failing file is retried ONCE: 1st-pass ok = PASS · fails then passes
#     = FLAKE · fails twice = REAL-FAIL
#   - exits non-zero only when a file really fails (FLAKE still ran clean)
#   - tests share live state files (config, digest-state, ...) -> they run
#     STRICTLY SEQUENTIALLY, never in parallel
# usage:  powershell -File scripts\run-tests.ps1 [-Full]
#         -Full streams every test's output instead of status lines only

param([switch]$Full)

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$started = Get-Date

$files = Get-ChildItem -Path $here -Filter "test-*.js" |
  Where-Object { $_.Name -ne "test-continue.js" } |   # real-network app driver, see header
  Sort-Object Name

Write-Output ("== agent-notch suite: {0} files (test-continue excluded) ==" -f $files.Count)

$results = @()
foreach ($f in $files) {
  $firstTry = $true
  $status = "REAL-FAIL"
  $code = -1
  $out = $null
  $t0 = Get-Date
  while ($true) {
    if ($Full) { Write-Output ("---- {0} ----" -f $f.Name) }
    $out = & node (Join-Path $here $f.Name) 2>&1
    if ($Full) { $out | ForEach-Object { Write-Output ("  " + $_) } }
    $code = $LASTEXITCODE
    if ($code -eq 0) {
      $status = $(if ($firstTry) { "PASS" } else { "FLAKE" })
      break
    }
    if ($firstTry) { $firstTry = $false; continue }  # retry once
    break
  }
  $secs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
  $results += [pscustomobject]@{ Name = $f.BaseName; Status = $status; Secs = $secs; Code = $code }
  Write-Output ("{0,-9} {1}  ({2}s)" -f $status, $f.BaseName, $secs)
  if ($status -ne "PASS") {
    $tail = ($out | Select-Object -Last 6 | ForEach-Object { "    " + $_ }) -join "`n"
    Write-Output $tail
  }
}

$pass = @($results | Where-Object Status -eq "PASS").Count
$flake = @($results | Where-Object Status -eq "FLAKE").Count
$fail = @($results | Where-Object Status -eq "REAL-FAIL").Count
$total = [math]::Round(((Get-Date) - $started).TotalSeconds)
Write-Output ""
Write-Output ("== summary: {0} PASS / {1} FLAKE / {2} REAL-FAIL  ({3}s) ==" -f $pass, $flake, $fail, $total)
if ($fail) {
  Write-Output ("REAL-FAIL: " + (($results | Where-Object Status -eq "REAL-FAIL").Name -join ", "))
  exit 1
}
Write-Output $(if ($flake) { "SUITE OK (with flakes)" } else { "ALL PASS" })
exit 0
