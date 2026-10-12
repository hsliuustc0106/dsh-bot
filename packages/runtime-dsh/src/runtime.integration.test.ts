import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { expect, it, vi } from "vitest";
import { DshAgentRuntime } from "./runtime.js";

const cliPath = process.env.DSH_TEST_CLI_PATH;
it.skipIf(!cliPath)(
  "preserves two-turn roles without replaying historical tool text",
  async () => {
    const bodies: Record<string, unknown>[] = [];
    const historical = '{"type":"tool_call","name":"read_file","args":{"path":"old.txt"}}';
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (value: Record<string, unknown>) =>
        res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
      const tool = bodies.length === 2;
      send({
        type: "message_start",
        message: {
          id: `m-${bodies.length}`,
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      });
      send({
        type: "content_block_start",
        index: 0,
        content_block: tool
          ? { type: "tool_use", id: "new-read", name: "read_file", input: {} }
          : { type: "text", text: "" },
      });
      send({
        type: "content_block_delta",
        index: 0,
        delta: tool
          ? { type: "input_json_delta", partial_json: '{"path":"README.md"}' }
          : {
              type: "text_delta",
              text: bodies.length === 1 ? historical : "Repository inspected.",
            },
      });
      send({ type: "content_block_stop", index: 0 });
      send({
        type: "message_delta",
        delta: { stop_reason: tool ? "tool_use" : "end_turn" },
        usage: { output_tokens: 3 },
      });
      send({ type: "message_stop" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const runtime = new DshAgentRuntime({ cliPath: cliPath! });
      const executeTool = vi.fn(async () => ({ content: "# Example repository" }));
      const onUsage = vi.fn();
      const base: AgentRunRequest = {
        botId: "bot",
        threadId: "thread",
        runId: "first",
        prompt: "Quote a tool call as text",
        instructions: "Current {{literal}} instructions",
        history: [{ role: "system", content: "Historical system instruction" }],
        model: {
          provider: "deepseek",
          id: "fixture-model",
          apiKey: "test-placeholder",
          thinkingLevel: "off",
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        tools: [
          {
            name: "read_file",
            description: "Read a repository file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
        executeTool,
        onUsage,
      };
      const collect = async (request: AgentRunRequest) => {
        const events: AgentRuntimeEvent[] = [];
        for await (const event of runtime.run(request, { signal: controller.signal }))
          events.push(event);
        return events;
      };
      expect((await collect(base)).at(-1)).toMatchObject({ type: "done", text: historical });
      expect(executeTool).not.toHaveBeenCalled();
      const events = await collect({
        ...base,
        runId: "second",
        prompt: "Read README.md",
        history: [
          ...base.history,
          { role: "user", content: base.prompt },
          { role: "assistant", content: historical },
        ],
      });
      expect(events.at(-1)).toMatchObject({ type: "done", text: "Repository inspected." });
      expect(executeTool).toHaveBeenCalledExactlyOnceWith(
        "read_file",
        { path: "README.md" },
        expect.stringMatching(/^second:dsh:/),
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(onUsage).toHaveBeenCalledTimes(3);
      expect(bodies).toHaveLength(3);
      const second = bodies[1]!;
      expect(JSON.stringify(second.system)).toContain("Historical system instruction");
      expect(JSON.stringify(second.system)).toContain("Current {{literal}} instructions");
      expect(second.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: base.prompt }),
            ]),
          }),
          expect.objectContaining({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: historical }),
            ]),
          }),
        ]),
      );
      expect(JSON.stringify(bodies[2])).toContain("# Example repository");
    } finally {
      clearTimeout(timeout);
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  25_000,
);
