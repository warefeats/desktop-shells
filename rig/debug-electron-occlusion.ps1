# Electron only, with Chromium's native window occlusion tracking disabled. Interactive session only.
$root = Resolve-Path "$PSScriptRoot\.."
Remove-Item "$root\results\debug-occl*" -ErrorAction SilentlyContinue
$env:BENCH_MODE = "gate"; $env:BENCH_DEBUG = "1"; $env:BENCH_OUT = "$root\results\debug-occl.json"
$exe = "$root\hosts\electron\out\win-unpacked\desktop-shells-electron.exe"
$p = Start-Process -FilePath $exe -ArgumentList "--disable-features=CalculateNativeWinOcclusion" -PassThru -RedirectStandardOutput "$root\results\debug-occl-out.log" -RedirectStandardError "$root\results\debug-occl-err.log"
Start-Sleep -Seconds 25
$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
Write-Output ("alive: " + [bool]$alive)
Write-Output "--- out"; Get-Content "$root\results\debug-occl-out.log" -ErrorAction SilentlyContinue
Write-Output "--- err"; Get-Content "$root\results\debug-occl-err.log" -ErrorAction SilentlyContinue | Select-Object -First 15
Write-Output "--- report"; Get-Content "$root\results\debug-occl.json" -ErrorAction SilentlyContinue
if ($alive) { Stop-Process -Id $p.Id -Force }
