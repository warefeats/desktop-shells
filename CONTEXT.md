# desktop-shells

The runner behind the desktop shell benchmark: one byte-identical web frontend embedded in a Tauri host and an Electron host, measured on two rigs, one per operating system. Shared catalog terms live in the site repo's glossary; only shell-specific language is defined here.

## Language

**Shell**:
The native program that hosts the frontend in a webview and answers its commands. Tauri and Electron are shells; the frontend is not.
_Avoid_: framework, wrapper, runtime, app

**Candidate**:
One pinned shell release: `tauri` at its exact crate and CLI version, or `electron` at its exact npm version. Never "Tauri" or "Electron" alone.
_Avoid_: shell (as a candidate name), platform

**Frontend**:
The single vanilla TypeScript bundle both shells load, identical to the byte across shells and rigs, carrying every test and the seeded payload generator.
_Avoid_: renderer, UI, web app, client

**Host**:
The shell-specific program behind the webview that implements the command surface: Rust for the Tauri candidate, TypeScript on Node for the Electron candidate.
_Avoid_: backend, main process, core

**Webview**:
The browser engine a shell draws the frontend with: WKWebView on macOS and WebView2 on Windows for the Tauri candidate, the bundled Chromium for the Electron candidate. Its version is recorded per run because it can change under a Tauri candidate without a rebuild.
_Avoid_: browser, engine, renderer

**Command surface**:
The fixed set of named commands and events every host implements identically, which the frontend drives.
_Avoid_: API, bridge, protocol (reserved for the catalog's meaning)

**Conformance gate**:
The precondition, run before any measured pass, that every host answers every command on the command surface with byte-identical results for the same seeded input. A failed gate invalidates the run.
_Avoid_: parity check, contract test, smoke

**Boundary**:
The crossing between the frontend and the host, in either direction. Every IPC test measures a crossing of the boundary.
_Avoid_: bridge, IPC layer, channel

**Idiomatic path**:
The way each shell's own documentation says to move data across the boundary: a Tauri command with JSON arguments and return, and an Electron invoke over the context bridge. Verdict ratios are taken on this path.
_Avoid_: default path, normal path, JSON path

**Raw path**:
The bytes-oriented way each shell offers for large payloads: Tauri's raw response and channels, Electron's ArrayBuffer transfer over invoke and MessagePort.
_Avoid_: binary path, fast path, optimized path

**Round trip**:
One request from the frontend across the boundary and its response back, timed on the frontend's clock.
_Avoid_: call, invocation, request

**Push**:
Host-to-frontend events emitted at a fixed requested rate without a request, reported as delivered rate and inter-arrival gap.
_Avoid_: stream, broadcast, subscription

**Payload**:
The bytes moved in one crossing, generated from a seeded generator so both hosts receive the same bytes, sized by row count for the idiomatic path and by byte count for the raw path.
_Avoid_: message, data, body

**Row**:
The fixed record shape the idiomatic path serializes: one id, three floats, one 32-character string, one nested object.
_Avoid_: record, item, object

**Parity test**:
One of three frame-time tests the frontend runs identically in every webview: the table, the particles, and the raster.
_Avoid_: rendering test, stress test, workload

**Table**:
The parity test that scrolls a 100,000-row virtualized table by script.
_Avoid_: DOM test, list

**Particles**:
The parity test that animates a fixed count of particles on a Canvas 2D context.
_Avoid_: canvas test

**Raster**:
The parity test that renders a fragment shader over a fixed-resolution WebGL2 surface.
_Avoid_: shader test, WebGL test

**Frame time**:
The interval between consecutive animation frames reported by the webview, vsync-capped, with the rig's display refresh recorded so the tail is read against it.
_Avoid_: fps, frame rate

**Jank**:
A frame whose frame time exceeds one and a half times the rig's refresh interval.
_Avoid_: dropped frame, stutter, hitch

**Cold start**:
The time from the harness spawning the shell's process, after the operating system's file cache has been purged of the shell's artifact, to the frontend's first-frame marker on the harness clock.
_Avoid_: launch time, boot, time to interactive

**Warm start**:
A cold start's definition without the purge, immediately after a prior start of the same candidate.
_Avoid_: hot start, relaunch

**First-frame marker**:
The line the frontend causes the host to print to standard output on its first animation frame, which ends a start measurement.
_Avoid_: ready signal, startup event

**Soak**:
A ten-minute scripted loop cycling the three parity tests for thirty seconds each with a one-megabyte round trip every five seconds, during which footprint is sampled every second.
_Avoid_: endurance test, long run, stress

**Footprint**:
The memory attributed to a candidate under the attribution rule: physical footprint of the responsible coalition on macOS, private working set of the process tree on Windows. Reported at soak start, soak end, and peak.
_Avoid_: RSS, memory usage, heap

**Attribution rule**:
The per-operating-system statement of which processes count toward a candidate's footprint and installed size, written into every run file.
_Avoid_: process model, accounting

**Installer**:
The distributable each shell's default build produces, measured in bytes as built, unsigned.
_Avoid_: artifact, bundle, package

**Installed size**:
The bytes on disk a candidate occupies after its installer has run and it has launched once, including any shared runtime the attribution rule assigns to it.
_Avoid_: disk usage, install footprint

**Interactive session**:
The logged-in desktop session on the Windows rig in which shells are launched, reached from ssh through a scheduled task because ssh itself lands in a session with no desktop.
_Avoid_: session 1, user session, GUI session
