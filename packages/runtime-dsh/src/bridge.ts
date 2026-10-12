import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { frames } from "./frames.mjs";
import type { DshConnection } from "./profile.js";
import { dshProfile, validateDshInstallation } from "./profile.js";
import {
  childMessage,
  hostMessage,
  MAX_FRAME_BYTES,
  type modelSchema,
  PROTOCOL_VERSION,
  toolSchema,
} from "./protocol.mjs";

export type DshTool = z.infer<typeof toolSchema>;
export type DshMessage = z.infer<typeof childMessage>;
export type DshEvent = Exclude<DshMessage, { type: "ready" | "configured" | "error" }>;
type Outgoing = z.infer<typeof hostMessage>;
type Payload<T> = T extends unknown ? Omit<T, "v" | "sessionId" | "seq"> : never;

export interface DshTask {
  prompt: string;
  instructions: string;
  tools: DshTool[];
  model: z.infer<typeof modelSchema>;
  connection: DshConnection;
}

export interface DshBridgeHooks {
  signal: AbortSignal;
  onEvent(event: DshEvent): void | Promise<void>;
  executeTool(call: Extract<DshEvent, { type: "tool" }>, signal: AbortSignal): Promise<unknown>;
}

export class DshBridgeError extends Error {
  constructor(
    readonly code:
      | "CONFIGURATION"
      | "PROTOCOL"
      | "TOOL_SET"
      | "UNEXPECTED_TOOL"
      | "CRASH"
      | "STARTUP_TIMEOUT"
      | "EXECUTION"
      | "LIMIT",
  ) {
    super(`DSH bridge failed: ${code}`);
    this.name = "DshBridgeError";
  }
}

export class DshBridge {
  constructor(
    private readonly options: {
      cliPath: string;
      startupTimeoutMs?: number;
      shutdownGraceMs?: number;
    },
  ) {}

  async run(task: DshTask, hooks: DshBridgeHooks): Promise<"completed" | "cancelled"> {
    if (hooks.signal.aborted) return "cancelled";
    const cliPath = await validateDshInstallation(this.options.cliPath);
    const tools = task.tools.map((tool) => toolSchema.parse(tool));
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      throw new DshBridgeError("CONFIGURATION");
    const sessionId = randomUUID();
    // Validate and bound the complete task before creating a process or exposing a key.
    const configure = hostMessage.parse({
      v: PROTOCOL_VERSION,
      sessionId,
      seq: 0,
      type: "configure",
      prompt: task.prompt,
      instructions: task.instructions,
      tools,
      model: task.model,
    });
    if (configure.type !== "configure") throw new DshBridgeError("CONFIGURATION");
    if (Buffer.byteLength(JSON.stringify(configure)) > MAX_FRAME_BYTES)
      throw new DshBridgeError("LIMIT");
    const home = await mkdtemp(join(tmpdir(), "rakazo-dsh-"));
    try {
      const profile = join(home, "profiles", "rakazo");
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(profile, "package.json"),
        JSON.stringify({
          name: "rakazo-dsh-run",
          private: true,
          type: "module",
          dsh: { profile: { bundles: [] } },
        }),
        { mode: 0o600 },
      );
      await writeFile(join(profile, "cordis.yml"), "[]\n", { mode: 0o600 });
      await writeFile(
        join(profile, "cordis.patch.yml"),
        JSON.stringify(dshProfile(task.connection)),
        { mode: 0o600 },
      );
      if (hooks.signal.aborted) return "cancelled";
      return await this.serve(cliPath, home, configure, task.connection, hooks);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }

  private async serve(
    cliPath: string,
    home: string,
    configure: Extract<Outgoing, { type: "configure" }>,
    connection: DshConnection,
    hooks: DshBridgeHooks,
  ): Promise<"completed" | "cancelled"> {
    const child = spawn(process.execPath, [cliPath, "--profile", "rakazo"], {
      cwd: home,
      stdio: ["pipe", "pipe", "ignore"],
      // No worker credentials, proxy overrides, NODE_OPTIONS, or user profile paths.
      env: {
        HOME: home,
        DSH_HOME: home,
        RAKAZO_RUN_ID: configure.sessionId,
        RAKAZO_MODEL_KEY: connection.apiKey,
        PATH: "",
      },
    });
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    let processError = false;
    child.on("error", () => {
      processError = true;
    });
    child.stdin.on("error", () => {
      processError = true;
    });
    let sent = 0;
    let received = 0;
    let stopping = false;
    let completed = false;
    let phase: "ready" | "configured" | "started" | "running" = "ready";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const tools = new Set(configure.tools.map((tool) => tool.name));
    const calls = new Set<string>();
    const usage = new Set<string>();
    const pending = new Set<Promise<void>>();
    const controller = new AbortController();
    const signal = AbortSignal.any([hooks.signal, controller.signal]);
    const send = (payload: Payload<Outgoing>) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) return;
      const message = hostMessage.parse({
        ...payload,
        v: PROTOCOL_VERSION,
        sessionId: configure.sessionId,
        seq: sent++,
      });
      const frame = JSON.stringify(message);
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new DshBridgeError("LIMIT");
      child.stdin.write(`${frame}\n`);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      controller.abort();
      send({ type: "cancel" });
      child.stdin.end();
      killTimer = setTimeout(() => child.kill("SIGKILL"), this.options.shutdownGraceMs ?? 1000);
    };
    hooks.signal.addEventListener("abort", stop, { once: true });
    let timedOut = false;
    const startupTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, this.options.startupTimeoutMs ?? 30_000);
    try {
      if (hooks.signal.aborted) stop();
      for await (const line of frames(child.stdout)) {
        let message: DshMessage;
        try {
          message = childMessage.parse(JSON.parse(line));
        } catch {
          throw new DshBridgeError("PROTOCOL");
        }
        if (
          message.sessionId !== configure.sessionId ||
          message.seq !== received++ ||
          received > 8192
        )
          throw new DshBridgeError("PROTOCOL");
        if (message.type === "usage") {
          if (phase !== "running" || usage.has(message.callId))
            throw new DshBridgeError("PROTOCOL");
          usage.add(message.callId);
          // Final billed usage remains observable while a cancelled child drains.
          await hooks.onEvent(message);
          continue;
        }
        if (stopping) continue;
        if (message.type === "error")
          throw new DshBridgeError(
            message.code === "TOOL_UNAVAILABLE" ? "UNEXPECTED_TOOL" : message.code,
          );
        if (message.type === "ready") {
          if (phase !== "ready") throw new DshBridgeError("PROTOCOL");
          phase = "configured";
          send(configure);
        } else if (message.type === "configured") {
          if (phase !== "configured") throw new DshBridgeError("PROTOCOL");
          const sort = (list: DshTool[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));
          if (!isDeepStrictEqual(sort(message.tools), sort(configure.tools)))
            throw new DshBridgeError("TOOL_SET");
          phase = "started";
          send({ type: "proceed" });
        } else if (message.type === "started") {
          if (phase !== "started") throw new DshBridgeError("PROTOCOL");
          phase = "running";
          clearTimeout(startupTimer);
          await hooks.onEvent(message);
        } else {
          if (phase !== "running") throw new DshBridgeError("PROTOCOL");
          if (message.type === "tool") {
            if (!tools.has(message.name)) throw new DshBridgeError("UNEXPECTED_TOOL");
            if (calls.has(message.callId)) throw new DshBridgeError("PROTOCOL");
            if (calls.size >= 64) throw new DshBridgeError("LIMIT");
            calls.add(message.callId);
            await hooks.onEvent(message);
            // Cancellation can happen while the observer persists the call event.
            if (signal.aborted) continue;
            const work = (async () => {
              try {
                const result = await hooks.executeTool(message, signal);
                if (!stopping)
                  send({
                    type: "tool-result",
                    callId: message.callId,
                    result: result ?? null,
                    error: false,
                  });
              } catch {
                if (!stopping)
                  send({
                    type: "tool-result",
                    callId: message.callId,
                    result: "Rakazo denied or failed the tool call",
                    error: true,
                  });
              }
            })();
            pending.add(work);
            void work.finally(() => pending.delete(work));
          } else if (message.type === "done") {
            if (pending.size) throw new DshBridgeError("PROTOCOL");
            completed = true;
            await hooks.onEvent(message);
            break;
          } else if (message.type === "text") await hooks.onEvent(message);
          else throw new DshBridgeError("PROTOCOL");
        }
      }
      if (timedOut) throw new DshBridgeError("STARTUP_TIMEOUT");
      if (!hooks.signal.aborted && (!completed || processError)) throw new DshBridgeError("CRASH");
      return hooks.signal.aborted ? "cancelled" : "completed";
    } catch (error) {
      if (error instanceof DshBridgeError) throw error;
      throw new DshBridgeError("PROTOCOL");
    } finally {
      clearTimeout(startupTimer);
      hooks.signal.removeEventListener("abort", stop);
      stop();
      await closed;
      if (killTimer) clearTimeout(killTimer);
      // Killing the model loop does not establish that an external tool stopped.
      // The caller owns tool cancellation; always join dispatched work here.
      await Promise.allSettled(pending);
    }
  }
}
