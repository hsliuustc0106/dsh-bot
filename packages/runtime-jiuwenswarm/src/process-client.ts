import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { withoutSteeringMessages } from "@rakazo/adapter-kit";
import type { Event, HostTool, JsonObject, RunInput, RunResult } from "../vendor/index.js";
import { Client, Records } from "../vendor/index.js";
import { historyKey, readSessionCheckpoint } from "./session-checkpoint.js";
import { JIUWENSWARM_REVISION } from "./version.js";

export interface Installation {
  pythonPath: string;
  sourceDir: string;
  sessionRoot?: string;
}

export function commandFor(config: Installation): string[] {
  return [
    config.pythonPath,
    "-I",
    "-c",
    "import sys, runpy; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module('jiuwenswarm.channels.process_cli.main', run_name='__main__')",
    config.sourceDir,
  ];
}

export function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    USERPROFILE: root,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    JIUWENSWARM_DATA_DIR: root,
    JIUWENSWARM_CONFIG_DIR: join(root, "config"),
  };
}

/** SDK 0.1 merges env with process.env. Undefined overrides remove inherited
 * keys from Node's spawn environment; never mutate the API/worker environment. */
export function scrubSdkEnvironment(allowed: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
    ...allowed,
  };
}

export function validateInstallation(config: Installation): void {
  if (!isAbsolute(config.pythonPath) || !isAbsolute(config.sourceDir))
    throw new Error("JiuwenSwarm requires absolute Python and source paths");
  const root = mkdtempSync(join(tmpdir(), "rakazo-jiuwen-check-"));
  try {
    const revision = execFileSync("git", ["-C", config.sourceDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const changes = execFileSync(
      "git",
      ["-C", config.sourceDir, "status", "--porcelain", "--untracked-files=normal"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (revision !== JIUWENSWARM_REVISION || changes) throw new Error("revision");
    const command = commandFor(config);
    const probe = spawnSync(command[0]!, [...command.slice(1), "--query-json", "-"], {
      cwd: root,
      env: isolatedEnvironment(root),
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      input: `${JSON.stringify({
        schema_version: "0.1",
        type: "query",
        request_id: "rakazo-probe",
        operation: "protocol.capabilities",
        params: {},
      })}\n`,
    });
    if (probe.error || probe.status !== 0) throw new Error("probe");
    const records = new Records("rakazo-probe", "protocol.capabilities");
    records.accept(Buffer.from(probe.stdout));
    const result = records.finish(probe.status);
    const features = result.type === "query_result" ? result.data?.features : null;
    if (
      result.type !== "query_result" ||
      result.data?.protocol_revision !== 1 ||
      !features ||
      typeof features !== "object" ||
      Array.isArray(features) ||
      features.empty_tools !== true ||
      features.stable_event_fields !== true ||
      features.host_tools !== true
    )
      throw new Error("capabilities");
  } catch {
    throw new Error(
      `JiuwenSwarm requires a clean checkout at ${JIUWENSWARM_REVISION} and a working Process CLI with protocol revision 1`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface ProcessRun {
  request: AgentRunRequest;
  signal: AbortSignal;
  onEvent: (event: Event) => void;
  hostTools: HostTool[];
  onToolCall: (event: Event) => Promise<unknown>;
  onInteraction: (event: Event) => JsonObject[];
  wasPaused?: () => boolean;
}
export interface ProcessClient {
  run(input: ProcessRun): Promise<RunResult>;
}

/** Exposes only invocation-scoped host tools; native tools, skills and MCP stay disabled. */
export class JiuwenProcessClient implements ProcessClient {
  constructor(
    private readonly command: readonly string[],
    private readonly deadlineMs = 120000,
    private readonly shutdownGraceMs = 2000,
    private readonly sessionRoot?: string,
  ) {}

  async run({
    request,
    signal,
    onEvent,
    hostTools,
    onToolCall,
    onInteraction,
    wasPaused,
  }: ProcessRun): Promise<RunResult> {
    signal.throwIfAborted();
    if (this.sessionRoot && !request.runtimeSession)
      throw new Error("JiuwenSwarm requires backend session coordination");
    const definition = createHash("sha256")
      .update(
        JSON.stringify([
          JIUWENSWARM_REVISION,
          request.instructions,
          request.contextStrategy,
          hostTools,
          request.model.provider,
          request.model.id,
          request.model.maxTokens,
          request.model.contextWindow,
        ]),
      )
      .digest("hex");
    const session = this.sessionRoot
      ? await request.runtimeSession!.acquire(definition)
      : undefined;
    let root: string | undefined;
    let checkpoint: string | undefined;
    let completed = false;
    try {
      signal.throwIfAborted();
      root = mkdtempSync(join(tmpdir(), "rakazo-jiuwen-"));
      if (session && !/^[a-f0-9-]{36}$/.test(session.storageKey))
        throw new Error("Invalid runtime storage key");
      const dataRoot = session ? join(this.sessionRoot!, session.storageKey) : root;
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      const workspace = join(dataRoot, "workspace");
      mkdirSync(workspace, { mode: 0o700, recursive: true });
      // The Process SDK has no verified live steering channel. Claim once at
      // startup; later arrivals stay queued for the next invocation boundary.
      const steering = (await request.claimSteering?.([])) ?? [];
      signal.throwIfAborted();
      if (steering.some((message) => message.images?.length))
        throw new Error("JiuwenSwarm accepts text-only follow-ups in this stage");
      const previous = readSessionCheckpoint(session?.checkpoint);
      const seen = new Set(previous?.historyKeys ?? []);
      const history = withoutSteeringMessages(request.history, steering).filter(
        (message) => !seen.has(historyKey(message)),
      );
      const historyKeys = [
        ...new Set([
          ...request.history.map(historyKey),
          ...steering.map((message) => `id:${message.messageId}`),
          ...(request.sourceMessageId ? [`id:${request.sourceMessageId}`] : []),
        ]),
      ];
      mkdirSync(join(root, "config"), { mode: 0o700 });
      const model = request.model;
      // JSON is valid YAML. Credentials are invocation-local, never in argv or logs.
      writeFileSync(
        join(root, "config/config.yaml"),
        JSON.stringify({
          models: {
            defaults: [
              {
                model_id: "rakazo",
                is_default: true,
                model_client_config: {
                  api_base: "https://api.openai.com/v1",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: Upstream config expands this environment reference.
                  api_key: "${RAKAZO_MODEL_KEY}",
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: Upstream config expands this environment reference.
                  model_name: "${RAKAZO_MODEL_ID}",
                  client_provider: "OpenAI",
                  endpoint_profile: "openai",
                },
                model_config_obj: {
                  ...(model.maxTokens == null ? {} : { max_tokens: model.maxTokens }),
                  ...(model.contextWindow == null ? {} : { context_window: model.contextWindow }),
                },
              },
            ],
          },
          memory: { engine: "none" },
          auto_memory_enabled: false,
          auto_recap: { enabled: false },
          rsi: { enabled: false },
          symphony: { enabled: false },
          mcp: { servers: {} },
        }),
        { mode: 0o600 },
      );
      const input: RunInput = {
        request_id: request.runId,
        ...(previous ? { session_id: previous.sessionId } : {}),
        input: JSON.stringify({
          ...(history.length || !previous ? { history } : {}),
          message: request.prompt,
          ...(steering.length ? { followUps: steering.map((message) => message.text) } : {}),
        }),
        model: `${model.id}#0`,
        mode: "agent.work.normal",
        agent: {
          name: "rakazo",
          instructions: request.instructions,
          tools: hostTools.map((tool) => tool.name),
          skills: [],
          max_iterations: hostTools.length ? 32 : 1,
        },
        skills: [],
        mcp: [],
        host_tools: hostTools,
        // Upstream approval only gates these host callbacks; Rakazo remains the authority.
        permissions: {
          tools: Object.fromEntries(hostTools.map((tool) => [tool.name, "allow" as const])),
        },
        max_turns: hostTools.length ? 32 : 1,
        workspace: { cwd: workspace, project_dir: workspace, trusted_dirs: [] },
        timeout_seconds: Math.max(1, Math.floor(this.deadlineMs / 1000)),
      };
      const client = new Client({
        command: this.command,
        cwd: root,
        env: scrubSdkEnvironment({
          ...isolatedEnvironment(root),
          JIUWENSWARM_DATA_DIR: dataRoot,
          RAKAZO_MODEL_KEY: model.apiKey,
          RAKAZO_MODEL_ID: model.id,
        }),
        shutdownGraceMs: this.shutdownGraceMs,
        maxRecordBytes: 1024 * 1024,
      });
      const result = await client.run(input, {
        signal,
        deadlineMs: this.deadlineMs,
        onEvent,
        onInteraction,
        onToolCall,
      });
      completed =
        !signal.aborted &&
        result.status === "completed" &&
        result.exit_code === 0 &&
        result.error === null;
      if (completed && session) {
        if (!result.session_id || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.session_id))
          throw new Error("Invalid runtime session checkpoint");
        checkpoint = JSON.stringify({ sessionId: result.session_id, historyKeys });
      }
      return result;
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
      await session?.finish(
        completed && checkpoint ? "completed" : wasPaused?.() ? "paused" : "interrupted",
        checkpoint,
      );
    }
  }
}
