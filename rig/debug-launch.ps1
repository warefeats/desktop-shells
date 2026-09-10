# Launches the Tauri exe the way the harness does and reports what happened. Interactive session only.
$root = Resolve-Path "$PSScriptRoot\.."
$exe = "$root\hosts\tauri\target\release\desktop-shells-tauri.exe"
$env:BENCH_MODE = "gate"; $env:BENCH_OUT = "$root\results\debug-gate.json"
Remove-Item "$root\results\debug-*" -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput "$root\results\debug-out.log" -RedirectStandardError "$root\results\debug-err.log"
Write-Output "pid $($p.Id) session $((Get-Process -Id $p.Id).SessionId) mySession $((Get-Process -Id $PID).SessionId)"
Start-Sleep -Seconds 15
$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
Write-Output ("alive: " + [bool]$alive + " title: '" + $alive.MainWindowTitle + "' exit: " + $p.ExitCode)
Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $p.Id } | ForEach-Object { Write-Output ("child " + $_.Name + " " + $_.ProcessId) }
Write-Output "--- out"; Get-Content "$root\results\debug-out.log" -ErrorAction SilentlyContinue
Write-Output "--- err"; Get-Content "$root\results\debug-err.log" -ErrorAction SilentlyContinue
Write-Output "--- report"; Get-Content "$root\results\debug-gate.json" -ErrorAction SilentlyContinue
if ($alive) { Stop-Process -Id $p.Id -Force }
