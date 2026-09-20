// Builds the panel UI into the integration's static dir, from where Home
// Assistant serves it (/ar_nspanel_pro_static/app/) and the Android app bundles
// it as its offline copy.
//
//   node panel/build.mjs            (from the repo root, or anywhere)
//
// esbuild is the only dependency (npm i --prefix panel).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../custom_components/ar_nspanel_pro/www/app");
const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
const version = process.env.APP_VERSION || pkg.version;

fs.mkdirSync(out, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(here, "src/app.js")],
  bundle: true,
  format: "iife",
  // The NSPanel Pro ships Android 8.1; its system WebView may be Chromium 6x.
  target: ["chrome61"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  loader: { ".json": "json" },
  define: { __APP_VERSION__: JSON.stringify(version) },
  outfile: path.join(out, "app.js"),
  logLevel: "warning",
});

fs.copyFileSync(path.join(here, "src/generated/kit.css"), path.join(out, "kit.css"));
fs.copyFileSync(path.join(here, "src/app.css"), path.join(out, "app.css"));
const html = fs
  .readFileSync(path.join(here, "src/index.html"), "utf8")
  .replace(/__VERSION__/g, version);
fs.writeFileSync(path.join(out, "index.html"), html);
fs.writeFileSync(path.join(out, "version.json"), JSON.stringify({ version }) + "\n");
console.log("panel UI " + version + " -> " + path.relative(process.cwd(), out));
