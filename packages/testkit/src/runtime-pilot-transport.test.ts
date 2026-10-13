import { expect, it, vi } from "vitest";
import { startPilotEmulator } from "./runtime-pilot-emulator.js";
import { startPilotTransport } from "./runtime-pilot-transport.js";

it.each([
  { protocol: "chat" as const, control: {} },
  { protocol: "chat" as const, control: { reasoning_effort: "high" } },
  { protocol: "messages" as const, control: {} },
  { protocol: "messages" as const, control: { thinking: { type: "enabled" } } },
])("rejects unverified $protocol controls before a paid attempt", async ({ protocol, control }) => {
  const server = await startPilotEmulator();
  const controller = new AbortController();
  const beforeDispatch = vi.fn();
  const transport = await startPilotTransport({
    protocol,
    baseUrl: server.baseUrl,
    apiKey: "test-placeholder",
    modelId: "fixture-model",
    signal: controller.signal,
    beforeDispatch,
  });
  try {
    const response = await fetch(
      `${transport.baseUrl}${protocol === "chat" ? "/v1/chat/completions" : "/v1/messages"}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${transport.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fixture-model", stream: true, messages: [], ...control }),
      },
    );
    expect(response.status).toBe(400);
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  } finally {
    controller.abort();
    await transport.close();
    await server.close();
  }
});
