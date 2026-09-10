# Builds the frontend and both shells on the rig. Run from the repo root over ssh; no desktop needed.
$ErrorActionPreference = "Stop"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location $PSScriptRoot\..
bun run frontend/build.ts
Push-Location hosts\tauri
cargo tauri build
Pop-Location
Push-Location hosts\electron
bun install --frozen-lockfile
bunx electron-builder --win nsis
Pop-Location
Write-Host "build done"
