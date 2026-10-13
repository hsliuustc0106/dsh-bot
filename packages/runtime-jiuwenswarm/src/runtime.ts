import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { mapEvent, mapUsage } from "./event-mapping.js";
import type { Installation, ProcessClient } from "./process-client.js";
import { commandFor, JiuwenProcessClient, validateInstallation } from "./process-client.js";
import { JIUWENSWARM_REVISION, JIUWENSWARM_SDK_VERSION } from "./version.js";

export class JiuwenSwarmRuntime implements AgentRuntime {
  private readonly running = new Map<
    string,
    { controller: AbortController; work: Promise<void> }
  >();
  private readonly client: ProcessClient;

  constructor(installation: Installation, client?: ProcessClient) {
    if (client) this.client = client;
    else {
      validateInstallation(installation);
      this.client = new JiuwenProcessClient(commandFor(installation));
    }
  }

  describe() {
    return {
      id: "jiuwenswarm",
      contractVersion: "1",
      adapterVersion: `${JIUWENSWARM_SDK_VERSION}+${JIUWENSWARM_REVISION}`,
      capabilities: { streaming: true, tools: false, compaction: false, scripted: false },
    };
  }

  async abort(runId: string) {
    const active = this.running.get(runId);
    active?.controller.abort();
    await active?.work;
  }

  run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterableIterator<AgentRuntimeEvent> {
    const controller = new AbortController();
    const iterator = this.events(request, controller, context);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => iterator.next(),
      return: () => {
        controller.abort();
        return iterator.return();
      },
      throw: (error) => {
        controller.abort();
        return iterator.throw(error);
      },
    };
  }

  private async *events(
    request: AgentRunRequest,
    controller: AbortController,
    context?: Partial<AdapterContext>,
  ): AsyncGenerator<AgentRuntimeEvent, void> {
    if (this.running.has(request.runId)) throw new Error("JiuwenSwarm run is already active");
    const signal = context?.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    if (signal.aborted) return;
    validateRequest(request);
    const queue: AgentRuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    let textBytes = 0;
    const emit = (event: AgentRuntimeEvent) => {
      if (queue.length >= 256) throw new Error("JiuwenSwarm event consumer is too slow");
      queue.push(event);
      wake?.();
    };
    const work = this.client
      .run({
        request,
        signal,
        onEvent: (event) => {
          if (signal.aborted) return;
          const mapped = mapEvent(event);
          if (mapped) {
            textBytes += Buffer.byteLength(mapped.text);
            if (textBytes > 1024 * 1024) throw new Error("JiuwenSwarm response exceeded its limit");
            emit(mapped);
          }
        },
      })
      .then(async (result) => {
        // Account a terminal usage record even if cancellation won the race.
        const usage = mapUsage(result, request);
        await request.onUsage?.(usage);
        if (signal.aborted) return;
        if (result.status !== "completed" || result.exit_code !== 0 || result.error !== null)
          throw new Error("JiuwenSwarm did not complete successfully");
        if (!result.output?.trim() && !request.allowSilentEmpty)
          throw new Error("JiuwenSwarm completed without a response");
        if (Buffer.byteLength(result.output ?? "") > 1024 * 1024)
          throw new Error("JiuwenSwarm response exceeded its limit");
        emit({ ...usage, accounted: Boolean(request.onUsage) });
        emit({ type: "done", ...(result.output ? { text: result.output } : {}) });
      })
      .catch(() => {
        if (!signal.aborted)
          failure = new Error("JiuwenSwarm run failed; no successful terminal result was accepted");
      })
      .finally(() => {
        finished = true;
        wake?.();
      });
    this.running.set(request.runId, { controller, work });
    try {
      while (!finished || queue.length) {
        if (signal.aborted) break;
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

function validateRequest(request: AgentRunRequest) {
  if (
    request.model.provider !== "openai" ||
    !request.model.apiKey ||
    request.model.oauth ||
    (request.model.baseUrl && request.model.baseUrl !== "https://api.openai.com/v1")
  )
    throw new Error(
      "This JiuwenSwarm stage requires an OpenAI API-key connection at its standard endpoint",
    );
  if (request.model.thinkingLevel != null)
    throw new Error("JiuwenSwarm reasoning settings are not yet verified");
  if (request.resumeFromCheckpoint || request.fallbackModels?.length)
    throw new Error("JiuwenSwarm resume and fallback are unavailable");
  if (request.currentTurnImages?.length || request.history.some((entry) => entry.images?.length))
    throw new Error("JiuwenSwarm accepts text only in this stage");
}
