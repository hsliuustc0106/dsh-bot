import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { DshAgentRuntime } from "@rakazo/runtime-dsh";
import { expect, it, vi } from "vitest";
import { PiAgentRuntime } from "./pi-runtime.js";

// Explicit installation only; normal tests never download or execute DSH.
const cliPath = process.env.DSH_TEST_CLI_PATH;
for (const harness of ["pi", "dsh"] as const) {
  for (const scenario of ["read", "denied", "unavailable", "cancel"] as const) {
    it.skipIf(harness === "dsh" && !cliPath)(
      `${harness}: ${scenario} through Rakazo's runtime boundary`,
      async () => {
        const finalText = scenario === "read" ? "Read complete." : "Read denied.";
        const toolName = scenario === "unavailable" ? "shell" : "read_file";
        const bodies: Record<string, unknown>[] = [];
        const server = createServer(async (request, response) => {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
          response.writeHead(200, { "content-type": "text/event-stream" });
          if (request.url?.endsWith("/chat/completions")) {
            const send = (delta: unknown, finish_reason: string | null = null) =>
              response.write(
                `data: ${JSON.stringify({ id: `message-${bodies.length}`, object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}) })}\n\n`,
              );
            if (scenario === "cancel") {
              send({ role: "assistant", content: "Working" });
              return;
            }
            if (bodies.length === 1)
              send(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "read-1",
                      type: "function",
                      function: { name: toolName, arguments: '{"path":"example.txt"}' },
                    },
                  ],
                },
                "tool_calls",
              );
            else send({ role: "assistant", content: finalText }, "stop");
            response.end("data: [DONE]\n\n");
            return;
          }
          const send = (event: Record<string, unknown>) =>
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          send({
            type: "message_start",
            message: {
              id: `message-${bodies.length}`,
              type: "message",
              role: "assistant",
              model: "deepseek-flash",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          });
          if (scenario === "cancel") {
            send({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
            send({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Working" },
            });
            return;
          }
          if (bodies.length === 1) {
            send({
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "read-1", name: toolName, input: {} },
            });
            send({
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"path":"example.txt"}' },
            });
          } else {
            send({
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            });
            send({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: finalText },
            });
          }
          send({ type: "content_block_stop", index: 0 });
          send({
            type: "message_delta",
            delta: { stop_reason: bodies.length === 1 ? "tool_use" : "end_turn" },
            usage: { output_tokens: 3 },
          });
          send({ type: "message_stop" });
          response.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25_000);
        const originalFetch = globalThis.fetch;
        const fetchGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.hostname !== "127.0.0.1")
            throw new Error("Non-local model request blocked by test");
          return originalFetch(input, init);
        });
        try {
          const executeTool = vi.fn().mockResolvedValue({ content: "example data" });
          if (scenario === "denied") executeTool.mockRejectedValue(new Error("Permission denied"));
          const onUsage = vi.fn();
          const runtime =
            harness === "dsh" ? new DshAgentRuntime({ cliPath: cliPath! }) : new PiAgentRuntime();
          const events: AgentRuntimeEvent[] = [];
          try {
            for await (const event of runtime.run(
              {
                botId: "bot",
                threadId: "thread",
                runId: "run",
                prompt: "Read example.txt",
                instructions: "Use the supplied tools. Keep {{literal}} text.",
                history: [{ role: "user", content: "Earlier context" }],
                model: {
                  provider: harness === "pi" ? "openai-compatible" : "deepseek",
                  id: "deepseek-flash",
                  apiKey: "test-placeholder",
                  baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
                  thinkingLevel: "off",
                },
                tools: [
                  {
                    name: "read_file",
                    description: "Read a file",
                    inputSchema: {
                      type: "object",
                      properties: { path: { type: "string" } },
                      required: ["path"],
                    },
                  },
                ],
                executeTool,
                onUsage,
              },
              { signal: controller.signal },
            )) {
              events.push(event);
              if (scenario === "cancel" && event.type === "text") controller.abort();
            }
          } catch (error) {
            // Pi reports an interrupted request as an error; DSH closes its
            // stream. Both must stop the in-flight model request and tool work.
            if (harness === "dsh" && scenario === "unavailable") {
              expect(String(error)).toContain("UNEXPECTED_TOOL");
              expect(executeTool).not.toHaveBeenCalled();
              expect(bodies).toHaveLength(1);
              return;
            }
            expect(scenario).toBe("cancel");
            expect(controller.signal.aborted).toBe(true);
            expect(String(error)).toMatch(/aborted/i);
          }
          if (scenario === "cancel") {
            expect(events).toContainEqual({ type: "text", text: "Working" });
            expect(executeTool).not.toHaveBeenCalled();
            expect(bodies).toHaveLength(1);
            return;
          }
          expect(events.at(-1)).toMatchObject({ type: "done" });
          expect(events).toContainEqual({ type: "text", text: finalText });
          expect(executeTool).toHaveBeenCalledTimes(scenario === "unavailable" ? 0 : 1);
          expect(onUsage).toHaveBeenCalledTimes(2);
          expect(bodies).toHaveLength(2);
          expect(JSON.stringify(bodies[0])).toContain("{{literal}}");
          expect(JSON.stringify(bodies[0])).toContain("Earlier context");
          if (scenario === "read") expect(JSON.stringify(bodies[1])).toContain("example data");
          if (scenario === "denied") expect(JSON.stringify(bodies[1])).toMatch(/denied/i);
        } finally {
          fetchGuard.mockRestore();
          clearTimeout(timeout);
          controller.abort();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
}
