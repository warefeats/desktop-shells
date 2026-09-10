# Runs the harness in the logged-on desktop session (ADR 0004). ssh lands in
# session 0 where no window can be shown; a scheduled task registered to run
# interactively as the logged-on user gets the real desktop and GPU. Blocks
# until the task finishes, then prints its log.
param([string]$Args = "--smoke")
$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
$root = Resolve-Path "$PSScriptRoot\.."
$log = Join-Path $root "results\interactive.log"
New-Item -ItemType Directory -Force -Path (Join-Path $root "results") | Out-Null
if (Test-Path $log) { Remove-Item $log }
$bun = (Get-Command bun).Source
$cmd = "Set-Location '$root'; & '$bun' run src/run.ts $Args *> '$log'"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$cmd`""
$user = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $user) { throw "no user is logged on to the desktop; autologon is required (ADR 0004)" }
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 6) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$name = "desktop-shells-bench"
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $name
Write-Host "started in session of $user; waiting"
do {
  Start-Sleep -Seconds 5
  $state = (Get-ScheduledTask -TaskName $name).State
} while ($state -eq "Running")
$info = Get-ScheduledTaskInfo -TaskName $name
Write-Host "task ended: $state, exit $($info.LastTaskResult)"
if (Test-Path $log) { Get-Content $log }
Unregister-ScheduledTask -TaskName $name -Confirm:$false
if ($info.LastTaskResult -ne 0) { exit 1 }
