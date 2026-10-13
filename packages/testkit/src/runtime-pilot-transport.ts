import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** Pilot-only DeepSeek protocol boundary. Never forwards an unbudgeted HTTP attempt. */
export async function startPilotTransport(options: {
  protocol: "chat" | "messages";
  baseUrl: string;
  apiKey: string;
  modelId: string;
  signal: AbortSignal;
  beforeDispatch: () => void;
}) {
  const credential = randomUUID();
  const suffix = options.protocol === "chat" ? "/chat/completions" : "/v1/messages";
  const base = options.baseUrl.replace(/\/+$/, "");
  const upstream = `${base}${options.protocol === "messages" && new URL(base).pathname.endsWith("/v1") ? "/messages" : suffix}`;
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== (options.protocol === "chat" ? "/v1/chat/completions" : suffix) ||
        (request.headers.authorization !== `Bearer ${credential}` &&
          request.headers["x-api-key"] !== credential)
      ) {
        response.writeHead(403).end();
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) throw new Error("Oversized pilot request");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.model !== options.modelId || body.stream !== true)
        throw new Error("Unexpected pilot request");
      // Check the actual serialized controls, not just AgentRunModel intent.
      // DeepSeek documents reasoning_effort=none as equivalent to disabled thinking.
      if (
        options.protocol === "chat"
          ? body.reasoning_effort !== "none"
          : body.thinking?.type !== "disabled"
      )
        throw new Error("Unverified pilot thinking mode");
      options.signal.throwIfAborted();
      options.beforeDispatch();
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.protocol === "chat") headers.authorization = `Bearer ${options.apiKey}`;
      else {
        headers["x-api-key"] = options.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      }
      const upstreamResponse = await fetch(upstream, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
        redirect: "error",
      });
      if (!upstreamResponse.ok || !upstreamResponse.body)
        throw new Error("Pilot model request failed");
      response.writeHead(200, { "content-type": "text/event-stream" });
      for await (const chunk of upstreamResponse.body) response.write(chunk);
      response.end();
    } catch {
      // Do not expose provider errors, credentials or destinations to the harness.
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Pilot request rejected" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: credential,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
