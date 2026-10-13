import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentToolCompletion,
} from "@rakazo/adapter-kit";
import { isToolPauseResult, withoutSteeringMessages } from "@rakazo/adapter-kit";
import type { DshEvent } from "./bridge.js";
import { DshBridge } from "./bridge.js";
import { validateDshInstallation } from "./profile.js";

const readOnlyTools = new Set(["read_file", "list_files"]);

export class DshAgentRuntime implements AgentRuntime {
  private readonly bridge: DshBridge;
  private readonly running = new Map<
    string,
    { controller: AbortController; work: Promise<void> }
  >();

  constructor(options: { cliPath: string }) {
    this.bridge = new DshBridge({ cliPath: validateDshInstallation(options.cliPath) });
  }

  describe() {
    return {
      id: "dsh",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, tools: true, compaction: false, scripted: false },
    };
  }

  async abort(runId: string): Promise<void> {
    const active = this.running.get(runId);
    active?.controller.abort();
    await active?.work;
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const events = this.events(request, controller, context);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => events.next(),
      return: () => {
        controller.abort();
        return events.return();
      },
      throw: (error) => {
        controller.abort();
        return events.throw(error);
      },
    };
  }

  private async *events(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    if (this.running.has(request.runId)) throw new Error("DSH run is already active");
    const signal = context?.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    if (signal.aborted) return;
    validateRequest(request);
    const queue: AgentRuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: unknown;
    let paused = false;
    let text = "";
    const emit = (event: AgentRuntimeEvent) => {
      queue.push(event);
      wake?.();
    };
    const executionId = (event: Extract<DshEvent, { type: "tool" | "usage" }>) =>
      `${request.runId}:dsh:${event.sessionId}:${event.callId}`;
    const work = (async () => {
      // DSH consumes steering at fresh-session startup. Mid-run arrivals remain
      // durable for the next continuation, whose successful completion consumes them.
      const steering = (await request.claimSteering?.([])) ?? [];
      signal.throwIfAborted();
      return this.bridge.run(
        {
          prompt: steering.length
            ? `${request.prompt}\n\nAdditional user context:\n${steering.map((item) => item.text).join("\n")}`
            : request.prompt,
          instructions: request.instructions,
          history: withoutSteeringMessages(request.history, steering).map(({ role, content }) => ({
            role,
            content,
          })),
          model: {
            id: request.model.id,
            maxTokens: request.model.maxTokens,
            thinkingLevel: dshThinkingLevel(request.model.thinkingLevel),
          },
          connection: {
            apiKey: request.model.apiKey!,
            baseUrl: request.model.baseUrl,
            contextWindow: request.model.contextWindow,
          },
          tools: request.tools
            .filter(
              (tool) => readOnlyTools.has(tool.name) && !tool.route && tool.readOnly !== false,
            )
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        },
        {
          signal,
          onEvent: async (event) => {
            if (event.type === "usage") {
              const usage: Extract<AgentRuntimeEvent, { type: "usage" }> = {
                type: "usage",
                ...event.usage,
                provider: request.model.provider,
                model: request.model.id,
                callId: executionId(event),
                operationKind: request.usageOperationKind ?? "answer",
                costUsd: null,
                usageSource: "dsh",
                accounted: false,
              };
              await request.onUsage?.(usage);
              emit({ ...usage, accounted: Boolean(request.onUsage) });
            } else if (!signal.aborted && event.type === "text") {
              text += event.text;
              emit({ type: "text", text: event.text });
            } else if (!signal.aborted && event.type === "tool") {
              emit({
                type: "tool",
                name: event.name,
                args: event.args,
                executionId: executionId(event),
              });
            }
          },
          executeTool: async (event, toolSignal) => {
            toolSignal.throwIfAborted();
            if (!request.executeTool) throw new Error("Rakazo tool executor is unavailable");
            const started = Date.now();
            const completion: AgentToolCompletion = {
              name: event.name,
              executionId: executionId(event),
              durationMs: 0,
            };
            try {
              const result = await request.executeTool(
                event.name,
                event.args,
                completion.executionId,
              );
              completion.result = result;
              if (isToolPauseResult(result)) {
                paused = true;
                completion.paused = true;
                controller.abort();
              }
              return result;
            } catch (error) {
              completion.error = error;
              throw error;
            } finally {
              completion.durationMs = Math.max(0, Date.now() - started);
              try {
                await request.onToolCompleted?.(completion);
              } catch {
                /* Audit hooks do not alter tool behavior. */
              }
            }
          },
        },
      );
    })()
      .then((outcome) => {
        if (paused) emit({ type: "done" });
        else if (outcome === "completed" && !signal.aborted) {
          if (!text.trim() && !request.allowSilentEmpty)
            throw new Error("DSH completed without a response");
          emit({ type: "done", ...(text.trim() ? { text } : {}) });
        }
      })
      .catch((error: unknown) => {
        if (!signal.aborted) failure = error;
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    this.running.set(request.runId, { controller, work });
    try {
      while (!finished || queue.length) {
        if (signal.aborted && !paused) break;
        const event = queue.shift();
        if (event) yield event;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
      if (failure) throw failure;
    } finally {
      controller.abort();
      await work;
      this.running.delete(request.runId);
    }
  }
}

function dshThinkingLevel(
  value: AgentRunRequest["model"]["thinkingLevel"],
): "off" | "low" | "high" | "max" | undefined {
  if (value == null) return undefined;
  if (value === "off" || value === "low" || value === "high" || value === "max") return value;
  throw new Error("The DSH pilot does not support this reasoning effort");
}

function validateRequest(request: AgentRunRequest) {
  if (request.model.provider !== "deepseek" || !request.model.apiKey || request.model.oauth)
    throw new Error("The DSH pilot requires a DeepSeek API-key connection");
  if (request.resumeFromCheckpoint) throw new Error("DSH checkpoint resume is unavailable");
  if (request.fallbackModels?.length) throw new Error("DSH mid-run fallback is unavailable");
  if (request.currentTurnImages?.length || request.history.some((entry) => entry.images?.length))
    throw new Error("The DSH pilot accepts text input only");
  dshThinkingLevel(request.model.thinkingLevel);
}
