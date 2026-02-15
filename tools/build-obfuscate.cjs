#!/usr/bin/env node
/**
 * Build script (no local deps required):
 * - Read `index.dev.html`
 * - Extract inline <script> blocks and obfuscate each with `javascript-obfuscator` (CLI)
 * - Minify HTML/CSS with `html-minifier-terser` (CLI), but DO NOT minify JS again
 * - Output: `index.html`
 *
 * Note: `javascript-obfuscator --parse-html` exists but its CLI restricts input
 * to .js/.mjs/.cjs paths, so we do the extraction ourselves.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const crypto = require("crypto");

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "index.dev.html");
const OUTPUT = path.join(ROOT, "index.html");

function die(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(INPUT)) die(`Input not found: ${INPUT}`);

function runNpx(args) {
  execFileSync("npx", ["--yes", ...args], { stdio: "inherit" });
}

const nonce = crypto.randomBytes(6).toString("hex");
function tmpPath(suffix) {
  return path.join(os.tmpdir(), `mc_customizer_${nonce}_${suffix}`);
}

const html = fs.readFileSync(INPUT, "utf8");

// Capture inline scripts; skip <script src="..."> and non-JS types (e.g. application/json)
const scriptTagRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const scripts = [];

const htmlWithPlaceholders = html.replace(
  scriptTagRegex,
  (fullMatch, rawAttrs, rawCode) => {
    if (/\bsrc\s*=/.test(rawAttrs)) return fullMatch;

    const code = rawCode.trim();
    if (!code) return fullMatch;

    const typeMatch = rawAttrs.match(/\btype\s*=\s*["']([^"']+)["']/i);
    const type = typeMatch ? typeMatch[1].toLowerCase() : "";
    if (type && type !== "text/javascript" && type !== "application/javascript")
      return fullMatch;

    const idx = scripts.length;
    scripts.push({ attrs: rawAttrs, code });
    return `<script${rawAttrs}>__OBF_PLACEHOLDER_${nonce}_${idx}__</script>`;
  }
);

if (scripts.length === 0) {
  die("No inline <script> blocks found to obfuscate in index.dev.html.");
}

const obfuscatedByIdx = new Map();
const tmpFiles = [];

try {
  for (let i = 0; i < scripts.length; i += 1) {
    const inJs = tmpPath(`in_${i}.js`);
    const outJs = tmpPath(`out_${i}.js`);
    tmpFiles.push(inJs, outJs);

    fs.writeFileSync(inJs, scripts[i].code, "utf8");

    runNpx([
      "javascript-obfuscator",
      inJs,
      "--output",
      outJs,
      "--target",
      "browser",
      "--options-preset",
      "medium-obfuscation",
      "--compact",
      "true",
      "--string-array-encoding",
      "base64",
    ]);

    const obf = fs.readFileSync(outJs, "utf8");
    // Prevent accidental </script> termination inside obfuscated output
    const safe = obf.replace(/<\/script>/gi, "<\\/script>");
    obfuscatedByIdx.set(i, safe);
  }

  let htmlObfuscated = htmlWithPlaceholders;
  for (let i = 0; i < scripts.length; i += 1) {
    const placeholder = `__OBF_PLACEHOLDER_${nonce}_${i}__`;
    const obf = obfuscatedByIdx.get(i);
    if (!obf) die(`Missing obfuscated output for script #${i}`);
    htmlObfuscated = htmlObfuscated.replace(placeholder, obf);
  }

  const tmpHtml = tmpPath("obf.html");
  tmpFiles.push(tmpHtml);
  fs.writeFileSync(tmpHtml, htmlObfuscated, "utf8");

  // Minify HTML/CSS without re-minifying JS (keep obfuscator output)
  runNpx([
    "html-minifier-terser",
    "--collapse-whitespace",
    "--remove-comments",
    "--minify-css",
    "true",
    "--minify-js",
    "false",
    "-o",
    OUTPUT,
    tmpHtml,
  ]);
} finally {
  for (const f of tmpFiles) {
    try {
      fs.existsSync(f) && fs.unlinkSync(f);
    } catch {
      // ignore cleanup errors
    }
  }
}

console.log(`Generated ${path.relative(ROOT, OUTPUT)} from ${path.relative(ROOT, INPUT)}.`);

