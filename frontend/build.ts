// Builds the single frontend bundle both shells embed. No framework, no
// bundler config: one entry, one output directory, deterministic content.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const out = new URL("./dist/", import.meta.url);
mkdirSync(out, { recursive: true });
const result = await Bun.build({
  entrypoints: [new URL("./src/main.ts", import.meta.url).pathname],
  outdir: out.pathname,
  target: "browser",
  minify: false,
  sourcemap: "none",
  naming: "[name].js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
copyFileSync(new URL("./index.html", import.meta.url), new URL("index.html", out));
const js = readFileSync(new URL("main.js", out));
const html = readFileSync(new URL("index.html", out));
const sha = createHash("sha256").update(js).update(html).digest("hex");
writeFileSync(new URL("frontend.sha256", out), sha + "\n");
console.log(`frontend ${sha.slice(0, 12)} ${js.byteLength} bytes`);
