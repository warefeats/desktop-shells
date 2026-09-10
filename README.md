# desktop-shells

The runner behind the warefeats desktop shell benchmark: Tauri vs Electron. One byte-identical web frontend embedded in both shells, measured on an Apple M2 Max and a Windows 11 Ryzen box. Four sections: IPC across the boundary, webview parity, lifecycle, size.

Glossary in `CONTEXT.md`, decisions in `docs/adr/`. Results publish as `runs/*.json` merged into `benchmark.json`, which the site pins by commit.
