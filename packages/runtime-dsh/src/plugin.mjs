import { isDeepStrictEqual } from "node:util";
import { frames } from "./frames.mjs";
import { historySeed, systemInstructions } from "./history.mjs";
import { DSH_VERSION, hostMessage, MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./protocol.mjs";

export const name = "rakazo-dsh-bridge";
export const inject = ["agents", "agentLoop", "tools", "systemPrompt", "llm", "sessionProjections"];

export function apply(ctx) {
  const sessionId = process.env.RAKAZO_RUN_ID;
  let sent = 0;
  let received = 0;
  let state = "ready";
  let handle;
  let task;
  const pending = new Map();
  const seen = new Set();
  const send = (message) => {
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, sessionId, seq: sent++, ...message });
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error("DSH frame limit");
    process.stdout.write(`${frame}\n`);
  };
  const cancel = () => {
    state = "stopping";
    handle?.agent.cancel({ kind: "user" });
    for (const value of pending.values()) value.reject(new Error("Run cancelled"));
    pending.clear();
  };
  const fail = (code) => {
    if (state === "failed") return;
    cancel();
    state = "failed";
    send({ type: "error", code });
  };
  const schemas = () =>
    handle.agent.ctx.tools
      .schemas(handle.agent)
      .map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const exactTools = () =>
    isDeepStrictEqual(
      schemas(),
      [...task.tools].sort((a, b) => a.name.localeCompare(b.name)),
    );

  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    if (agent !== handle?.agent || frame.type !== "chunk") return;
    if (frame.chunk.type === "text-delta" && state === "running")
      send({ type: "text", text: frame.chunk.text });
    if (frame.chunk.type === "usage")
      send({ type: "usage", callId: String(frame.attemptId), usage: frame.chunk.usage });
  });
  ctx.on("session/event", (session, event) => {
    if (session !== handle?.agent.session) return;
    if (event.type === "tool/call" && !task.tools.some((tool) => tool.name === event.data.name)) {
      fail("TOOL_UNAVAILABLE");
    }
    if (event.type !== "turn/end" || state !== "running") return;
    if (event.data.reason.kind !== "completed") return fail("EXECUTION");
    state = "done";
    send({ type: "done" });
  });
  ctx.on("agent/error", ({ agent }) => {
    if (agent === handle?.agent && state === "running") fail("EXECUTION");
  });
  ctx.on("tools/change", () => {
    if (handle && state === "running" && !exactTools()) fail("TOOL_SET");
  });

  async function configure(message) {
    if (state !== "ready") throw new Error();
    state = "configuring";
    task = message;
    if (new Set(task.tools.map((tool) => tool.name)).size !== task.tools.length) throw new Error();
    handle = await ctx.agents.create({
      sessionId,
      seed: historySeed(task.history, sessionId),
      agentOptions: {
        provider: "deepseek-official",
        model: task.model.id,
        ...(task.model.maxTokens ? { maxTokens: task.model.maxTokens } : {}),
        ...(task.model.thinkingLevel ? { reasoningEffort: task.model.thinkingLevel } : {}),
      },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({
          name: "rakazo",
          order: 0,
          text: systemInstructions(task.instructions, task.history),
          complete: true,
          interpolate: false,
        });
        agentCtx.tools.guard((exec) =>
          state !== "running" || !task.tools.some((tool) => tool.name === exec.name)
            ? "Tool unavailable"
            : undefined,
        );
        for (const tool of task.tools) {
          agentCtx.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
            output: {
              schema: {},
              render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            execute(args, exec) {
              exec.signal.throwIfAborted();
              if (state !== "running" || !exactTools()) throw new Error("Tool unavailable");
              const callId = String(exec.callId);
              if (seen.has(callId)) {
                fail("PROTOCOL");
                throw new Error("Duplicate call");
              }
              seen.add(callId);
              if (seen.size > 64) {
                fail("LIMIT");
                throw new Error("Tool limit");
              }
              return new Promise((resolve, reject) => {
                const abort = () => {
                  pending.delete(callId);
                  reject(new Error("Run cancelled"));
                };
                exec.signal.addEventListener("abort", abort, { once: true });
                const settle = (callback) => (value) => {
                  exec.signal.removeEventListener("abort", abort);
                  callback(value);
                };
                pending.set(callId, { resolve: settle(resolve), reject: settle(reject) });
                send({ type: "tool", name: tool.name, args, callId });
              });
            },
          });
        }
      },
    });
    if (!exactTools()) return fail("TOOL_SET");
    state = "configured";
    send({ type: "configured", tools: schemas() });
  }

  const work = (async () => {
    try {
      for await (const line of frames(process.stdin)) {
        const message = hostMessage.parse(JSON.parse(line));
        if (message.sessionId !== sessionId || message.seq !== received++) throw new Error();
        if (message.type === "cancel") {
          cancel();
          await handle?.agent.whenIdle();
          send({ type: "cancelled" });
        } else if (message.type === "configure") await configure(message);
        else if (message.type === "proceed") {
          if (state !== "configured" || !exactTools()) return fail("TOOL_SET");
          state = "running";
          send({ type: "started" });
          handle.agent.followup({
            id: sessionId,
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: task.prompt }],
          });
        } else if (message.type === "tool-result") {
          if (state === "stopping" || state === "failed") continue;
          const entry = pending.get(message.callId);
          if (state !== "running" || !entry) throw new Error();
          pending.delete(message.callId);
          if (message.error) entry.reject(new Error("Rakazo denied or failed the tool call"));
          else entry.resolve(message.result);
        }
      }
    } catch {
      fail("PROTOCOL");
    } finally {
      cancel();
      await handle?.dispose();
    }
  })();
  ctx.effect(() => async () => {
    cancel();
    process.stdin.destroy();
    await work;
  });
  send({ type: "ready", runtimeVersion: DSH_VERSION });
}
