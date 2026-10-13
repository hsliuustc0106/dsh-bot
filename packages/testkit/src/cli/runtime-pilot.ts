import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PiAgentRuntime } from "@rakazo/adapters";
import { DshAgentRuntime } from "@rakazo/runtime-dsh";
import { runPilot } from "../runtime-pilot.js";
import { startPilotEmulator } from "../runtime-pilot-emulator.js";

const { values } = parseArgs({
  options: {
    offline: { type: "boolean" },
    connection: { type: "string" },
    "dsh-cli": { type: "string" },
    output: { type: "string" },
  },
});
if (!values["dsh-cli"] || !values.output || (!values.offline && !values.connection))
  throw new Error("Supply --dsh-cli, --output, and either --offline or --connection");
const emulator = values.offline ? await startPilotEmulator() : undefined;
try {
  const connection = emulator
    ? {
        model: { id: "fixture-model", apiKey: "test-placeholder" },
        chatBaseUrl: emulator.baseUrl,
        messagesBaseUrl: emulator.baseUrl,
      }
    : JSON.parse(await readFile(values.connection!, "utf8"));
  if (typeof connection.model?.id !== "string" || typeof connection.model?.apiKey !== "string")
    throw new Error("A model id and API-key connection are required");
  const chat = new URL(connection.chatBaseUrl);
  const messages = new URL(connection.messagesBaseUrl);
  if (chat.origin !== messages.origin || (!emulator && chat.protocol !== "https:"))
    throw new Error("Both model protocols must use the same secure origin");
  const report = await runPilot({
    ...connection,
    mode: emulator ? "offline-emulator" : "live",
    pi: new PiAgentRuntime(),
    dsh: new DshAgentRuntime({ cliPath: values["dsh-cli"], toolAccess: "disposable-pilot" }),
  });
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${report.mode}: ${report.results.filter((row) => row.automatedCorrectness && row.policyCompliant).length}/${report.results.length} fixture checks passed\n`,
  );
  if (report.results.some((row) => !row.automatedCorrectness || !row.policyCompliant))
    process.exitCode = 1;
} finally {
  await emulator?.close();
}
