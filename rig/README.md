# Windows rig

The rig is reached over ssh, which lands in session 0 with no desktop. Desktop shells need a window, so `run-interactive.ps1` registers a scheduled task that runs the harness in the logged-on user's interactive session and waits for it (ADR 0004). This requires the rig to be logged on with the desktop unlocked for the duration of a run; autologon is the operator's choice and is not scripted here.

`build.ps1` builds the frontend and both shells on the rig itself; nothing is cross-compiled. It needs Rust stable, the Tauri CLI, WebView2 (Windows 11 ships it), bun, and NSIS, which `cargo tauri build` downloads on first use.

Cold starts on Windows need a way to drop the file cache. The harness calls Sysinternals `RAMMap64.exe -Ew` if it is on PATH and records the run as not cold if it is not.
