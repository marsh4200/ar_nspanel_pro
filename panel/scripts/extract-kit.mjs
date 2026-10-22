// One-off (re-runnable) extractor: pulls the neumorphic theme kit CSS and the
// tile icon set out of the MIT-licensed config-panel bundle, so the panel app
// renders with exactly the surfaces/glyphs the editor preview shows.
//
//   node panel/scripts/extract-kit.mjs
//
// Writes panel/src/generated/kit.css and panel/src/generated/icons.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const bundle = fs.readFileSync(
  path.join(repo, "custom_components/ar_nspanel_pro/www/ar-nspanel-pro-config.js"),
  "utf8",
);
const outDir = path.join(repo, "panel/src/generated");
fs.mkdirSync(outDir, { recursive: true });

// --- kit CSS: the `HA = \`...\`` template literal ---------------------------
const start = bundle.indexOf("HA = `");
if (start < 0) throw new Error("kit CSS literal not found");
const bodyStart = start + "HA = `".length;
const end = bundle.indexOf("`;\nclass ", bodyStart);
if (end < 0) throw new Error("kit CSS literal end not found");
const literal = bundle.slice(bodyStart, end);
if (literal.includes("${")) throw new Error("unexpected interpolation in kit CSS");
// Evaluate as a template literal so escape sequences resolve exactly as in the bundle.
const kitCss = Function("return `" + literal + "`;")().replace(/\r/g, "");
fs.writeFileSync(path.join(outDir, "kit.css"), kitCss);

// --- icons: `U2 = {...}, X2 = {...}, k1 = {...};` ---------------------------
const iStart = bundle.indexOf("const U2 = {");
const iEnd = bundle.indexOf("function T2(", iStart);
if (iStart < 0 || iEnd < 0) throw new Error("icon tables not found");
const src = bundle.slice(iStart, iEnd) + "\nreturn { U2, X2, k1 };";
const { U2, X2, k1 } = Function(src)();
const fromX = {};
for (const [k, v] of Object.entries(X2)) {
  fromX[k] = { viewBox: "0 0 24 24", els: v.map((e) => ({ t: "path", d: e.d })) };
}
const all = { ...fromX, ...U2 };
const icons = {};
for (const [k, v] of Object.entries(all)) {
  let x = v;
  for (let i = 0; typeof x === "string" && i < 5; i++) x = all[x];
  if (x && typeof x === "object") icons[k] = x;
}
for (const [alias, target] of Object.entries(k1)) if (icons[target]) icons[alias] = icons[target];
// compact form: name -> [ "d" | [cx,cy,r], ... ]
const compact = {};
for (const [k, v] of Object.entries(icons)) {
  compact[k] = v.els.map((e) => (e.t === "circle" ? [e.cx, e.cy, e.r] : e.d));
}
fs.writeFileSync(path.join(outDir, "icons.json"), JSON.stringify(compact));
console.log(`kit.css ${kitCss.length} bytes, ${Object.keys(compact).length} icons`);
