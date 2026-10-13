import { createServer } from "node:http";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { JiuwenSwarmRuntime } from "@rakazo/runtime-jiuwenswarm";
import { describe, expect, it } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";
import { openProcessModelTransport } from "./process-model-transport.js";

const describePython = process.env.VERIFY_JIUWENSWARM === "1" ? describe : describe.skip;

describePython.each(["jiuwenswarm", "pi"] as const)(
  "%s reasoning protocol against a local model emulator",
  (backend) => {
    it.each([undefined, null, "off", "low", "medium", "high", "xhigh", "max", "minimal"] as const)(
      "records the actual wire setting for requested reasoning %s",
      async (thinkingLevel) => {
        const received: Array<{
          model: string;
          messages: unknown[];
          max_tokens?: number;
          max_completion_tokens?: number;
          reasoning_effort?: string;
        }> = [];
        const server = createServer((req, res) => {
          void (async () => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const request = JSON.parse(Buffer.concat(chunks).toString());
            received.push(request);
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const [delta, finish_reason] of [
              [{ role: "assistant" }, null],
              [{ content: "fixture-answer" }, null],
              [{}, "stop"],
            ])
              res.write(
                `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
              );
            res.write(
              `data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", created: 1, model: request.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`,
            );
            res.end("data: [DONE]\n\n");
          })();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("test endpoint unavailable");
        try {
          const runtime =
            backend === "pi"
              ? new PiAgentRuntime()
              : new JiuwenSwarmRuntime(
                  {
                    pythonPath: process.env.JIUWENSWARM_PYTHON_PATH!,
                    sourceDir: process.env.JIUWENSWARM_SOURCE_DIR!,
                  },
                  undefined,
                  openProcessModelTransport,
                );
          const request: AgentRunRequest = {
            runId: "fixture-run",
            botId: "fixture-bot",
            threadId: "fixture-thread",
            prompt: "Say fixture-answer",
            instructions: "Reply briefly.",
            history: [],
            tools: [],
            model: {
              provider: "openai-compatible",
              id: "test-model",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              maxTokens: 64,
              contextWindow: 32768,
              reasoning: thinkingLevel !== undefined,
              thinkingLevel,
            },
          };
          const events: AgentRuntimeEvent[] = [];
          for await (const event of runtime.run(request, { signal: AbortSignal.timeout(50_000) }))
            events.push(event);
          expect(events).toContainEqual({ type: "done", text: "fixture-answer" });
          expect(received).toHaveLength(1);
          expect(received[0]?.model).toBe("test-model");
          expect(received[0]?.max_tokens ?? received[0]?.max_completion_tokens).toBe(64);
          // Pi's generic compatible model clamps these two settings. A pilot must
          // compare the actual wire value, never treat the requested labels as parity.
          const expected =
            backend === "pi" && (thinkingLevel === "xhigh" || thinkingLevel === "max")
              ? "high"
              : thinkingLevel === "off"
                ? "none"
                : thinkingLevel === null
                  ? "medium"
                  : thinkingLevel;
          expect(received[0]?.reasoning_effort).toBe(expected);
        } finally {
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          });
        }
      },
      60_000,
    );
  },
);

describePython("pinned Python host-tool round trip", () => {
  it.each(["success", "uncertain", "approval", "secret", "question"] as const)(
    "preserves host outcome %s",
    async (outcome) => {
      const uncertain = outcome === "uncertain";
      const paused = ["approval", "secret", "question"].includes(outcome);
      let modelCalls = 0;
      const executed: unknown[][] = [];
      const audits: unknown[] = [];
      const toolMessages: unknown[] = [];
      const server = createServer((req, res) => {
        void (async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString());
          modelCalls++;
          const first = modelCalls === 1;
          toolMessages.push(
            ...body.messages.filter((message: { role: string }) => message.role === "tool"),
          );
          const delta = first
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "fixture-tool-call",
                    type: "function",
                    function: {
                      name: body.tools[0].function.name,
                      arguments: JSON.stringify(
                        outcome === "question"
                          ? { question: "Which fixture?", options: ["First", "Second"] }
                          : { path: "fixture.txt" },
                      ),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "fixture-answer" };
          res.writeHead(200, { "content-type": "text/event-stream" });
          for (const [part, finish] of [
            [delta, null],
            [{}, first ? "tool_calls" : "stop"],
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
      try {
        const runtime = new JiuwenSwarmRuntime(
          {
            pythonPath: process.env.JIUWENSWARM_PYTHON_PATH!,
            sourceDir: process.env.JIUWENSWARM_SOURCE_DIR!,
          },
          undefined,
          openProcessModelTransport,
        );
        const route = {
          connectorId: "fixture-connector",
          resourceId: "fixture-files",
          toolName: "read",
        };
        const events: AgentRuntimeEvent[] = [];
        const collect = async () => {
          for await (const event of runtime.run(
            {
              runId: "fixture-run",
              botId: "fixture-bot",
              threadId: "fixture-thread",
              prompt: "Read fixture.txt",
              instructions: "Use the supplied file reader.",
              history: [],
              model: {
                provider: "openai-compatible",
                id: "test-model",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                maxTokens: 256,
                contextWindow: 32768,
              },
              tools: [
                {
                  name: outcome === "question" ? "ask_user" : "files.read",
                  description: "Read a fixture file",
                  inputSchema: {
                    type: "object",
                    properties:
                      outcome === "question"
                        ? {
                            question: { type: "string" },
                            options: { type: "array", items: { type: "string" } },
                          }
                        : { path: { type: "string" } },
                    required: outcome === "question" ? ["question", "options"] : ["path"],
                  },
                  ...(outcome === "question" ? {} : { route }),
                },
              ],
              executeTool: async (...args) => {
                executed.push(args);
                if (uncertain) throw new Error("Fixture outcome is uncertain");
                if (outcome === "approval" || outcome === "secret")
                  return {
                    kind: "agent_tool_result",
                    content: [],
                    details: { [outcome]: "paused" },
                    terminate: true,
                  };
                return { content: "fixture-file-content" };
              },
              onToolCompleted: (completion) => {
                audits.push(completion);
              },
            },
            { signal: AbortSignal.timeout(50_000) },
          ))
            events.push(event);
        };
        if (uncertain) await expect(collect()).rejects.toThrow("host callback failed");
        else await collect();
        expect(executed).toHaveLength(outcome === "question" ? 0 : 1);
        if (outcome !== "question")
          expect(executed[0]).toEqual([
            "files.read",
            { path: "fixture.txt" },
            expect.any(String),
            route,
            { signal: expect.any(AbortSignal) },
          ]);
        if (paused) {
          expect(modelCalls).toBe(1);
          expect(events.some((event) => event.type === "done")).toBe(false);
          expect(audits).toEqual([expect.objectContaining({ paused: true })]);
          if (outcome === "question")
            expect(events).toContainEqual({
              type: "ask",
              text: "Which fixture?",
              actions: [
                { id: "choice-1", label: "First" },
                { id: "choice-2", label: "Second" },
              ],
            });
        } else if (uncertain) {
          expect(modelCalls).toBe(1);
          expect(events.some((event) => event.type === "done")).toBe(false);
          expect(audits).toEqual([
            expect.objectContaining({ name: "files.read", error: expect.any(Error) }),
          ]);
        } else {
          expect(modelCalls).toBe(2);
          expect(JSON.stringify(toolMessages)).toContain("fixture-file-content");
          expect(audits).toHaveLength(1);
          expect(events).toContainEqual({ type: "done", text: "fixture-answer" });
        }
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    },
    60_000,
  );
});
