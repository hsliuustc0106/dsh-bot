import type { AgentRunRequest, AgentRuntime, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { defaultPilotBudget, pilotTasks, runPilotTask } from "./runtime-pilot.js";

function runtime(work: (request: AgentRunRequest) => Promise<string>): AgentRuntime {
  return {
    describe: () => ({
      id: "test",
      adapterVersion: "1",
      contractVersion: "1",
      capabilities: { streaming: true, compaction: false, scripted: false, tools: true },
    }),
    async *run(request): AsyncGenerator<AgentRuntimeEvent> {
      const text = await work(request);
      yield { type: "done", text };
    },
    abort: vi.fn(async () => undefined),
  };
}
const model = { provider: "fixture", id: "fixture-model", apiKey: "test-placeholder" };
describe("controlled pilot workspace", () => {
  it("denies paths, executable writes and tool routes before side effects", async () => {
    const result = await runPilotTask({
      harness: "test",
      model,
      task: pilotTasks[2]!,
      runtime: runtime(async (request) => {
        for (const [name, args, route] of [
          ["read_file", { path: "../outside" }, undefined],
          ["write_file", { path: "settings.test.mjs", content: "malicious" }, undefined],
          ["shell", { command: "echo unsafe" }, undefined],
          ["read_file", { path: "settings.json" }, { connectorId: "other", toolName: "read_file" }],
        ] as const)
          expect(await request.executeTool!(name, args, name, route)).toHaveProperty("error");
        return "Denied";
      }),
    });
    expect(result.deniedCalls).toBe(4);
    expect(result.policyCompliant).toBe(false);
    expect(result.automatedCorrectness).toBe(false);
  });
  it("requires the fixed tests to pass after the last configuration write", async () => {
    const result = await runPilotTask({
      harness: "test",
      model,
      task: pilotTasks[2]!,
      runtime: runtime(async (request) => {
        await request.executeTool!(
          "write_file",
          { path: "settings.json", content: '{"maxItems":10,"theme":"system"}' },
          "write",
        );
        expect(await request.executeTool!("run_tests", {}, "test")).toEqual({ passed: true });
        return "Tests passed";
      }),
    });
    expect(result.automatedCorrectness).toBe(true);
    expect(result.testsPassed).toBe(true);
    expect(result.costUsd).toBeNull();
  });
  it("denies writes on the read-only task", async () => {
    const result = await runPilotTask({
      harness: "test",
      model,
      task: pilotTasks[0]!,
      runtime: runtime(async (request) => {
        expect(request.tools.map((tool) => tool.name)).toEqual(["read_file", "list_files"]);
        expect(
          await request.executeTool!(
            "write_file",
            { path: "settings.json", content: "{}" },
            "write",
          ),
        ).toHaveProperty("error");
        return "CACHE_TTL_SECONDS defaults to 120 seconds, README.md:3";
      }),
    });
    expect(result.policyCompliant).toBe(false);
  });
  it("bounds tool calls and excludes raw errors and credentials from reports", async () => {
    const result = await runPilotTask({
      harness: "test",
      model,
      task: pilotTasks[0]!,
      budget: { ...defaultPilotBudget, maxToolCalls: 1 },
      runtime: runtime(async (request) => {
        await request.executeTool!("list_files", {}, "one");
        await request.executeTool!("list_files", {}, "two");
        throw new Error("test-placeholder");
      }),
    });
    expect(result.budgetExceeded).toBe(true);
    expect(result.completed).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-placeholder");
  });
});
