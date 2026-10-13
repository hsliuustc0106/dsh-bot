import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { processReasoningEffort } from "@rakazo/runtime-jiuwenswarm";
import {
  assertAllowedOpenAiCompatibleUrl,
  assertHttpsForKeyedOpenAiCompatibleUrl,
} from "./openai-compatible-url.js";
import { createOpenAiCompatibleFetch } from "./pi-openai-compatible-provider.js";

/** Bind a process to one approved model endpoint; it never receives the real credential. */
export const openProcessModelTransport = async (
  model: AgentRunModel,
  signal: AbortSignal,
  maxCalls: number,
  inspect?: (settings: {
    model: string;
    reasoningEffort?: string;
    maxOutputTokens: number | null;
  }) => void,
) => {
  signal.throwIfAborted();
  const reasoningEffort = processReasoningEffort(model);
  const official =
    model.provider === "openai" &&
    (!model.baseUrl || model.baseUrl === "https://api.openai.com/v1");
  const endpoint = official
    ? new URL("https://api.openai.com/v1")
    : assertAllowedOpenAiCompatibleUrl(model.baseUrl ?? "");
  assertHttpsForKeyedOpenAiCompatibleUrl(endpoint, model.apiKey);
  const fetchModel = createOpenAiCompatibleFetch(
    undefined,
    undefined,
    official ? { allowPublic: true } : undefined,
  );
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error("Invalid model call limit");
  const token = randomBytes(32).toString("hex");
  const shutdown = new AbortController();
  const lifecycle = AbortSignal.any([signal, shutdown.signal]);
  let calls = 0;
  const server = createServer((request, response) => {
    const disconnected = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) disconnected.abort();
    });
    const requestSignal = AbortSignal.any([lifecycle, disconnected.signal]);
    void (async () => {
      if (
        request.method !== "POST" ||
        request.url !== "/v1/chat/completions" ||
        request.headers.authorization !== `Bearer ${token}`
      ) {
        response.writeHead(403).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error("Model request too large");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        body.model !== model.id ||
        !Array.isArray(body.messages)
      )
        throw new Error("Invalid model request");
      if (body.reasoning_effort !== reasoningEffort)
        throw new Error("Model reasoning settings do not match the connection");
      if (calls >= maxCalls) {
        response.writeHead(429, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { message: "Model call limit reached", type: "budget_exceeded" },
          }),
        );
        return;
      }
      // Do not refund failed calls: a lost response does not prove zero model usage.
      requestSignal.throwIfAborted();
      inspect?.({
        model: body.model,
        reasoningEffort: body.reasoning_effort,
        maxOutputTokens: body.max_completion_tokens ?? body.max_tokens ?? null,
      });
      calls++;
      if (model.maxTokens != null) {
        if ("max_completion_tokens" in body) body.max_completion_tokens = model.maxTokens;
        else body.max_tokens = model.maxTokens;
      }
      const upstream = await fetchModel(
        `${endpoint.toString().replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(model.apiKey ? { authorization: `Bearer ${model.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        },
      );
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        const stream = Readable.from(
          (async function* () {
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) return;
                yield chunk.value;
              }
            } finally {
              await reader.cancel().catch(() => undefined);
            }
          })(),
        );
        await pipeline(stream, response, { signal: requestSignal });
      } else response.end();
    })().catch(() => {
      if (response.headersSent) response.destroy();
      else
        response
          .writeHead(502, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "Model transport failed" } }));
    });
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      shutdown.abort();
      signal.removeEventListener("abort", aborted);
      server.close(() => resolve());
      server.closeAllConnections();
    }));
  const aborted = () => {
    void close();
  };
  signal.addEventListener("abort", aborted, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Model transport did not listen");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: token, close };
};
