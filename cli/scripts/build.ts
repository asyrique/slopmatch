// Cross-compile slopmatch for every platform into dist/. Run: bun scripts/build.ts [target-filter]
import { mkdirSync, statSync } from "node:fs";

export const TARGETS = [
  { target: "bun-darwin-arm64", out: "slopmatch-darwin-arm64" },
  { target: "bun-darwin-x64", out: "slopmatch-darwin-x64" },
  { target: "bun-linux-x64-baseline", out: "slopmatch-linux-x64" },
  { target: "bun-linux-arm64", out: "slopmatch-linux-arm64" },
  { target: "bun-windows-x64-baseline", out: "slopmatch-windows-x64.exe" },
];

if (import.meta.main) {
  const filter = process.argv[2] || "";
  mkdirSync("dist", { recursive: true });
  for (const t of TARGETS.filter((t) => t.out.includes(filter))) {
    const p = Bun.spawnSync(
      ["bun", "build", "src/cli.ts", "--compile", "--minify", `--target=${t.target}`, `--outfile=dist/${t.out}`],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
    console.log(`${t.out}  ${(statSync(`dist/${t.out}`).size / 1e6).toFixed(1)} MB`);
  }
}
