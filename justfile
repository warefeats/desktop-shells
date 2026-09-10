set dotenv-load

rig := env_var_or_default("RIG", "rig-windows")
rig_dir := env_var_or_default("RIG_DIR", "C:/bench/desktop-shells")

check:
    bun run check

test:
    bun test

# The one frontend bundle both shells embed. Rebuild the shells after this: Tauri compiles it in.
frontend:
    bun run frontend/build.ts

# Default builds of both shells, unsigned: Tauri via cargo tauri build, Electron via electron-builder.
build: frontend
    cd hosts/tauri && cargo tauri build
    cd hosts/electron && bun install --frozen-lockfile && ./node_modules/.bin/electron-builder

# Conformance gate only: both hosts must return identical digests.
gate:
    bun run src/run.ts --gate-only

# Short protocol, every phase, for checking the harness. Never importable.
smoke *ARGS:
    bun run src/run.ts --smoke {{ARGS}}

# Full protocol. --only=cold,warm,ipc,parity,soak,size narrows; --resume continues a checkpointed results.json.
bench *ARGS:
    bun run src/run.ts {{ARGS}}

# results.json -> runs/<date>-<rig>.json and register it in benchmark.json.
import LABEL RESULTS="results.json":
    bun run src/import.ts --results={{RESULTS}} --label="{{LABEL}}"

# Rig: push the repo to the Windows box (builds happen there), run in the interactive session, pull results back.
rig-push:
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp -t ds-push.XXXXXX.tgz)
    git ls-files -z | tar czf "$tmp" --null -T -
    ssh {{rig}} "New-Item -ItemType Directory -Force -Path '{{rig_dir}}' | Out-Null"
    scp -q "$tmp" {{rig}}:{{rig_dir}}/push.tgz
    ssh {{rig}} "Set-Location '{{rig_dir}}'; tar -xzf push.tgz; Remove-Item push.tgz"
    rm -f "$tmp"
    ssh {{rig}} "Set-Location '{{rig_dir}}'; bun install --frozen-lockfile"

rig-build:
    ssh {{rig}} "Set-Location '{{rig_dir}}'; powershell -NoProfile -ExecutionPolicy Bypass -File rig/build.ps1"

# Runs in the logged-on desktop session via a scheduled task (ADR 0004); ssh itself is session 0.
rig-smoke *ARGS:
    ssh {{rig}} "Set-Location '{{rig_dir}}'; powershell -NoProfile -ExecutionPolicy Bypass -File rig/run-interactive.ps1 -Args '--smoke {{ARGS}}'"

rig-bench *ARGS:
    ssh {{rig}} "Set-Location '{{rig_dir}}'; powershell -NoProfile -ExecutionPolicy Bypass -File rig/run-interactive.ps1 -Args '{{ARGS}}'"

rig-pull:
    scp {{rig}}:{{rig_dir}}/results.json ./results.json
