import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JiuwenProcessClient, validateInstallation } from "./process-client.js";
import { JiuwenSwarmRuntime } from "./runtime.js";
import { JIUWENSWARM_REVISION } from "./version.js";

const fixture = fileURLToPath(new URL("./fixtures/process.mjs", import.meta.url));
const directories: string[] = [];
const request = (): AgentRunRequest => ({
  runId: "run",
  botId: "bot",
  threadId: "thread",
  prompt: "hello",
  instructions: "Be concise",
  history: [],
  tools: [],
  model: { provider: "openai", id: "test-model", apiKey: "fake-test-key" },
});
function runtime(mode = "success", deadline = 2000) {
  const root = mkdtempSync(join(tmpdir(), "jiuwen-test-"));
  directories.push(root);
  const marker = join(root, "marker.json");
  const client = new JiuwenProcessClient([process.execPath, fixture, mode, marker], deadline, 50);
  return { runtime: new JiuwenSwarmRuntime({ pythonPath: "", sourceDir: "" }, client), marker };
}
async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("JiuwenSwarm real process boundary", () => {
  it("requires a successful terminal and exit, accounts unknown usage, disables all tools and scrubs the environment", async () => {
    vi.stubEnv("RAKAZO_UNRELATED_TEST_SECRET", "must-not-inherit");
    const { runtime: agent, marker } = runtime();
    const onUsage = vi.fn();
    const events = await collect(agent.run({ ...request(), onUsage }));
    expect(events).toEqual([
      { type: "text", text: "hello" },
      expect.objectContaining({
        type: "usage",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        accounted: true,
      }),
      { type: "done", text: "hello" },
    ]);
    expect(onUsage).toHaveBeenCalledTimes(1);
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(child.env.RAKAZO_UNRELATED_TEST_SECRET).toBeUndefined();
    expect(child.env.RAKAZO_MODEL_KEY).toBe("fake-test-key");
    expect(child.request).toMatchObject({
      agent: { tools: [], skills: [] },
      mcp: [],
      skills: [],
      host_tools: [],
    });
    expect(child.request.session_id).toBeUndefined();
    expect(existsSync(child.cwd)).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(agent.describe().adapterVersion).toContain(JIUWENSWARM_REVISION);
  });

  it.each([
    "malformed",
    "crash",
    "oversize",
    "foreign",
    "eof",
    "wrong-exit",
    "failed",
    "tool",
    "native-tool",
  ])("fails closed and cleans up after %s", async (mode) => {
    const { runtime: agent, marker } = runtime(mode);
    const events: AgentRuntimeEvent[] = [];
    const work = (async () => {
      for await (const event of agent.run(request())) events.push(event);
    })();
    await expect(work).rejects.toThrow("no successful terminal");
    expect(events.some((event) => event.type === "done")).toBe(false);
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(existsSync(child.cwd)).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
  });

  it("times out and reaps a process that never produces output", async () => {
    const { runtime: agent, marker } = runtime("hang", 1000);
    await expect(collect(agent.run(request()))).rejects.toThrow("no successful terminal");
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(existsSync(child.cwd)).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
  });

  it("cancels when a consumer disconnects", async () => {
    const { runtime: agent, marker } = runtime("cancel");
    const iterator = agent.run(request());
    expect(await iterator.next()).toMatchObject({ value: { type: "text" } });
    await iterator.return!();
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(existsSync(child.cwd)).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
  });

  it("interrupts an outstanding next and rejects duplicate run ids", async () => {
    const { runtime: agent } = runtime("pending");
    const iterator = agent.run(request());
    const pending = iterator.next();
    await expect(collect(agent.run(request()))).rejects.toThrow("already active");
    await agent.abort("run");
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it("bounds a stalled consumer and never reports success after overflow", async () => {
    const { runtime: agent, marker } = runtime("flood");
    const iterator = agent.run(request());
    await iterator.next();
    const child = JSON.parse(readFileSync(marker, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(child.pid, 0)).toThrow());
    await expect(collect(iterator)).rejects.toThrow("no successful terminal");
  });

  it("rejects unsupported settings before starting a process", async () => {
    const { runtime: agent, marker } = runtime();
    await expect(
      collect(agent.run({ ...request(), model: { ...request().model, thinkingLevel: "high" } })),
    ).rejects.toThrow("reasoning settings");
    await expect(
      collect(agent.run({ ...request(), resumeFromCheckpoint: "checkpoint" })),
    ).rejects.toThrow("resume");
    expect(existsSync(marker)).toBe(false);
  });

  it("fails startup on an unavailable installation", () => {
    expect(() =>
      validateInstallation({ pythonPath: "/missing/python", sourceDir: "/missing/source" }),
    ).toThrow(JIUWENSWARM_REVISION);
  });
});
