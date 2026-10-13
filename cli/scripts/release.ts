// Upload dist/ binaries to the R2 bucket the Worker serves from (/dl/<name>).
// Run from cli/: bun scripts/release.ts [--local]   (--local targets `wrangler dev` storage)
import { TARGETS } from "./build";

const where = process.argv.includes("--local") ? "--local" : "--remote";
for (const t of TARGETS) {
  const p = Bun.spawnSync(
    ["bunx", "wrangler", "r2", "object", "put", `slopmatch-bin/${t.out}`, `--file=../cli/dist/${t.out}`,
      "--content-type=application/octet-stream", where],
    { cwd: "../worker", stdout: "inherit", stderr: "inherit" },
  );
  if (p.exitCode !== 0) process.exit(p.exitCode ?? 1);
}
console.log(`Uploaded ${TARGETS.length} binaries (${where.slice(2)}).`);
