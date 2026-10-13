import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PilotOptions } from "./runner.js";
import { runAdapterPilot } from "./runner.js";

async function main() {
  const [configFile, reportFile, ...extra] = process.argv.slice(2);
  if (!configFile || !reportFile || extra.length)
    throw new Error("Expected a private connection configuration file and a new report filename");
  if (existsSync(reportFile)) throw new Error("Pilot report destination already exists");
  accessSync(dirname(resolve(reportFile)), constants.W_OK);
  const config = JSON.parse(readFileSync(configFile, "utf8")) as Pick<
    PilotOptions,
    "model" | "installation"
  >;
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const report = await runAdapterPilot({
      ...config,
      repositoryRoot: resolve(import.meta.dirname, "../../../.."),
      signal: controller.signal,
    });
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    process.stdout.write(
      report.fixtureGatePassed
        ? "Repository fixture checks passed; rollout gates remain.\n"
        : "Repository fixture checks failed.\n",
    );
    if (!report.fixtureGatePassed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

void main().catch(() => {
  // Never print raw provider errors or private configuration paths.
  process.stderr.write(
    "Pilot could not finish. Check the private configuration, installation and report destination.\n",
  );
  process.exitCode = 1;
});
