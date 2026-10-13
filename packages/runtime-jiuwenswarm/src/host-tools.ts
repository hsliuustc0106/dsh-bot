import { createHash } from "node:crypto";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  AgentToolCompletion,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { isToolPauseResult } from "@rakazo/adapter-kit";
import type { Event, HostTool, JsonObject } from "../vendor/index.js";

export function hostToolName(name: string): string {
  return `rakazo_${name.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 30)}_${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One invocation owns its tool catalog, identities, callbacks and deduplication. */
export class HostTools {
  readonly declarations: HostTool[] = [];
  private readonly catalog = new Map<string, ConnectorTool>();
  private readonly calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
  private session: string | undefined;
  private resultBytes = 0;
  private argumentBytes = 0;

  constructor(
    private readonly request: AgentRunRequest,
    private readonly signal: AbortSignal,
    private readonly emit: (event: AgentRuntimeEvent) => void,
    private readonly pause: () => void,
    private readonly fail: () => void,
  ) {
    for (const tool of request.tools) {
      // These require runtime orchestration or native takeover support, not executeTool.
      if (!tool.route && ["run_subagent", "request_takeover"].includes(tool.name)) continue;
      const name = hostToolName(tool.name);
      if (this.catalog.has(name)) throw new Error("Duplicate JiuwenSwarm host tool");
      this.catalog.set(name, tool);
      this.declarations.push({
        name,
        description: tool.description,
        input_schema: tool.inputSchema as JsonObject,
      });
    }
  }

  private identify(event: Event): JsonObject {
    this.signal.throwIfAborted();
    if (
      event.request_id !== this.request.runId ||
      !event.session_id ||
      (this.session && this.session !== event.session_id) ||
      !object(event.payload)
    )
      throw new Error("Foreign JiuwenSwarm callback");
    this.session = event.session_id;
    return event.payload;
  }

  observe(event: Event): void {
    if (event.event_type === "host_tool.requested" || event.event_type === "interaction.requested")
      return;
    if (
      event.event_type === "chat.tool_call" ||
      event.event_type === "chat.tool_result" ||
      event.event_type.startsWith("tool.")
    ) {
      const payload = this.identify(event);
      if (
        !object(payload.tool) ||
        typeof payload.tool.name !== "string" ||
        !this.catalog.has(payload.tool.name)
      )
        throw new Error("JiuwenSwarm attempted a native tool");
    }
  }

  call(event: Event): Promise<unknown> {
    try {
      const payload = this.identify(event);
      if (
        event.event_type !== "host_tool.requested" ||
        typeof payload.call_id !== "string" ||
        !payload.call_id.trim() ||
        typeof payload.name !== "string" ||
        !object(payload.arguments)
      )
        throw new Error("Invalid JiuwenSwarm tool call");
      const tool = this.catalog.get(payload.name);
      if (!tool) throw new Error("Unknown JiuwenSwarm host tool");
      const fingerprint = JSON.stringify([payload.name, payload.arguments]);
      const previous = this.calls.get(payload.call_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error("JiuwenSwarm call identity was reused");
        return previous.result;
      }
      this.argumentBytes += Buffer.byteLength(fingerprint);
      if (this.argumentBytes > 8 * 1024 * 1024)
        throw new Error("JiuwenSwarm host arguments exceeded their limit");
      if (this.calls.size >= 128) throw new Error("JiuwenSwarm host call limit exceeded");
      const executionId = JSON.stringify([
        "jiuwenswarm",
        this.request.runId,
        event.session_id,
        payload.call_id,
      ]);
      const args = payload.arguments;
      // Store before entering the executor so concurrent duplicate callbacks share one action.
      const result = Promise.resolve().then(() => this.execute(tool, args, executionId));
      this.calls.set(payload.call_id, { fingerprint, result });
      return result;
    } catch (error) {
      this.fail();
      return Promise.reject(error);
    }
  }

  private async execute(
    tool: ConnectorTool,
    args: JsonObject,
    executionId: string,
  ): Promise<unknown> {
    this.signal.throwIfAborted();
    const started = Date.now();
    const completion: AgentToolCompletion = { name: tool.name, executionId, durationMs: 0 };
    try {
      this.emit({ type: "tool", name: tool.name, args, executionId });
      if (tool.name === "ask_user" && !tool.route) {
        this.ask(args.question, args.options);
        completion.paused = true;
        return null;
      }
      if (!this.request.executeTool) throw new Error("Rakazo tool executor is unavailable");
      const result = await this.request.executeTool(tool.name, args, executionId, tool.route, {
        signal: this.signal,
      });
      const bytes = Buffer.byteLength(JSON.stringify(result ?? null));
      this.resultBytes += bytes;
      if (bytes > 512 * 1024 || this.resultBytes > 8 * 1024 * 1024)
        throw new Error("JiuwenSwarm host results exceeded their limit");
      completion.result = result;
      if (isToolPauseResult(result)) {
        completion.paused = true;
        this.pause();
      }
      return result;
    } catch (error) {
      completion.error = error;
      // A thrown host action may have had effects. Stop; do not let the model retry it.
      this.fail();
      throw error;
    } finally {
      completion.durationMs = Math.max(0, Date.now() - started);
      try {
        await this.request.onToolCompleted?.(completion);
      } catch {
        this.fail();
      }
    }
  }

  private ask(question: unknown, options: unknown): void {
    if (
      typeof question !== "string" ||
      !question.trim() ||
      question.length > 240 ||
      !Array.isArray(options) ||
      options.length < 2 ||
      options.length > 4 ||
      options.some(
        (option) => typeof option !== "string" || !option.trim() || option.length > 80,
      ) ||
      new Set(options).size !== options.length
    )
      throw new Error("Invalid JiuwenSwarm question");
    this.emit({
      type: "ask",
      text: question,
      actions: options.map((label, i) => ({ id: `choice-${i + 1}`, label })),
    });
    this.pause();
  }

  interaction(event: Event): JsonObject[] {
    try {
      const payload = this.identify(event);
      // Native permissions never grant authority. Only host executeTool may authorize actions.
      if (
        event.event_type !== "interaction.requested" ||
        typeof payload.interaction_id !== "string" ||
        !payload.interaction_id.trim() ||
        payload.kind !== "question" ||
        !Array.isArray(payload.questions) ||
        payload.questions.length !== 1
      )
        throw new Error("Unsupported JiuwenSwarm interaction");
      const question = payload.questions[0];
      if (!object(question) || !Array.isArray(question.options))
        throw new Error("Invalid JiuwenSwarm question");
      this.ask(
        question.question,
        question.options.map((option) => (object(option) ? option.label : null)),
      );
      return [];
    } catch (error) {
      this.fail();
      throw error;
    }
  }
}
