import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  RuntimeSessionCoordinator,
} from "@rakazo/adapter-kit";
import { RuntimeSessionBusyError } from "@rakazo/adapter-kit";
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
function runtime(mode = "success", deadline = 2000, persistent = false) {
  const root = mkdtempSync(join(tmpdir(), "jiuwen-test-"));
  directories.push(root);
  const marker = join(root, "marker.json");
  const client = new JiuwenProcessClient(
    [process.execPath, fixture, mode, marker],
    deadline,
    50,
    persistent ? join(root, "sessions") : undefined,
  );
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

  it("claims queued follow-ups once and sends each without its history copy", async () => {
    const { runtime: agent, marker } = runtime();
    const claimSteering = vi.fn(async () => [
      { id: "steering-1", messageId: "message-1", text: "Review first" },
      { id: "steering-2", messageId: "message-2", text: "Then summarize" },
    ]);
    await collect(
      agent.run({
        ...request(),
        history: [
          { id: "older", role: "user", content: "Review first" },
          { id: "message-1", role: "user", content: "Review first" },
          { id: "message-2", role: "user", content: "Then summarize" },
        ],
        claimSteering,
      }),
    );
    expect(claimSteering).toHaveBeenCalledExactlyOnceWith([]);
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(JSON.parse(child.request.input)).toEqual({
      history: [{ id: "older", role: "user", content: "Review first" }],
      message: "hello",
      followUps: ["Review first", "Then summarize"],
    });
  });

  it("does not launch after cancellation during a follow-up claim", async () => {
    const { runtime: agent, marker } = runtime();
    const controller = new AbortController();
    const claimSteering = vi.fn(async () => {
      controller.abort();
      return [];
    });
    expect(
      await collect(
        agent.run(
          { ...request(), claimSteering },
          {
            signal: controller.signal,
          },
        ),
      ),
    ).toEqual([]);
    expect(claimSteering).toHaveBeenCalledTimes(1);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not report success or launch when a follow-up claim fails", async () => {
    const { runtime: agent, marker } = runtime();
    const claimSteering = vi.fn(async () => {
      throw new Error("lease lost");
    });
    await expect(collect(agent.run({ ...request(), claimSteering }))).rejects.toThrow(
      "no successful terminal",
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects follow-up images instead of silently discarding them", async () => {
    const { runtime: agent, marker } = runtime();
    await expect(
      collect(
        agent.run({
          ...request(),
          claimSteering: async () => [
            {
              id: "steering",
              messageId: "message",
              text: "Describe this",
              images: [{ name: "example.png", mimeType: "image/png", data: new Uint8Array() }],
            },
          ],
        }),
      ),
    ).rejects.toThrow("no successful terminal");
    expect(existsSync(marker)).toBe(false);
  });

  it("resumes a persistent session with only newly arrived history", async () => {
    const { runtime: agent, marker } = runtime("success", 2000, true);
    let checkpoint: string | null = null;
    const storageKey = randomUUID();
    const finish = vi.fn(async (_outcome: string, value?: string) => {
      checkpoint = value ?? null;
    });
    const runtimeSession: RuntimeSessionCoordinator = {
      acquire: async () => ({ storageKey, checkpoint, finish }),
    };
    const history: AgentRunRequest["history"] = [
      { id: "old", role: "user", content: "hello" },
      { id: "current", role: "user", content: "hello" },
    ];
    await collect(agent.run({ ...request(), sourceMessageId: "current", history, runtimeSession }));
    const first = JSON.parse(readFileSync(marker, "utf8"));
    expect(first.request.session_id).toBeUndefined();
    expect(JSON.parse(first.request.input)).toEqual({ history: [history[0]], message: "hello" });
    expect(existsSync(first.request.workspace.cwd)).toBe(true);
    expect(existsSync(first.cwd)).toBe(false);
    const added = { id: "new", role: "user" as const, content: "New context" };
    await collect(
      agent.run({ ...request(), runId: "next-run", history: [...history, added], runtimeSession }),
    );
    const second = JSON.parse(readFileSync(marker, "utf8"));
    expect(second.request.session_id).toBe("session");
    expect(second.request.workspace).toEqual(first.request.workspace);
    expect(JSON.parse(second.request.input).history).toEqual([added]);
    expect(finish).toHaveBeenCalledTimes(2);
    expect(finish.mock.calls.every(([outcome]) => outcome === "completed")).toBe(true);
  });

  it("preserves a safe busy-acquisition error and never launches", async () => {
    const { runtime: agent, marker } = runtime("success", 2000, true);
    const runtimeSession: RuntimeSessionCoordinator = {
      acquire: async () => {
        throw new RuntimeSessionBusyError();
      },
    };
    await expect(collect(agent.run({ ...request(), runtimeSession }))).rejects.toBeInstanceOf(
      RuntimeSessionBusyError,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it("marks a cancelled persistent session interrupted after child cleanup", async () => {
    const { runtime: agent, marker } = runtime("cancel", 2000, true);
    const finish = vi.fn(async () => {
      const child = JSON.parse(readFileSync(marker, "utf8"));
      expect(() => process.kill(child.pid, 0)).toThrow();
      expect(existsSync(child.cwd)).toBe(false);
    });
    const runtimeSession: RuntimeSessionCoordinator = {
      acquire: async () => ({ storageKey: randomUUID(), checkpoint: null, finish }),
    };
    const iterator = agent.run({ ...request(), runtimeSession });
    await iterator.next();
    await iterator.return!();
    expect(finish).toHaveBeenCalledExactlyOnceWith("interrupted", undefined);
  });

  it("does not retry upstream SESSION_BUSY or report success", async () => {
    const { runtime: agent, marker } = runtime("session-busy", 2000, true);
    const finish = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({ storageKey: randomUUID(), checkpoint: null, finish }));
    await expect(collect(agent.run({ ...request(), runtimeSession: { acquire } }))).rejects.toThrow(
      "no successful terminal",
    );
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledExactlyOnceWith("interrupted", undefined);
    expect(existsSync(JSON.parse(readFileSync(marker, "utf8")).cwd)).toBe(false);
  });

  it.each(["host-pause", "host-question"])(
    "releases %s only after cancelled child cleanup",
    async (mode) => {
      const { runtime: agent, marker } = runtime(mode, 2000, true);
      const finish = vi.fn(async () => {
        const child = JSON.parse(readFileSync(marker, "utf8"));
        expect(() => process.kill(child.pid, 0)).toThrow();
      });
      const events = await collect(
        agent.run({
          ...request(),
          runtimeSession: {
            acquire: async () => ({ storageKey: randomUUID(), checkpoint: null, finish }),
          },
          tools: [
            {
              name: mode === "host-question" ? "ask_user" : "read_file",
              description: "test",
              inputSchema: { type: "object" },
            },
          ],
          executeTool: async () => ({
            kind: "agent_tool_result",
            content: [],
            details: { approval: "paused" },
            terminate: true,
          }),
        }),
      );
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(finish).toHaveBeenCalledExactlyOnceWith("paused", undefined);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid token limits (%s) before model startup",
    async (maxTokens) => {
      const { runtime: agent, marker } = runtime();
      await expect(
        collect(agent.run({ ...request(), model: { ...request().model, maxTokens } })),
      ).rejects.toThrow("token limits");
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("honors the token boundary and bounded turn counts without claiming a dollar ceiling", async () => {
    const { runtime: agent, marker } = runtime();
    await collect(
      agent.run({ ...request(), model: { ...request().model, maxTokens: 1, contextWindow: 1 } }),
    );
    const child = JSON.parse(readFileSync(marker, "utf8"));
    expect(child.config.models.defaults[0].model_config_obj).toEqual({
      max_tokens: 1,
      context_window: 1,
    });
    expect(child.request.max_turns).toBe(1);
    expect(child.request.max_budget_usd).toBeUndefined();
    await expect(
      collect(
        agent.run({ ...request(), model: { ...request().model, maxTokens: 2, contextWindow: 1 } }),
      ),
    ).rejects.toThrow("context window");
  });

  it.each(["turn-limit", "cost-limit"])(
    "accounts a terminal %s failure without success or retry",
    async (mode) => {
      const { runtime: agent } = runtime(mode);
      const onUsage = vi.fn();
      const events: AgentRuntimeEvent[] = [];
      await expect(
        (async () => {
          for await (const event of agent.run({ ...request(), onUsage })) events.push(event);
        })(),
      ).rejects.toThrow("no successful terminal");
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(onUsage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          costUsd: 0.02,
        }),
      );
    },
  );

  it("keeps usage records distinct for successive invocations of an answered run", async () => {
    const { runtime: agent } = runtime();
    const onUsage = vi.fn();
    await collect(agent.run({ ...request(), onUsage }));
    await collect(agent.run({ ...request(), onUsage }));
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls[0]![0].callId).not.toBe(onUsage.mock.calls[1]![0].callId);
    expect(onUsage.mock.calls[0]![0].costUsd).toBeNull();
  });

  it.each([
    "malformed",
    "crash",
    "oversize",
    "foreign",
    "eof",
    "wrong-exit",
    "failed",
    "session-missing",
    "tool",
    "native-tool",
  ])("fails closed and cleans up after %s", async (mode) => {
    const { runtime: agent, marker } = runtime(mode);
    const events: AgentRuntimeEvent[] = [];
    const work = (async () => {
      for await (const event of agent.run(request())) events.push(event);
    })();
    await expect(work).rejects.toThrow("JiuwenSwarm");
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

  it.each(["host-success", "host-duplicate", "host-pause", "host-question"])(
    "routes %s through the SDK and cleans up",
    async (mode) => {
      const { runtime: agent, marker } = runtime(mode);
      const executeTool = vi.fn(async () =>
        mode === "host-pause"
          ? {
              kind: "agent_tool_result",
              content: [],
              details: { approval: "paused" },
              terminate: true,
            }
          : { ok: true },
      );
      const onToolCompleted = vi.fn();
      const name = mode === "host-question" ? "ask_user" : "read_file";
      const events = await collect(
        agent.run({
          ...request(),
          tools: [{ name, description: "test", inputSchema: { type: "object" } }],
          executeTool,
          onToolCompleted,
        }),
      );
      expect(executeTool).toHaveBeenCalledTimes(mode === "host-question" ? 0 : 1);
      expect(onToolCompleted).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.type === "tool")).toHaveLength(1);
      expect(events.some((event) => event.type === "done")).toBe(
        mode === "host-success" || mode === "host-duplicate",
      );
      if (mode === "host-question")
        expect(events).toContainEqual(
          expect.objectContaining({ type: "ask", text: "Which file?" }),
        );
      const child = JSON.parse(readFileSync(marker, "utf8"));
      expect(child.request.agent.tools).toEqual(
        child.request.host_tools.map((tool: { name: string }) => tool.name),
      );
      expect(child.request.max_turns).toBe(32);
      expect(child.request.agent.max_iterations).toBe(32);
      expect(child.request.mcp).toEqual([]);
      expect(child.request.skills).toEqual([]);
      expect(existsSync(child.cwd)).toBe(false);
      expect(() => process.kill(child.pid, 0)).toThrow();
    },
  );

  it("fails startup on an unavailable installation", () => {
    expect(() =>
      validateInstallation({ pythonPath: "/missing/python", sourceDir: "/missing/source" }),
    ).toThrow(JIUWENSWARM_REVISION);
  });
});
