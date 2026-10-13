import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AgentRunModel } from "@rakazo/adapter-kit";
import { afterEach, expect, it, vi } from "vitest";
import { openProcessModelTransport } from "./process-model-transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
async function endpoint(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not listen");
  return `http://127.0.0.1:${address.port}/v1`;
}
const model = (baseUrl: string): AgentRunModel => ({
  provider: "openai-compatible",
  id: "test-model",
  baseUrl,
  apiKey: "fake-upstream-key",
  maxTokens: 8,
});
async function open(baseUrl: string, maxCalls = 1, signal = new AbortController().signal) {
  const transport = await openProcessModelTransport(model(baseUrl), signal, maxCalls);
  cleanup.push(transport.close);
  return transport;
}
const body = {
  model: "test-model",
  messages: [{ role: "user", content: "Test" }],
  stream: false,
  max_tokens: 500,
};
function call(
  transport: Awaited<ReturnType<typeof open>>,
  overrides: Record<string, unknown> = {},
) {
  return fetch(`${transport.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${transport.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body, ...overrides }),
  });
}

it("keeps real credentials host-side and enforces output and model-call limits", async () => {
  const received: Array<{ authorization: string | undefined; body: typeof body }> = [];
  const baseUrl = await endpoint((req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({
        authorization: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    })();
  });
  const transport = await open(baseUrl);
  expect(transport.apiKey).not.toBe("fake-upstream-key");
  expect((await call(transport)).status).toBe(200);
  expect((await call(transport)).status).toBe(429);
  expect(received).toEqual([
    { authorization: "Bearer fake-upstream-key", body: { ...body, max_tokens: 8 } },
  ]);
});

it("refuses unauthorized paths and model substitutions without forwarding", async () => {
  const forwarded = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
  const transport = await open(await endpoint(forwarded));
  expect(
    (
      await fetch(`${transport.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify(body),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${transport.baseUrl}/models`, {
        headers: { authorization: `Bearer ${transport.apiKey}` },
      })
    ).status,
  ).toBe(403);
  expect((await call(transport, { model: "other-model" })).status).toBe(502);
  expect(forwarded).not.toHaveBeenCalled();
});

it("uses the existing metadata, public-host and credential URL policy", async () => {
  vi.stubEnv("RAKAZO_OPENAI_COMPAT_ALLOW_PUBLIC", "0");
  for (const url of [
    "http://169.254.169.254/v1",
    "http://metadata.google.internal/v1",
    "https://example.test/v1",
    "http://user:password@127.0.0.1/v1",
  ])
    await expect(open(url)).rejects.toThrow();
});

it("refuses missing or altered reasoning settings before forwarding", async () => {
  const forwarded = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
  const baseUrl = await endpoint(forwarded);
  const transport = await openProcessModelTransport(
    { ...model(baseUrl), reasoning: true, thinkingLevel: "high" },
    new AbortController().signal,
    1,
  );
  cleanup.push(transport.close);
  expect((await call(transport)).status).toBe(502);
  expect((await call(transport, { reasoning_effort: "low" })).status).toBe(502);
  expect(forwarded).not.toHaveBeenCalled();
  expect((await call(transport, { reasoning_effort: "high" })).status).toBe(200);
  expect(forwarded).toHaveBeenCalledOnce();
});

it("does not follow redirects from a local endpoint", async () => {
  const redirected = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
  const destination = await endpoint(redirected);
  const transport = await open(
    await endpoint((_req, res) =>
      res.writeHead(307, { location: `${destination}/chat/completions` }).end(),
    ),
  );
  expect((await call(transport)).status).toBe(502);
  expect(redirected).not.toHaveBeenCalled();
});

it("streams model output and aborts the outstanding request on cancellation", async () => {
  const controller = new AbortController();
  const transport = await open(
    await endpoint((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"delta":"hello"}\n\n');
    }),
    1,
    controller.signal,
  );
  const response = await call(transport, { stream: true });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
  controller.abort();
  await transport.close();
  await expect(reader.read()).rejects.toThrow();
  await expect(call(transport)).rejects.toThrow();
});

it("lets the pilot reject changed wire budgets before normalization or forwarding", async () => {
  const forwarded = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end());
  const baseUrl = await endpoint(forwarded);
  const inspect = vi.fn((settings: { maxOutputTokens: number | null }) => {
    if (settings.maxOutputTokens !== 8) throw new Error("Mismatched output budget");
  });
  const transport = await openProcessModelTransport(
    model(baseUrl),
    new AbortController().signal,
    1,
    inspect,
  );
  cleanup.push(transport.close);
  expect((await call(transport, { max_tokens: 1 })).status).toBe(502);
  expect(forwarded).not.toHaveBeenCalled();
  expect(inspect).toHaveBeenLastCalledWith({
    model: "test-model",
    reasoningEffort: undefined,
    maxOutputTokens: 1,
  });
  expect((await call(transport, { max_tokens: 8 })).status).toBe(200);
  expect((await call(transport, { max_tokens: 8 })).status).toBe(429);
  expect(inspect).toHaveBeenCalledTimes(2);
  expect(forwarded).toHaveBeenCalledOnce();
});
