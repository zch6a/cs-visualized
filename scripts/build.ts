// Build the site into dist/: compile src/ with tsc, copy public/ next to it. No bundler — the browser
// loads the ES modules tsc writes.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** `clean: true` (a release build) empties dist/ first. The dev server rebuilds without cleaning, and
 *  tsc writes nothing when there is a type error (`noEmitOnError`), so a broken edit leaves the last good
 *  build in place instead of an empty folder. */
export function build({ clean = false } = {}): boolean {
  try {
    mkdirSync(dist, { recursive: true });
    // Empty rather than delete: on Windows a folder being served cannot always be removed.
    if (clean) for (const entry of readdirSync(dist)) rmSync(join(dist, entry), { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    console.error(`could not clean dist/: ${(e as Error).message}`);
    return false;
  }
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) {
    console.error("TypeScript is not installed: run `npm install` first.");
    return false;
  }
  const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { stdio: "inherit" });
  if (result.status !== 0) return false;
  cpSync(join(root, "public"), dist, { recursive: true });
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const ok = build({ clean: true });
  console.log(ok ? `built ${dist}` : "build failed");
  process.exit(ok ? 0 : 1);
}
