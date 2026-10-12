import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import type { DshEvent, DshTask } from "./bridge.js";
import { DshBridge } from "./bridge.js";

const cliPath = process.env.DSH_TEST_CLI_PATH;
for (const scenario of ["echo", "unexpected"] as const) {
  it.skipIf(!cliPath)(`pinned DSH with a fake model: ${scenario}`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: DshEvent[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Record<string, unknown>) =>
        response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({
        type: "message_start",
        message: {
          id: `message-${bodies.length}`,
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      });
      if (bodies.length === 1) {
        send({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "echo-1",
            name: scenario === "echo" ? "echo" : "shell",
            input: {},
          },
        });
        send({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"text":"harmless example"}' },
        });
      } else {
        send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Echo complete." },
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
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const task: DshTask = {
        prompt: "Echo the harmless example using the supplied tool.",
        instructions: "Only use explicitly provided tools. Preserve {{literal}} instructions.",
        connection: {
          apiKey: "test-placeholder",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        model: { id: "fixture-model", thinkingLevel: "off", maxTokens: 128 },
        tools: [
          {
            name: "echo",
            description: "Return input unchanged",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      };
      const executeTool = vi.fn(async (call) => ({ text: call.args.text }));
      const result = new DshBridge({ cliPath: cliPath! }).run(task, {
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
        },
        executeTool,
      });
      if (scenario === "unexpected") {
        await expect(result).rejects.toMatchObject({ code: "UNEXPECTED_TOOL" });
        expect(executeTool).not.toHaveBeenCalled();
        expect(bodies).toHaveLength(1);
      } else {
        expect(await result).toBe("completed");
        expect(executeTool).toHaveBeenCalledOnce();
        expect(events.at(-1)?.type).toBe("done");
        expect(
          events
            .filter((event) => event.type === "text")
            .map((event) => event.text)
            .join(""),
        ).toBe("Echo complete.");
        expect(events.filter((event) => event.type === "usage")).toHaveLength(2);
        expect(bodies).toHaveLength(2);
        expect(JSON.stringify(bodies[1])).toContain("harmless example");
      }
      expect(events[0]?.type).toBe("started");
      expect(bodies[0]?.tools).toEqual([
        {
          name: "echo",
          description: "Return input unchanged",
          input_schema: task.tools[0]!.inputSchema,
        },
      ]);
      expect(JSON.stringify(bodies[0])).toContain("{{literal}}");
    } finally {
      clearTimeout(timeout);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
