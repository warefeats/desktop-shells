// Adds to a run file published before the samples contract what the importer now
// writes: each test's statistic and each result's per-pass samples, rebuilt from the
// results file the run was imported from. Every value must rebuild exactly as published;
// nothing else in the file changes, and benchmark.json is not touched.
import { readFileSync, writeFileSync } from "node:fs";
import { buildRun, checkSamples, type Raw, type RunTests } from "./import";

interface Published extends RunTests { id: string; label: string }

/** The run file's text with `statistic` and `samples` appended, or an error naming the first thing that does not match. */
export function enrich(text: string, r: Raw): string {
  if (JSON.stringify(JSON.parse(text), null, 2) + "\n" !== text) throw new Error("the run file is not the importer's two-space JSON; refusing to rewrite it");
  const old: Published = JSON.parse(text);
  const fresh = buildRun(r, old.label, old.id.replace(/^\d{4}-\d{2}-\d{2}-/, ""));
  if (fresh.id !== old.id) throw new Error(`the results file rebuilds as ${fresh.id}, not ${old.id}`);
  for (const section of old.sections) {
    const freshSection = fresh.sections.find((s) => s.id === section.id);
    if (!freshSection) throw new Error(`section ${section.id} is not in the rebuilt run`);
    for (const test of section.tests) {
      const freshTest = freshSection.tests.find((t) => t.id === test.id);
      if (!freshTest?.statistic) throw new Error(`${section.id}/${test.id} is not in the rebuilt run`);
      for (const result of test.results) {
        const freshResult = freshTest.results.find((x) => x.candidateId === result.candidateId);
        if (!freshResult?.samples) throw new Error(`${section.id}/${test.id}/${result.candidateId} is not in the rebuilt run`);
        if (freshResult.value !== result.value) throw new Error(`${section.id}/${test.id}/${result.candidateId}: published ${result.value}, the results file rebuilds ${freshResult.value}`);
        result.samples = freshResult.samples;
      }
      test.statistic = freshTest.statistic;
    }
  }
  checkSamples(old);
  return JSON.stringify(old, null, 2) + "\n";
}

export function enrichFile(runPath: string, r: Raw): void {
  writeFileSync(runPath, enrich(readFileSync(runPath, "utf8"), r));
}

if (import.meta.main) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  const runPath = args.run;
  if (!runPath) throw new Error("--run is required, e.g. --run=runs/2026-09-10-m2max.json");
  const r: Raw = JSON.parse(readFileSync(args.results ?? "results.json", "utf8"));
  enrichFile(runPath, r);
  console.log(`enriched ${runPath}`);
}
