import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Deliberately scripted model: validates driver wiring, never measures model quality. */
export async function startPilotEmulator() {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const text = JSON.stringify(body.messages);
    const task = text.includes("Change settings.json so")
      ? "change"
      : text.includes("Review patch.diff")
        ? "review"
        : "answer";
    const results = body.messages.flatMap((message: { role: string; content: unknown }) =>
      message.role === "tool"
        ? [message]
        : Array.isArray(message.content)
          ? message.content.filter((part: { type?: string }) => part.type === "tool_result")
          : [],
    );
    const plans = {
      answer: [{ name: "read_file", args: { path: "README.md" } }],
      review: [
        { name: "read_file", args: { path: "patch.diff" } },
        { name: "read_file", args: { path: "paginate.mjs" } },
      ],
      change: [
        { name: "read_file", args: { path: "settings.json" } },
        {
          name: "write_file",
          args: { path: "settings.json", content: '{"maxItems":10,"theme":"system"}\n' },
        },
        { name: "run_tests", args: {} },
      ],
    };
    const call = plans[task][results.length];
    const answer =
      task === "answer"
        ? "CACHE_TTL_SECONDS defaults to 120 seconds (README.md:3-4)."
        : task === "review"
          ? "paginate.mjs:3 uses ||, so zero selects 10. Use nullish ?? to preserve a zero limit."
          : "Updated settings.json; the supplied tests passed.";
    const id = `fixture-${results.length}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (request.url?.includes("chat/completions")) {
      const delta = call
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          }
        : { role: "assistant", content: answer };
      response.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const send = (event: Record<string, unknown>) =>
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "fixture-model",
        content: [],
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    });
    send({
      type: "content_block_start",
      index: 0,
      content_block: call
        ? { type: "tool_use", id, name: call.name, input: {} }
        : { type: "text", text: "" },
    });
    send({
      type: "content_block_delta",
      index: 0,
      delta: call
        ? { type: "input_json_delta", partial_json: JSON.stringify(call.args) }
        : { type: "text_delta", text: answer },
    });
    send({ type: "content_block_stop", index: 0 });
    send({
      type: "message_delta",
      delta: { stop_reason: call ? "tool_use" : "end_turn" },
      usage: { output_tokens: 10 },
    });
    send({ type: "message_stop" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
