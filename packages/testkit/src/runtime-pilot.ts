import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntime,
  ConnectorTool,
} from "@rakazo/adapter-kit";

import { startPilotTransport } from "./runtime-pilot-transport.js";

const exec = promisify(execFile);
export type PilotTaskId = "repository-answer" | "read-only-review" | "configuration-change";
export const pilotTasks: ReadonlyArray<{ id: PilotTaskId; prompt: string }> = [
  {
    id: "repository-answer",
    prompt:
      "Read README.md. Which environment variable controls cache lifetime, and what is its documented default? Cite README.md with a line number.",
  },
  {
    id: "read-only-review",
    prompt:
      "Review patch.diff against paginate.mjs. Identify the zero-limit regression and cite the affected file and line. Do not change files.",
  },
  {
    id: "configuration-change",
    prompt:
      "Change settings.json so maxItems is 10, preserving all other settings. Run the supplied tests and report their result. Change only settings.json.",
  },
];
const files: Record<string, string> = {
  "README.md":
    "# Example cache\n\nCACHE_TTL_SECONDS controls cache lifetime.\nThe default is 120 seconds.\n",
  "paginate.mjs":
    "export function paginate(items, options = {}) {\n  // A zero limit must return an empty page.\n  const limit = options.limit || 10;\n  return items.slice(0, limit);\n}\n",
  "patch.diff":
    "--- a/paginate.mjs\n+++ b/paginate.mjs\n@@ -3 +3 @@\n-  const limit = options.limit ?? 10;\n+  const limit = options.limit || 10;\n",
  "settings.json": '{"maxItems":5,"theme":"system"}\n',
  "settings.test.mjs":
    'import { readFile } from "node:fs/promises";\nimport { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("configuration", async () => { const config = JSON.parse(await readFile(new URL("./settings.json", import.meta.url), "utf8")); assert.deepEqual(config, { maxItems: 10, theme: "system" }); });\n',
};
const pathSchema = {
  type: "object",
  properties: { path: { type: "string" } },
  required: ["path"],
  additionalProperties: false,
};
const readTools: ConnectorTool[] = [
  {
    name: "read_file",
    description: "Read an allowed fixture file with line numbers",
    inputSchema: pathSchema,
    readOnly: true,
  },
  {
    name: "list_files",
    description: "List fixture files",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
];
const writeTools: ConnectorTool[] = [
  {
    name: "write_file",
    description: "Replace settings.json only; executable files cannot be written",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: "run_tests",
    description: "Run the immutable configuration tests",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
  },
];
export interface PilotBudget {
  timeoutMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxTokens: number;
}
export const defaultPilotBudget: PilotBudget = {
  timeoutMs: 120_000,
  maxToolCalls: 8,
  maxModelCalls: 8,
  maxTokens: 16_000,
};
export interface PilotResult {
  answer: string;
  harness: string;
  task: PilotTaskId;
  completed: boolean;
  automatedCorrectness: boolean;
  policyCompliant: boolean;
  humanInterventions: number;
  toolCalls: number;
  deniedCalls: number;
  modelCalls: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  budgetExceeded: boolean;
  testsPassed: boolean;
  failure: string | null;
}

/** The model can edit JSON data only. Test commands and executable files are immutable. */
export async function runPilotTask(options: {
  runtime: AgentRuntime;
  harness: string;
  model: AgentRunModel;
  task: (typeof pilotTasks)[number];
  budget?: PilotBudget;
}): Promise<PilotResult> {
  const budget = options.budget ?? defaultPilotBudget;
  for (const key of ["timeoutMs", "maxToolCalls", "maxModelCalls", "maxTokens"] as const) {
    const value = budget[key];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid pilot budget");
  }
  if (
    !options.model.baseUrl ||
    !options.model.apiKey ||
    (options.model.provider !== "openai-compatible" && options.model.provider !== "deepseek")
  )
    throw new Error("A supported pilot protocol and explicit connection are required");
  const root = await mkdtemp(join(tmpdir(), "rakazo-runtime-pilot-"));
  const controller = new AbortController();
  const began = performance.now();
  const runId = randomUUID();
  const result: PilotResult = {
    answer: "",
    harness: options.harness,
    task: options.task.id,
    completed: false,
    automatedCorrectness: false,
    policyCompliant: true,
    humanInterventions: 0,
    toolCalls: 0,
    deniedCalls: 0,
    modelCalls: 0,
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: null,
    budgetExceeded: false,
    testsPassed: false,
    failure: null,
  };
  const exceeded = () => {
    result.budgetExceeded = true;
    controller.abort();
  };
  const timer = setTimeout(exceeded, budget.timeoutMs);
  let answer = "";
  let dispatchedCalls = 0;
  let observedCalls = 0;
  let transport: Awaited<ReturnType<typeof startPilotTransport>> | undefined;
  const measuredTokens = () =>
    (result.inputTokens ?? budget.maxTokens) +
    (result.outputTokens ?? budget.maxTokens) +
    (result.cacheReadTokens ?? 0) +
    (result.cacheWriteTokens ?? 0);
  const allowed = new Set(
    (options.task.id === "configuration-change" ? [...readTools, ...writeTools] : readTools).map(
      (tool) => tool.name,
    ),
  );
  const deny = () => {
    result.deniedCalls++;
    result.policyCompliant = false;
    return { error: "Action is outside the pilot workspace policy" };
  };
  try {
    await Promise.all(
      Object.entries(files).map(([name, content]) =>
        writeFile(join(root, name), content, { mode: 0o600 }),
      ),
    );
    const executeTool: NonNullable<AgentRunRequest["executeTool"]> = async (
      name,
      args,
      _id,
      route,
      observer,
    ) => {
      const signal = observer?.signal
        ? AbortSignal.any([controller.signal, observer.signal])
        : controller.signal;
      signal.throwIfAborted();
      if (++result.toolCalls > budget.maxToolCalls) {
        exceeded();
        throw new Error("Tool budget exceeded");
      }
      if (route || !allowed.has(name)) return deny();
      if (name === "list_files") return { files: Object.keys(files) };
      if (name === "run_tests") {
        try {
          await exec(process.execPath, ["--test", join(root, "settings.test.mjs")], {
            cwd: root,
            signal,
            timeout: 5000,
            maxBuffer: 32768,
            env: { PATH: "" },
          });
          result.testsPassed = true;
          return { passed: true };
        } catch {
          result.testsPassed = false;
          return { passed: false };
        }
      }
      const path = args.path;
      if (typeof path !== "string" || !Object.hasOwn(files, path)) return deny();
      if (name === "read_file") {
        const content = await readFile(join(root, path), "utf8");
        return {
          path,
          content: content
            .split("\n")
            .map((line, index) => `${index + 1}: ${line}`)
            .join("\n"),
        };
      }
      if (
        path !== "settings.json" ||
        typeof args.content !== "string" ||
        args.content.length > 4096
      )
        return deny();
      try {
        JSON.parse(args.content);
      } catch {
        return { error: "Settings must be JSON" };
      }
      signal.throwIfAborted();
      await writeFile(join(root, path), args.content);
      result.testsPassed = false;
      return { ok: true };
    };
    transport = await startPilotTransport({
      protocol: options.model.provider === "deepseek" ? "messages" : "chat",
      baseUrl: options.model.baseUrl,
      apiKey: options.model.apiKey,
      modelId: options.model.id,
      signal: controller.signal,
      beforeDispatch: () => {
        if (dispatchedCalls >= budget.maxModelCalls || measuredTokens() >= budget.maxTokens) {
          exceeded();
          throw new Error("Model budget exceeded");
        }
        dispatchedCalls++;
        result.modelCalls = dispatchedCalls;
      },
    });
    const request: AgentRunRequest = {
      botId: "pilot",
      threadId: "pilot",
      runId,
      prompt: options.task.prompt,
      instructions:
        "Use only supplied tools and fixture files. Cite file:line evidence. Do not request network, shell, secrets or unrelated files.",
      history: [],
      tools: options.task.id === "configuration-change" ? [...readTools, ...writeTools] : readTools,
      model: {
        ...options.model,
        baseUrl: transport.baseUrl,
        apiKey: transport.apiKey,
        maxTokens: options.model.maxTokens ?? 1024,
        contextWindow: options.model.contextWindow ?? 16384,
        // This pilot targets DeepSeek's two protocols, including its standard
        // reasoning_effort=none control on Chat Completions.
        reasoning: true,
        thinkingLevel: "off",
      },
      executeTool,
      onUsage: (event) => {
        // A locally rejected request can produce an unknown-usage error event
        // in Pi. It never reached the provider and is not another paid attempt.
        if (observedCalls >= dispatchedCalls) return;
        observedCalls++;
        result.inputTokens =
          result.inputTokens === null || event.inputTokens === null
            ? null
            : result.inputTokens + event.inputTokens;
        result.outputTokens =
          result.outputTokens === null || event.outputTokens === null
            ? null
            : result.outputTokens + event.outputTokens;
        result.cacheReadTokens = addUsage(result.cacheReadTokens, event.cacheReadTokens);
        result.cacheWriteTokens = addUsage(result.cacheWriteTokens, event.cacheWriteTokens);
        // Equality is valid for a terminal response. The transport denies the
        // next paid attempt before dispatch, independently of usage callbacks.
        if (measuredTokens() > budget.maxTokens) exceeded();
      },
    };
    for await (const event of options.runtime.run(request, { signal: controller.signal })) {
      if (event.type === "text") answer += event.text;
      if (event.type === "tool" && !allowed.has(event.name)) {
        result.deniedCalls++;
        result.policyCompliant = false;
      }
      if (event.type === "done") {
        result.completed = true;
        if (event.text) answer = event.text;
      }
    }
    if (options.task.id === "repository-answer")
      result.automatedCorrectness =
        /CACHE_TTL_SECONDS/.test(answer) &&
        /120/.test(answer) &&
        /README\.md[:#L\s]+[34]/.test(answer);
    else if (options.task.id === "read-only-review")
      result.automatedCorrectness =
        /paginate\.mjs[:#L\s]+3/.test(answer) &&
        /\b(zero|0)\b/i.test(answer) &&
        /\?\?|nullish|falsy/i.test(answer);
    else {
      const config = JSON.parse(await readFile(join(root, "settings.json"), "utf8"));
      result.automatedCorrectness =
        result.testsPassed &&
        JSON.stringify(Object.keys(config).sort()) === '["maxItems","theme"]' &&
        config.maxItems === 10 &&
        config.theme === "system";
    }
    result.automatedCorrectness &&= result.completed && !result.budgetExceeded;
  } catch (error) {
    // Reports contain neither raw provider diagnostics nor local paths/credentials.
    result.failure = controller.signal.aborted ? "cancelled-or-budget" : "execution-failed";
    if (error instanceof Error && /UNEXPECTED_TOOL/.test(error.message)) {
      result.deniedCalls++;
      result.policyCompliant = false;
    }
  } finally {
    result.answer = options.model.apiKey
      ? answer.split(options.model.apiKey).join("[redacted]")
      : answer;
    clearTimeout(timer);
    controller.abort();
    await options.runtime.abort(runId).catch(() => undefined);
    await transport?.close();
    if (dispatchedCalls > observedCalls) {
      result.inputTokens =
        result.outputTokens =
        result.cacheReadTokens =
        result.cacheWriteTokens =
          null;
    }
    await rm(root, { recursive: true, force: true });
    result.latencyMs = Math.round(performance.now() - began);
  }
  return result;
}

export interface PilotPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export async function runPilot(options: {
  mode: "offline-emulator" | "live";
  pricing?: PilotPricing;
  pi: AgentRuntime;
  dsh: AgentRuntime;
  model: Omit<AgentRunModel, "provider" | "baseUrl">;
  chatBaseUrl: string;
  messagesBaseUrl: string;
  budget?: PilotBudget;
}) {
  if (options.pricing) {
    for (const key of [
      "inputPerMillion",
      "outputPerMillion",
      "cacheReadPerMillion",
      "cacheWritePerMillion",
    ] as const) {
      const value = options.pricing[key];
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid pricing");
    }
  }
  const results: PilotResult[] = [];
  for (const [index, task] of pilotTasks.entries()) {
    // Alternate order to reduce a fixed warm-cache/order advantage.
    const order = index % 2 ? (["dsh", "pi"] as const) : (["pi", "dsh"] as const);
    for (const harness of order)
      results.push(
        await runPilotTask({
          runtime: options[harness],
          harness,
          task,
          budget: options.budget,
          model: {
            ...options.model,
            provider: harness === "pi" ? "openai-compatible" : "deepseek",
            baseUrl: harness === "pi" ? options.chatBaseUrl : options.messagesBaseUrl,
          },
        }),
      );
  }
  if (options.pricing) {
    for (const row of results) row.costUsd = estimatePilotCost(row, options.pricing);
  }
  return {
    schemaVersion: 1,
    mode: options.mode,
    pricing: options.pricing ?? null,
    model: options.model.id,
    budgets: options.budget ?? defaultPilotBudget,
    results,
    limitations: [
      "Protocol serialization differs: Chat Completions for Pi, Messages for DSH.",
      "Correctness is a fixture rubric, not a general quality score.",
      "No live human intervention is supplied; interventions are zero by design.",
      "Cost is an estimate using supplied prices, or unknown without pricing. Offline usage is synthetic.",
      "Model-call limits are enforced before HTTP dispatch; token limits use observed usage and may overshoot by one response. Unreported cache tokens cannot be bounded.",
      "The pilot transport verifies explicit non-thinking controls on both serialized protocols before forwarding.",
      "Only settings JSON is editable; arbitrary generated code is never executed.",
    ],
  };
}

function addUsage(total: number | null, value: number | null | undefined): number | null {
  return total === null || value == null ? null : total + value;
}

export function estimatePilotCost(row: PilotResult, pricing: PilotPricing): number | null {
  if (
    !row.completed ||
    row.budgetExceeded ||
    row.failure ||
    row.modelCalls === 0 ||
    row.inputTokens === null ||
    row.outputTokens === null ||
    (row.cacheReadTokens === null && pricing.cacheReadPerMillion !== 0) ||
    (row.cacheWriteTokens === null && pricing.cacheWritePerMillion !== 0)
  )
    return null;
  return (
    (row.inputTokens * pricing.inputPerMillion +
      row.outputTokens * pricing.outputPerMillion +
      (row.cacheReadTokens ?? 0) * pricing.cacheReadPerMillion +
      (row.cacheWriteTokens ?? 0) * pricing.cacheWritePerMillion) /
    1_000_000
  );
}
