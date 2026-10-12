import { PiAgentRuntime } from "@rakazo/adapters";
import { DshAgentRuntime } from "@rakazo/runtime-dsh";
import { expect, it } from "vitest";
import { runPilot } from "./runtime-pilot.js";
import { startPilotEmulator } from "./runtime-pilot-emulator.js";

it.skipIf(!process.env.DSH_TEST_CLI_PATH)(
  "runs the same three pilot fixtures through Pi and pinned DSH",
  async () => {
    const server = await startPilotEmulator();
    try {
      const report = await runPilot({
        mode: "offline-emulator",
        pi: new PiAgentRuntime(),
        dsh: new DshAgentRuntime({
          cliPath: process.env.DSH_TEST_CLI_PATH!,
          toolAccess: "disposable-pilot",
        }),
        model: { id: "fixture-model", apiKey: "test-placeholder" },
        chatBaseUrl: server.baseUrl,
        messagesBaseUrl: server.baseUrl,
      });
      expect(report.results).toHaveLength(6);
      expect(
        report.results.every(
          (row) => row.automatedCorrectness && row.policyCompliant && row.completed,
        ),
      ).toBe(true);
      expect(
        report.results
          .filter((row) => row.task === "configuration-change")
          .every((row) => row.testsPassed),
      ).toBe(true);
      expect(report.results.every((row) => row.costUsd === null && row.modelCalls > 0)).toBe(true);
    } finally {
      await server.close();
    }
  },
  30_000,
);
