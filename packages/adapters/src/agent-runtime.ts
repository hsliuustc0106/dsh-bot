import { isAbsolute } from "node:path";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import { JiuwenSwarmRuntime } from "@rakazo/runtime-jiuwenswarm";
import { PiAgentRuntime } from "./pi-runtime.js";
import { piSessionsRoot } from "./pi-session.js";
import { ScriptedAgentRuntime } from "./scripted-runtime.js";

export type AgentRuntimeKind = "pi" | "scripted" | "dsh" | "jiuwenswarm";

export interface AgentRuntimeOptions {
  kind?: string;
  dataDir?: string;
  recordPiSessions?: boolean;
  dsh?: { cliPath: string; botId: string };
  jiuwenswarm?: { pythonPath: string; sourceDir: string; botId: string };
}

export function resolveAgentRuntimeKind(value?: string): AgentRuntimeKind {
  if (value === undefined) return "pi";
  if (value === "pi" || value === "scripted" || value === "dsh" || value === "jiuwenswarm")
    return value;
  throw new Error("Unknown AGENT_RUNTIME; expected pi, scripted, dsh, or jiuwenswarm");
}

export function agentRuntimeOptionsFromEnv(source: NodeJS.ProcessEnv): AgentRuntimeOptions {
  const kind = resolveAgentRuntimeKind(source.AGENT_RUNTIME);
  const options: AgentRuntimeOptions = {
    kind,
    dataDir: source.DATA_DIR ?? "./data",
    recordPiSessions: source.PI_SESSION_RECORDING === "true",
    ...(kind === "jiuwenswarm"
      ? {
          jiuwenswarm: {
            pythonPath: source.JIUWENSWARM_PYTHON_PATH ?? "",
            sourceDir: source.JIUWENSWARM_SOURCE_DIR ?? "",
            botId: source.AGENT_RUNTIME_BOT_ID ?? "",
          },
        }
      : {}),
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
  if (kind === "jiuwenswarm") validateJiuwenOptions(options.jiuwenswarm);
  return options;
}

function validateDshOptions(
  options: AgentRuntimeOptions["dsh"],
): asserts options is NonNullable<AgentRuntimeOptions["dsh"]> {
  if (!options?.botId.trim()) throw new Error("DSH requires AGENT_RUNTIME_BOT_ID");
  if (!options.cliPath || !isAbsolute(options.cliPath))
    throw new Error("DSH requires an absolute DSH_CLI_PATH");
}

function validateJiuwenOptions(
  options: AgentRuntimeOptions["jiuwenswarm"],
): asserts options is NonNullable<AgentRuntimeOptions["jiuwenswarm"]> {
  if (!options?.botId.trim()) throw new Error("JiuwenSwarm requires AGENT_RUNTIME_BOT_ID");
  if (!isAbsolute(options.pythonPath) || !isAbsolute(options.sourceDir))
    throw new Error(
      "JiuwenSwarm requires absolute JIUWENSWARM_PYTHON_PATH and JIUWENSWARM_SOURCE_DIR",
    );
}

/** One selection boundary for API and worker. Optional process runtimes validate
 * their installations at startup and never silently select Pi on failure. */
export function createAgentRuntime(
  options: AgentRuntimeOptions = {},
  createDsh?: (options: NonNullable<AgentRuntimeOptions["dsh"]>) => AgentRuntime,
  createJiuwen: (options: NonNullable<AgentRuntimeOptions["jiuwenswarm"]>) => AgentRuntime = (
    config,
  ) => new JiuwenSwarmRuntime(config),
): AgentRuntime {
  const kind = resolveAgentRuntimeKind(options.kind);
  if (kind === "scripted") return new ScriptedAgentRuntime();
  if (kind === "dsh") validateDshOptions(options.dsh);
  if (kind === "jiuwenswarm") validateJiuwenOptions(options.jiuwenswarm);
  const pi = new PiAgentRuntime({
    sessionRoot: options.recordPiSessions ? piSessionsRoot(options.dataDir ?? "./data") : undefined,
  });
  if (kind === "pi") return pi;
  const config = kind === "jiuwenswarm" ? options.jiuwenswarm! : options.dsh!;
  if (kind === "dsh" && !createDsh) throw new Error("DSH runtime is unavailable in this build");
  const selected =
    kind === "jiuwenswarm" ? createJiuwen(options.jiuwenswarm!) : createDsh!(options.dsh!);
  const piDescription = pi.describe();
  const selectedDescription = selected.describe();
  return {
    describe: (request) =>
      request
        ? (request.botId === config.botId ? selected : pi).describe(request)
        : {
            id: `pi+${kind}`,
            contractVersion: "1",
            adapterVersion: "0.1.0",
            // Report only capabilities supported for every request this router accepts.
            capabilities: {
              streaming:
                piDescription.capabilities.streaming && selectedDescription.capabilities.streaming,
              tools: piDescription.capabilities.tools && selectedDescription.capabilities.tools,
              compaction:
                piDescription.capabilities.compaction &&
                selectedDescription.capabilities.compaction,
              scripted: false,
            },
          },
    run: (request, context) =>
      (request.botId === config.botId ? selected : pi).run(request, context),
    async abort(runId) {
      await Promise.all([pi.abort(runId), selected.abort(runId)]);
    },
  };
}
