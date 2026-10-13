import { PiAgentRuntime } from "@rakazo/adapters";
import { DshAgentRuntime } from "@rakazo/runtime-dsh";
import { expect, it } from "vitest";
import { defaultPilotBudget, pilotTasks, runPilot, runPilotTask } from "./runtime-pilot.js";
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
      expect(server.requests.length).toBeGreaterThan(0);
      for (const { path, body } of server.requests) {
        if (path.includes("chat/completions")) expect(body.reasoning_effort).toBe("none");
        else expect(body.thinking).toEqual({ type: "disabled" });
      }
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

it.skipIf(!process.env.DSH_TEST_CLI_PATH).each([
  {
    name: "one terminal call",
    answerOnly: true,
    maxModelCalls: 1,
    maxTokens: 1000,
    calls: 1,
    completed: true,
  },
  {
    name: "terminal call N",
    answerOnly: false,
    maxModelCalls: 2,
    maxTokens: 1000,
    calls: 2,
    completed: true,
  },
  {
    name: "denied call N+1",
    answerOnly: false,
    maxModelCalls: 1,
    maxTokens: 1000,
    calls: 1,
    completed: false,
  },
  {
    name: "exact token allowance",
    answerOnly: true,
    maxModelCalls: 1,
    maxTokens: 110,
    calls: 1,
    completed: true,
  },
  {
    name: "tokens exhausted before next call",
    answerOnly: false,
    maxModelCalls: 3,
    maxTokens: 110,
    calls: 1,
    completed: false,
  },
])(
  "enforces $name at the outbound boundary for both harnesses",
  async (test) => {
    for (const harness of ["pi", "dsh"] as const) {
      const server = await startPilotEmulator({ answerOnly: test.answerOnly });
      try {
        const result = await runPilotTask({
          harness,
          runtime:
            harness === "pi"
              ? new PiAgentRuntime()
              : new DshAgentRuntime({ cliPath: process.env.DSH_TEST_CLI_PATH! }),
          task: pilotTasks[0]!,
          model: {
            provider: harness === "pi" ? "openai-compatible" : "deepseek",
            id: "fixture-model",
            apiKey: "test-placeholder",
            baseUrl: server.baseUrl,
          },
          budget: {
            ...defaultPilotBudget,
            maxModelCalls: test.maxModelCalls,
            maxTokens: test.maxTokens,
          },
        });
        expect(server.requests).toHaveLength(test.calls);
        expect(result.modelCalls).toBe(test.calls);
        expect(result.completed).toBe(test.completed);
        expect(result.budgetExceeded).toBe(!test.completed);
        expect(result.automatedCorrectness).toBe(test.completed);
      } finally {
        await server.close();
      }
    }
  },
  20000,
);
