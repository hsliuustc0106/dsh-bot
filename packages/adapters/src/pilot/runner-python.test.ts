import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runAdapterPilot } from "./runner.js";

const describePython = process.env.VERIFY_JIUWENSWARM === "1" ? describe : describe.skip;

describePython("pilot harness plumbing with real adapters and an emulated model", () => {
  it("runs all six isolated cases and independently verifies each result", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../../..");
    const path = "packages/adapters/src/agent-runtime.ts";
    const source = readFileSync(resolve(repositoryRoot, path), "utf8");
    const server = createServer((req, res) => {
      void (async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        const text = JSON.stringify(
          body.messages.filter((message: { role: string }) => message.role === "user"),
        );
        const change = text.includes("Fix default runtime selection");
        const review = text.includes("Review packages/adapters");
        const completedTools = body.messages.filter(
          (message: { role: string }) => message.role === "tool",
        ).length;
        const description = completedTools === 0 ? "Read a file" : "Replace a file";
        const tool = body.tools.find((entry: { function: { description: string } }) =>
          entry.function.description.startsWith(description),
        );
        const call = completedTools === 0 || (change && completedTools === 1);
        const answer = change
          ? "Done"
          : review
            ? JSON.stringify({
                findings: [
                  {
                    actualDefault: "scripted",
                    expectedDefault: "pi",
                    quote: 'if (value === undefined) return "scripted";',
                  },
                ],
              })
            : JSON.stringify({
                defaultBackend: "pi",
                selectedBackend: "jiuwenswarm",
                otherBackend: "pi",
                evidence: [
                  'if (value === undefined) return "pi";',
                  "request.botId === config.botId ? selected : pi",
                ],
              });
        const delta = call
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `fixture-call-${completedTools}`,
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({
                      path,
                      ...(completedTools ? { content: source } : {}),
                    }),
                  },
                },
              ],
            }
          : { role: "assistant", content: answer };
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [part, finish] of [
          [delta, null],
          [{}, call ? "tool_calls" : "stop"],
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
      const report = await runAdapterPilot({
        repositoryRoot,
        model: {
          provider: "openai-compatible",
          id: "test-model",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fake-model-key",
          maxTokens: 4096,
          contextWindow: 32768,
        },
        installation: {
          pythonPath: process.env.JIUWENSWARM_PYTHON_PATH!,
          sourceDir: process.env.JIUWENSWARM_SOURCE_DIR!,
        },
        signal: AbortSignal.timeout(90_000),
      });
      expect(report.results).toHaveLength(6);
      expect(report.fixtureGatePassed).toBe(true);
      expect(report.results.map((result) => result.modelCalls)).toEqual([2, 2, 2, 2, 3, 3]);
      expect(report.results.every((result) => result.costUsd === null)).toBe(true);
      expect(report.remainingGates).not.toHaveLength(0);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain("fake-model-key");
      expect(serialized).not.toContain(`http://127.0.0.1:${address.port}`);
      expect(serialized).not.toContain(repositoryRoot);
      expect(readFileSync(resolve(repositoryRoot, path), "utf8")).toBe(source);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }, 100_000);
});
