import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginDistDir = resolve(rootDir, "plugin", "dist");
const uiEntry = resolve(rootDir, "src", "plugin", "ui.ts");
const uiTemplatePath = resolve(rootDir, "src", "plugin", "ui.html");
const codeEntry = resolve(rootDir, "src", "plugin", "code.ts");

await mkdir(pluginDistDir, { recursive: true });

const uiBuild = await build({
  entryPoints: [uiEntry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2017"],
  charset: "utf8",
  write: false,
  sourcemap: false,
  logLevel: "info"
});

const uiScript = uiBuild.outputFiles[0]?.text;

if (!uiScript) {
  throw new Error("Unable to bundle the plugin UI.");
}

const uiTemplate = await readFile(uiTemplatePath, "utf8");
const inlineUiHtml = uiTemplate.replace(
  "<!-- __UI_SCRIPT__ -->",
  `<script>${uiScript}</script>`
);

await writeFile(resolve(pluginDistDir, "ui.html"), inlineUiHtml, "utf8");

await build({
  entryPoints: [codeEntry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2017"],
  charset: "utf8",
  sourcemap: false,
  outfile: resolve(pluginDistDir, "code.js"),
  define: {
    __UI_HTML__: JSON.stringify(inlineUiHtml)
  },
  logLevel: "info"
});

console.log("Plugin bundle written to plugin/dist");
