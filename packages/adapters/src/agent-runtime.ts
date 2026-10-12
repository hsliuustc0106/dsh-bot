import { isAbsolute } from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { PiAgentRuntime } from "./pi-runtime.js";
import { piSessionsRoot } from "./pi-session.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

export type AgentRuntimeKind = "pi" | "scripted" | "dsh";

export interface AgentRuntimeOptions {
  kind?: string;
  dataDir?: string;
  recordPiSessions?: boolean;
  dsh?: { cliPath: string; botId: string };
}

export function resolveAgentRuntimeKind(value?: string): AgentRuntimeKind {
  if (value === undefined) return "pi";
  if (value === "pi" || value === "scripted" || value === "dsh") return value;
  throw new Error("Unknown AGENT_RUNTIME; expected pi, scripted, or dsh");
}

export function agentRuntimeOptionsFromEnv(source: NodeJS.ProcessEnv): AgentRuntimeOptions {
  const kind = resolveAgentRuntimeKind(source.AGENT_RUNTIME);
  const options: AgentRuntimeOptions = {
    kind,
    dataDir: source.DATA_DIR ?? "./data",
    recordPiSessions: source.PI_SESSION_RECORDING === "true",
    ...(kind === "dsh"
      ? {
          dsh: {
            cliPath: source.DSH_CLI_PATH ?? "",
            botId: source.AGENT_RUNTIME_BOT_ID ?? "",
          },
        }
      : {}),
  };
  if (kind === "dsh") validateDshOptions(options.dsh);
  return options;
}

function validateDshOptions(
  options: AgentRuntimeOptions["dsh"],
): asserts options is NonNullable<AgentRuntimeOptions["dsh"]> {
  if (!options?.botId.trim()) throw new Error("DSH requires AGENT_RUNTIME_BOT_ID");
  if (!options.cliPath || !isAbsolute(options.cliPath))
    throw new Error("DSH requires an absolute DSH_CLI_PATH");
}

/** One selection boundary for the API and worker. External runtimes are injected
 * by the composition root; a missing DSH implementation must never select Pi. */
export function createAgentRuntime(
  options: AgentRuntimeOptions = {},
  createDsh?: (options: NonNullable<AgentRuntimeOptions["dsh"]>) => AgentRuntime,
): AgentRuntime {
  const kind = resolveAgentRuntimeKind(options.kind);
  if (kind === "scripted") return new ScriptedAgentRuntime();
  if (kind === "dsh") validateDshOptions(options.dsh);
  const pi = new PiAgentRuntime({
    sessionRoot: options.recordPiSessions ? piSessionsRoot(options.dataDir ?? "./data") : undefined,
  });
  if (kind === "pi") return pi;
  const config = options.dsh!;
  if (!createDsh) throw new Error("DSH runtime is unavailable in this build");
  const dsh = createDsh(config);
  const piDescription = pi.describe();
  const dshDescription = dsh.describe();
  return {
    describe: () => ({
      id: "pi+dsh",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      // Report only capabilities supported for every request this router accepts.
      capabilities: {
        streaming: piDescription.capabilities.streaming && dshDescription.capabilities.streaming,
        tools: piDescription.capabilities.tools && dshDescription.capabilities.tools,
        compaction: piDescription.capabilities.compaction && dshDescription.capabilities.compaction,
        scripted: false,
      },
    }),
    run: (request, context) => (request.botId === config.botId ? dsh : pi).run(request, context),
    async abort(runId) {
      await Promise.all([pi.abort(runId), dsh.abort(runId)]);
    },
  };
}
