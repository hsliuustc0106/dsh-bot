import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { JiuwenSwarmRuntime } from "@rakazo/runtime-jiuwenswarm";
import { describe, expect, it } from "vitest";
import { openProcessModelTransport } from "./process-model-transport.js";

const describePython = process.env.VERIFY_JIUWENSWARM === "1" ? describe : describe.skip;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Cancellation test deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function runtime() {
  return new JiuwenSwarmRuntime(
    {
      pythonPath: process.env.JIUWENSWARM_PYTHON_PATH!,
      sourceDir: process.env.JIUWENSWARM_SOURCE_DIR!,
    },
    undefined,
    openProcessModelTransport,
  );
}
function request(baseUrl: string): AgentRunRequest {
  return {
    runId: "fixture-cancel",
    botId: "fixture-bot",
    threadId: "fixture-thread",
    prompt: "Perform the requested task",
    instructions: "Use only supplied tools",
    history: [],
    tools: [],
    model: {
      provider: "openai-compatible",
      id: "test-model",
      baseUrl,
      maxTokens: 64,
      contextWindow: 32768,
    },
  };
}

describePython("real Python cancellation boundaries", () => {
  it.each(["signal", "abort", "disconnect"] as const)(
    "closes an outstanding model stream on %s",
    async (method) => {
      const received = deferred<void>();
      const disconnected = deferred<void>();
      let calls = 0;
      const server = createServer((req, res) => {
        req.resume();
        calls++;
        res.on("close", () => disconnected.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": waiting\n\n");
        received.resolve();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test endpoint unavailable");
      const controller = new AbortController();
      const agent = runtime();
      const iterator = agent.run(request(`http://127.0.0.1:${address.port}/v1`), {
        signal: controller.signal,
      });
      const events: AgentRuntimeEvent[] = [];
      const consuming = (async () => {
        for await (const event of iterator) events.push(event);
      })();
      try {
        await within(received.promise, 30_000);
        const stopped = performance.now();
        if (method === "signal") controller.abort();
        if (method === "abort") await within(agent.abort("fixture-cancel"), 5_000);
        if (method === "disconnect") await within(iterator.return!(), 5_000);
        await within(Promise.all([consuming, disconnected.promise]), 5_000);
        expect(performance.now() - stopped).toBeLessThan(5_000);
        expect(events.some((event) => event.type === "done")).toBe(false);
        expect(calls).toBe(1);
      } finally {
        controller.abort();
        await within(
          consuming.catch(() => undefined),
          5_000,
        );
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
    45_000,
  );

  it("stops without treating an outstanding host action as stopped or replaying it", async () => {
    const entered = deferred<void>();
    const remote = deferred<unknown>();
    const audited = deferred<void>();
    let calls = 0;
    let executions = 0;
    let effects = 0;
    const server = createServer((req, res) => {
      void (async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        calls++;
        const delta = {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "fixture-action",
              type: "function",
              function: { name: body.tools[0].function.name, arguments: "{}" },
            },
          ],
        };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [part, finish] of [
          [delta, null],
          [{}, "tool_calls"],
        ])
          res.write(
            `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: part, finish_reason: finish }] })}\n\n`,
          );
        res.end("data: [DONE]\n\n");
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test endpoint unavailable");
    const controller = new AbortController();
    const agent = runtime();
    const events: AgentRuntimeEvent[] = [];
    const consuming = (async () => {
      for await (const event of agent.run(
        {
          ...request(`http://127.0.0.1:${address.port}/v1`),
          tools: [
            {
              name: "fixture_action",
              description: "Perform a fixture action",
              inputSchema: { type: "object" },
              route: { connectorId: "fixture", resourceId: "fixture", toolName: "action" },
            },
          ],
          executeTool: async () => {
            executions++;
            entered.resolve();
            await remote.promise;
            effects++;
            return { ok: true };
          },
          onToolCompleted: () => {
            audited.resolve();
          },
        },
        { signal: controller.signal },
      ))
        events.push(event);
    })();
    try {
      await within(entered.promise, 30_000);
      controller.abort();
      await within(consuming, 5_000);
      expect(effects).toBe(0);
      expect(events.some((event) => event.type === "done")).toBe(false);
      remote.resolve(undefined);
      await within(audited.promise, 5_000);
      expect(effects).toBe(1);
      expect(executions).toBe(1);
      expect(calls).toBe(1);
      expect(events.some((event) => event.type === "done")).toBe(false);
    } finally {
      controller.abort();
      remote.resolve(undefined);
      await within(
        consuming.catch(() => undefined),
        5_000,
      );
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }, 45_000);
});
