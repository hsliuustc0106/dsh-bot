import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { ComposioEmulator, resolveBotWorkspacePath, toComputerRef } from "@rakazo/adapters";
import { parseComputerMode } from "@rakazo/db";
import { DshAgentRuntime } from "@rakazo/runtime-dsh";
import { expect, it, vi } from "vitest";
import { discardBotIntroRun } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { startPilotEmulator } from "./runtime-pilot-emulator.js";

const enabled =
  process.env.VERIFY_DATABASE === "1" &&
  Boolean(process.env.DATABASE_URL) &&
  Boolean(process.env.DSH_TEST_CLI_PATH);
const origin = "http://127.0.0.1:5173";
it.skipIf(!enabled)(
  "DSH product journey preserves history, computer routing, disabled tools and rollback safety",
  async () => {
    const server = await startPilotEmulator();
    const dataDir = await mkdtemp(join(tmpdir(), "rakazo-dsh-product-"));
    const dsh = new DshAgentRuntime({ cliPath: process.env.DSH_TEST_CLI_PATH! });
    const requests: AgentRunRequest[] = [];
    let pilotBot: string | undefined;
    let stop: (() => Promise<void>) | undefined;
    const runtime: AgentRuntime = {
      describe: () => dsh.describe(),
      executionPolicy: (request) =>
        request.botId === pilotBot ? dsh.executionPolicy() : undefined,
      run: (request, context) => {
        if (request.botId !== pilotBot)
          return (async function* () {
            yield { type: "done" as const, text: "Ready." };
          })();
        requests.push(request);
        // Only the test transport endpoint changes; saved model/credential resolution is real.
        return dsh.run(
          {
            ...request,
            model: { ...request.model, baseUrl: server.baseUrl, thinkingLevel: "off" },
          },
          context,
        );
      },
      abort: (id) => dsh.abort(id),
    };
    try {
      const { createApp } = await import("../../../apps/api/src/app.ts");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "dsh",
        runtime,
        wakeupDriver: "memory",
        signupsEnabled: "true",
        composio: new ComposioEmulator(),
        encryptionKey: "synthetic-dsh-product-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `dsh-fixture-${randomUUID()}@rakazo.test`,
          password: "fixture-password-12",
          name: "Synthetic fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      const rpc = async <T>(procedure: string, input: unknown): Promise<T> => {
        const response = await handles.app.request(`/rpc/${procedure}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: JSON.stringify({ json: input }),
        });
        const body = (await response.json()) as { json: T; error?: { message?: string } };
        if (!response.ok || body.error)
          throw new Error(`${procedure}: ${body.error?.message ?? response.status}`);
        return body.json;
      };
      await rpc("models/connect", {
        provider: "deepseek",
        modelId: "deepseek-v4-flash",
        apiKey: "synthetic-dsh-product-key",
        contextWindow: 160000,
        maxTokens: 1024,
        thinkingLevel: "off",
      });
      const bot = await rpc<{ id: string }>("bots/create", {
        name: "Reader",
        title: "",
        description: "",
        instructions: "Read the fixture files and cite evidence.",
        notifyOnFinish: false,
      });
      await discardBotIntroRun(handles, cookie, bot.id);
      await rpc("bots/update", {
        botId: bot.id,
        modelProvider: "deepseek",
        modelId: "deepseek-v4-flash",
        thinkingLevel: "off",
      });
      await rpc("computer/boot", { botId: bot.id });
      const stored = await handles.prisma.bot.findUniqueOrThrow({
        where: { id: bot.id },
        include: { computer: true },
      });
      const storedPath = resolveBotWorkspacePath(
        parseComputerMode(stored.computer!.scope),
        bot.id,
        "README.md",
      );
      await handles.sandbox.writeFile(
        toComputerRef(stored.computer!),
        {
          path: storedPath,
          content: new TextEncoder().encode(
            "# Cache\n\nCACHE_TTL_SECONDS controls cache lifetime.\nThe default is 120 seconds.\n",
          ),
        },
        {
          operationId: "fixture",
          traceId: "fixture",
          userId: stored.userId,
          spaceId: stored.spaceId,
          botId: bot.id,
          signal: new AbortController().signal,
        },
      );
      const read = vi.spyOn(handles.sandbox, "readFile");
      pilotBot = bot.id;
      const send = async (text: string, expected: string) => {
        const sent = await rpc<{ runId: string }>("threads/send", { botId: bot.id, text });
        await expect
          .poll(
            async () =>
              (await handles.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } })).status,
            { timeout: 20000, interval: 100 },
          )
          .toBe(expected);
        return sent.runId;
      };
      await send(
        "Read README.md. What controls cache lifetime and what is the default?",
        "completed",
      );
      const second = await send("Read README.md again and repeat the answer.", "completed");
      expect(requests).toHaveLength(2);
      expect(requests[1]!.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            content: expect.stringContaining("CACHE_TTL_SECONDS"),
          }),
        ]),
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(read).toHaveBeenCalledWith(
        expect.objectContaining({ id: stored.computer!.providerRef }),
        storedPath,
        expect.objectContaining({ spaceId: stored.spaceId, botId: bot.id }),
        expect.any(Object),
      );
      const marker = await handles.prisma.run.findUniqueOrThrow({ where: { id: second } });
      expect(marker).toMatchObject({ executionRuntime: "dsh", runtimeNoReplay: true });
      const ledger = await handles.prisma.externalEffect.findMany({
        where: { runId: second, kind: "runtime_tool" },
      });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        status: "completed",
        result: null,
        request: { name: "read_file", executionId: expect.any(String) },
      });
      await rpc("bots/update", { botId: bot.id, disabledBuiltinTools: ["read_file"] });
      await send("Read README.md despite the disabled tool.", "failed");
      expect(read).toHaveBeenCalledTimes(2);
      expect(requests.at(-1)!.tools.some((tool) => tool.name === "read_file")).toBe(false);
      // Reconstruct a process-loss boundary using synthetic rows, then disable DSH selection.
      await handles.prisma.externalEffect.update({
        where: { id: ledger[0]!.id },
        data: { status: "executing" },
      });
      await handles.prisma.run.update({
        where: { id: second },
        data: {
          status: "running",
          completedAt: null,
          leaseOwner: "crashed-fixture",
          leaseExpiresAt: new Date(0),
        },
      });
      pilotBot = undefined;
      await handles.executor.continueRun(second, "recovery-fixture");
      expect(await handles.prisma.run.findUniqueOrThrow({ where: { id: second } })).toMatchObject({
        status: "failed",
        error: expect.stringContaining("cannot be resumed safely"),
      });
      expect(
        await handles.prisma.externalEffect.findUniqueOrThrow({ where: { id: ledger[0]!.id } }),
      ).toMatchObject({ status: "uncertain" });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      await stop?.();
      await server.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
  60000,
);
