import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const revision = readFileSync(join(root, "src/version.ts"), "utf8").match(/[a-f0-9]{40}/)[0];
const checkout = mkdtempSync(join(tmpdir(), "jiuwenswarm-sdk-"));
const run = (cmd, args, cwd = checkout) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
  });
try {
  run("git", ["init"]);
  run("git", ["fetch", "--depth=1", "https://github.com/openJiuwen-ai/jiuwenswarm.git", revision]);
  run("git", ["checkout", "--detach", "FETCH_HEAD"]);
  const sdk = join(checkout, "sdks/typescript");
  run("npm", ["ci", "--ignore-scripts"], sdk);
  run("npm", ["run", "build"], sdk);
  for (const name of ["index.js", "index.d.ts", "protocol.js", "protocol.d.ts"])
    copyFileSync(join(sdk, "dist", name), join(root, "vendor", name));
  copyFileSync(join(checkout, "LICENSE"), join(root, "vendor/LICENSE"));
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
