# desktop-shells

The runner behind the warefeats desktop shell benchmark: Tauri vs Electron. One byte-identical web frontend embedded in both shells, measured on an Apple M2 Max and a Windows 11 Ryzen box. Four sections: IPC across the boundary, webview parity, lifecycle, size.

Glossary in `CONTEXT.md`, decisions in `docs/adr/`. Results publish as `runs/*.json` merged into `benchmark.json`, which the site pins by commit.

`just import LABEL RESULTS` turns a results file into a run file in which every test says which statistic its value is (`statistic`) and every result carries one sample per measured pass (`samples`), so the site can recompute a mean, median, minimum or maximum and show the spread; `just enrich RUN RESULTS` adds those two fields to a run file published before they existed, from the same results file, and refuses if any value would change.
