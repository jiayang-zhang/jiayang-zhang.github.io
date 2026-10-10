// Bundles the dashboard frontend into the Jekyll site's assets folder.
// Only web/ and shared/ are bundled; nothing under worker/ reaches the browser.
import { build, context } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const watch = process.argv.includes("--watch");

const options = {
  absWorkingDir: root,
  entryPoints: { app: "web/src/main.tsx" },
  outdir: "../assets/biotech",
  bundle: true,
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
};

if (watch) await (await context(options)).watch();
else await build(options);
