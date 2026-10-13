import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { Event } from "../vendor/index.js";
import { HostTools, hostToolName } from "./host-tools.js";

const tool: ConnectorTool = {
  name: "notes.write",
  description: "Write a note",
  inputSchema: { type: "object" },
  route: { connectorId: "installed", resourceId: "notes", toolName: "write" },
};
const event = (changes: Partial<Event> = {}): Event => ({
  schema_version: "0.1",
  type: "event",
  sequence: 0,
  request_id: "run",
  session_id: "session",
  event_type: "host_tool.requested",
  payload: { call_id: "call", name: hostToolName(tool.name), arguments: { text: "example" } },
  ...changes,
});
function fixture(overrides: Partial<AgentRunRequest> = {}) {
  const controller = new AbortController();
  const events: AgentRuntimeEvent[] = [];
  const fail = vi.fn(() => controller.abort());
  const pause = vi.fn(() => controller.abort());
  const executeTool = vi.fn(async () => ({ ok: true }));
  const onToolCompleted = vi.fn();
  const request: AgentRunRequest = {
    runId: "run",
    botId: "bot",
    threadId: "thread",
    prompt: "test",
    instructions: "test",
    history: [],
    tools: [tool],
    model: { provider: "openai", id: "model" },
    executeTool,
    onToolCompleted,
    ...overrides,
  };
  const host = new HostTools(
    request,
    controller.signal,
    (event) => events.push(event),
    pause,
    fail,
  );
  return { host, request, controller, events, pause, fail, executeTool, onToolCompleted };
}

describe("JiuwenSwarm host-controlled tools", () => {
  it("namespaces tools and dispatches through the scoped executor with route, stable identity and audit", async () => {
    const f = fixture();
    expect(f.host.declarations[0]?.name).not.toBe(tool.name);
    await f.host.call(event());
    const executionId = JSON.stringify(["jiuwenswarm", "run", "session", "call"]);
    expect(f.executeTool).toHaveBeenCalledExactlyOnceWith(
      tool.name,
      { text: "example" },
      executionId,
      tool.route,
      { signal: f.controller.signal },
    );
    expect(f.onToolCompleted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: tool.name, executionId, result: { ok: true } }),
    );
    expect(f.events).toEqual([
      { type: "tool", name: tool.name, args: { text: "example" }, executionId },
    ]);
  });
  it("shares concurrent duplicate callbacks without duplicating actions or audit records", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.host.call(event()), f.host.call(event())]);
    expect(a).toBe(b);
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.onToolCompleted).toHaveBeenCalledTimes(1);
  });
  it("rejects reuse of a call ID with changed arguments", async () => {
    const f = fixture();
    await f.host.call(event());
    await expect(
      f.host.call(
        event({
          payload: {
            call_id: "call",
            name: hostToolName(tool.name),
            arguments: { text: "changed" },
          },
        }),
      ),
    ).rejects.toThrow("reused");
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.fail).toHaveBeenCalledOnce();
  });
  it.each(["foreign-run", "foreign-session", "native-tool", "cancelled"])(
    "blocks %s before dispatch",
    async (kind) => {
      const f = fixture();
      if (kind === "foreign-session")
        f.host.observe(
          event({
            event_type: "chat.tool_call",
            payload: { tool: { name: hostToolName(tool.name) } },
          }),
        );
      if (kind === "cancelled") f.controller.abort();
      const call =
        kind === "foreign-run"
          ? event({ request_id: "other" })
          : kind === "foreign-session"
            ? event({ session_id: "other" })
            : kind === "native-tool"
              ? event({ payload: { call_id: "call", name: "shell", arguments: {} } })
              : event();
      await expect(f.host.call(call)).rejects.toThrow();
      expect(f.executeTool).not.toHaveBeenCalled();
    },
  );
  it("keeps catalogs and call deduplication separate across tenants", async () => {
    const first = fixture();
    const second = fixture({ runId: "other-run", botId: "other-bot", threadId: "other-thread" });
    await first.host.call(event());
    await expect(second.host.call(event())).rejects.toThrow("Foreign");
    expect(second.executeTool).not.toHaveBeenCalled();
  });
  it("preserves a denial and does not widen it into an approval", async () => {
    const denied = vi.fn(async () => ({ error: "Permission denied" }));
    const f = fixture({ executeTool: denied });
    expect(await f.host.call(event())).toEqual({ error: "Permission denied" });
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ result: { error: "Permission denied" } }),
    );
  });
  it("stops on a host approval pause", async () => {
    const f = fixture({
      executeTool: async () => ({
        kind: "agent_tool_result",
        content: [],
        details: { approval: "paused" },
        terminate: true,
      }),
    });
    await f.host.call(event());
    expect(f.pause).toHaveBeenCalledOnce();
    expect(f.controller.signal.aborted).toBe(true);
    expect(f.onToolCompleted).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
  });
  it("stops after an executor exception instead of inviting a model retry", async () => {
    const f = fixture({
      executeTool: async () => {
        throw new Error("uncertain action");
      },
    });
    await expect(f.host.call(event())).rejects.toThrow("uncertain action");
    expect(f.fail).toHaveBeenCalledOnce();
    expect(f.onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
  it("maps a supported question to the existing ask UI and never submits a fabricated answer", () => {
    const f = fixture();
    const answers = f.host.interaction(
      event({
        event_type: "interaction.requested",
        payload: {
          kind: "question",
          interaction_id: "question-1",
          questions: [
            {
              question: "Which file?",
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ],
            },
          ],
        },
      }),
    );
    expect(answers).toEqual([]);
    expect(f.events).toEqual([
      {
        type: "ask",
        text: "Which file?",
        actions: [
          { id: "choice-1", label: "A" },
          { id: "choice-2", label: "B" },
        ],
      },
    ]);
    expect(f.pause).toHaveBeenCalledOnce();
    expect(() => f.host.interaction(event())).toThrow();
  });
  it("never grants native permission requests", () => {
    const f = fixture();
    expect(() =>
      f.host.interaction(
        event({
          event_type: "interaction.requested",
          payload: { kind: "permission", questions: [] },
        }),
      ),
    ).toThrow("Unsupported");
    expect(f.executeTool).not.toHaveBeenCalled();
  });
  it("stops when completion audit fails", async () => {
    const f = fixture({
      onToolCompleted: async () => {
        throw new Error("audit unavailable");
      },
    });
    await f.host.call(event());
    expect(f.fail).toHaveBeenCalledOnce();
    expect(f.controller.signal.aborted).toBe(true);
  });
  it("bounds retained results after an action", async () => {
    const f = fixture({ executeTool: async () => "x".repeat(512 * 1024 + 1) });
    await expect(f.host.call(event())).rejects.toThrow("results exceeded");
    expect(f.fail).toHaveBeenCalledOnce();
  });
});
