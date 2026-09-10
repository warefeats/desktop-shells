# Launches each shell the way the harness does and reports what happened. Interactive session only.
$root = Resolve-Path "$PSScriptRoot\.."
Remove-Item "$root\results\debug-*" -ErrorAction SilentlyContinue
$env:BENCH_MODE = "gate"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9333"
foreach ($c in @(
  @{ id = "tauri"; exe = "$root\hosts\tauri\target\release\desktop-shells-tauri.exe" },
  @{ id = "electron"; exe = "$root\hosts\electron\out\win-unpacked\desktop-shells-electron.exe" })) {
  $env:BENCH_OUT = "$root\results\debug-$($c.id).json"
  $p = Start-Process -FilePath $c.exe -PassThru -RedirectStandardOutput "$root\results\debug-$($c.id)-out.log" -RedirectStandardError "$root\results\debug-$($c.id)-err.log"
  Write-Output "=== $($c.id) pid $($p.Id)"
  Start-Sleep -Seconds 12
  $alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  Write-Output ("alive: " + [bool]$alive + " title: '" + $alive.MainWindowTitle + "'")
  if ($c.id -eq "tauri") {
    try { (Invoke-RestMethod http://127.0.0.1:9333/json) | ForEach-Object { Write-Output ("page: " + $_.type + " " + $_.url + " title='" + $_.title + "'") } } catch { Write-Output "cdp: $_" }
  }
  Write-Output "--- out"; Get-Content "$root\results\debug-$($c.id)-out.log" -ErrorAction SilentlyContinue
  Write-Output "--- err"; Get-Content "$root\results\debug-$($c.id)-err.log" -ErrorAction SilentlyContinue | Select-Object -First 10
  Write-Output "--- report"; Get-Content "$root\results\debug-$($c.id).json" -ErrorAction SilentlyContinue
  if ($alive) { Stop-Process -Id $p.Id -Force }
  Start-Sleep -Seconds 2
}
