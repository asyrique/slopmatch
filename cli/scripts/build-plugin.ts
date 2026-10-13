// Bundle the CLI into one readable Node script for the Claude Code plugin (plugin/bin/slopmatch).
// Run from cli/: bun scripts/build-plugin.ts
// Not minified on purpose: anyone installing the plugin can read exactly what it does.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const out = "../plugin/bin/slopmatch.mjs";
const res = await Bun.build({ entrypoints: ["src/cli.ts"], target: "node", format: "esm", minify: false });
if (!res.success) { console.error(res.logs); process.exit(1); }
const code = (await res.outputs[0].text()).replace(/^#!.*\n/, "");
writeFileSync(out, `// slopmatch CLI, bundled from cli/src in https://github.com/asyrique/slopmatch. Needs Node 18+.\n${code}`);
// bin/ is on Claude's PATH while the plugin is enabled. A CommonJS launcher (no extension) works on every Node 18+.
const launcher = "../plugin/bin/slopmatch";
writeFileSync(launcher, '#!/usr/bin/env node\nimport(require("node:url").pathToFileURL(require("node:path").join(__dirname, "slopmatch.mjs")).href);\n');
chmodSync(launcher, 0o755);
// Windows has no shebangs: a .cmd shim next to it runs the same script with node.
writeFileSync("../plugin/bin/slopmatch.cmd", '@node "%~dp0slopmatch.mjs" %*\r\n');

const version = readFileSync("src/cli.ts", "utf8").match(/const VERSION = "([^"]+)"/)![1];
const manifest = "../plugin/.claude-plugin/plugin.json";
const m = JSON.parse(readFileSync(manifest, "utf8"));
m.version = version;
writeFileSync(manifest, JSON.stringify(m, null, 2) + "\n");
console.log(`Built ${out} (${(code.length / 1024).toFixed(0)} KB), plugin version ${version}`);
