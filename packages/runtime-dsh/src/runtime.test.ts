import { fileURLToPath } from "node:url";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { DshAgentRuntime } from "./runtime.js";

const cliPath = fileURLToPath(new URL("./fixtures/fake-dsh/lib/bin.js", import.meta.url));
const read = { name: "read_file", description: "Read file", inputSchema: { type: "object" } };
const request = (patch: Partial<AgentRunRequest> = {}): AgentRunRequest => ({
  botId: "bot",
  threadId: "thread",
  runId: "run",
  prompt: "read",
  instructions: "Use allowed tools",
  history: [],
  tools: [read],
  model: { provider: "deepseek", id: "fixture-model", apiKey: "test-placeholder" },
  ...patch,
});
async function collect(input: AgentRunRequest, runtime = new DshAgentRuntime({ cliPath })) {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.run(input)) events.push(event);
  return events;
}
it("uses the supplied executor and producer accounting", async () => {
  const executeTool = vi.fn(async () => "repository contents");
  const onUsage = vi.fn();
  const onToolCompleted = vi.fn();
  const events = await collect(request({ executeTool, onUsage, onToolCompleted }));
  expect(executeTool).toHaveBeenCalledExactlyOnceWith(
    "read_file",
    { path: "README.md" },
    expect.stringMatching(/^run:dsh:/),
    undefined,
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(events.at(-1)).toMatchObject({ type: "done", text: "repository contents" });
  expect(onUsage).toHaveBeenCalledOnce();
  expect(events).toContainEqual(
    expect.objectContaining({ type: "usage", accounted: true, costUsd: null }),
  );
  expect(onToolCompleted).toHaveBeenCalledWith(
    expect.objectContaining({ name: "read_file", result: "repository contents" }),
  );
});
it("keeps executor denials and raw diagnostics out of model output", async () => {
  const executeTool = vi.fn(async () => {
    throw new Error("private-detail");
  });
  await expect(collect(request({ executeTool }))).rejects.toThrow("verify its outcome");
  expect(executeTool).toHaveBeenCalledOnce();
});
it("filters tools by name, route and write declaration while preserving history", async () => {
  const history: AgentRunRequest["history"] = [
    { role: "assistant", content: '{"name":"read_file"}' },
  ];
  const events = await collect(
    request({
      prompt: "inspect",
      history,
      tools: [
        read,
        { ...read, name: "shell", readOnly: true },
        { ...read, name: "list_files", route: { connectorId: "connector", toolName: "read_file" } },
        { ...read, name: "list_files", readOnly: false },
      ],
    }),
  );
  const value = JSON.parse(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
  );
  expect(value.tools).toEqual([read]);
  expect(value.history).toEqual(history);
});
it("fails unknown tools without invoking Rakazo", async () => {
  const executeTool = vi.fn();
  await expect(collect(request({ prompt: "unknown", executeTool }))).rejects.toThrow();
  expect(executeTool).not.toHaveBeenCalled();
});
it("terminates an approval pause without another tool or completion text", async () => {
  const executeTool = vi.fn(async () => ({
    kind: "agent_tool_result",
    content: [],
    details: { approval: "paused" },
    terminate: true,
  }));
  const onToolCompleted = vi.fn();
  const events = await collect(request({ executeTool, onToolCompleted }));
  expect(executeTool).toHaveBeenCalledOnce();
  expect(onToolCompleted).toHaveBeenCalledWith(expect.objectContaining({ paused: true }));
  expect(events.at(-1)).toEqual({ type: "done" });
});
it.each([
  { resumeFromCheckpoint: "old" },
  { fallbackModels: [{ provider: "deepseek", id: "other" }] },
  { model: { provider: "other", id: "model" } },
  {
    currentTurnImages: [{ name: "image", mimeType: "image/png" as const, data: new Uint8Array() }],
  },
])("rejects unsupported requests before execution: %j", async (patch) => {
  const executeTool = vi.fn();
  await expect(collect(request({ ...patch, executeTool }))).rejects.toThrow();
  expect(executeTool).not.toHaveBeenCalled();
});

it.each(["runtime", "upstream", "consumer"])(
  "cancels a waiting generation through %s",
  async (method) => {
    const runtime = new DshAgentRuntime({ cliPath });
    const controller = new AbortController();
    const stream = runtime.run(request({ prompt: "waiting" }), { signal: controller.signal });
    expect(await stream.next()).toMatchObject({ value: { type: "text", text: "Waiting" } });
    const pending = stream.next();
    if (method === "runtime") await runtime.abort("run");
    else if (method === "upstream") controller.abort();
    else await stream.return?.();
    expect(await pending).toEqual({ done: true, value: undefined });
  },
);
it("cancels in-flight tools and waits for their confirmed settlement", async () => {
  const runtime = new DshAgentRuntime({ cliPath });
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  const executeTool = vi.fn(async (_name, _args, _id, _route, observer) => {
    started();
    await new Promise<void>((resolve) =>
      observer.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return "settled after cancellation";
  });
  const onToolCompleted = vi.fn();
  const work = collect(request({ executeTool, onToolCompleted }), runtime);
  await began;
  await runtime.abort("run");
  const events = await work;
  expect(onToolCompleted).toHaveBeenCalledWith(
    expect.objectContaining({ result: "settled after cancellation" }),
  );
  expect(events.some((event) => event.type === "done")).toBe(false);
  expect(executeTool).toHaveBeenCalledOnce();
});
it("isolates concurrent users including imported context and tool results", async () => {
  const runtime = new DshAgentRuntime({ cliPath });
  const inputs = ["first", "second"].map((id) =>
    request({
      runId: id,
      botId: id,
      threadId: id,
      prompt: "inspect",
      history: [{ role: "user", content: id }],
    }),
  );
  const results = await Promise.all(inputs.map((input) => collect(input, runtime)));
  const output = results.map((events) =>
    JSON.parse(
      events
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ),
  );
  expect(output[0].history).toEqual(inputs[0]!.history);
  expect(output[1].history).toEqual(inputs[1]!.history);
  expect(output[0].home).not.toEqual(output[1].home);
});

it("claims continuation steering once and includes it only in the current user turn", async () => {
  const claimSteering = vi.fn(async () => [
    {
      id: "steering-1",
      messageId: "follow-up",
      text: "Read the second file",
      historyText: "Read the second file",
    },
  ]);
  const events = await collect(
    request({
      prompt: "inspect",
      claimSteering,
      history: [
        { id: "original", role: "user", content: "Read the first file" },
        { id: "answer", role: "assistant", content: "First answer" },
        { id: "follow-up", role: "user", content: "Read the second file" },
      ],
    }),
  );
  const value = JSON.parse(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join(""),
  );
  expect(claimSteering).toHaveBeenCalledExactlyOnceWith([]);
  expect(value.prompt).toBe("inspect\n\nAdditional user context:\nRead the second file");
  expect(value.history).toEqual([
    { role: "user", content: "Read the first file" },
    { role: "assistant", content: "First answer" },
  ]);
});
it("fails before starting the model when claiming steering fails", async () => {
  const executeTool = vi.fn();
  await expect(
    collect(
      request({
        executeTool,
        claimSteering: async () => {
          throw new Error("claim failed");
        },
      }),
    ),
  ).rejects.toThrow("claim failed");
  expect(executeTool).not.toHaveBeenCalled();
});
