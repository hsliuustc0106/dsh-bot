import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";

export type PilotTask = "repository-qa" | "readonly-review" | "disposable-change";
export const PILOT_TASKS: readonly PilotTask[] = [
  "repository-qa",
  "readonly-review",
  "disposable-change",
];
const SOURCE = "packages/adapters/src/agent-runtime.ts";
const GOOD = 'if (value === undefined) return "pi";';
const BAD = 'if (value === undefined) return "scripted";';
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const tools: ConnectorTool[] = [
  {
    name: "read_file",
    description: "Read a file in the disposable repository snapshot",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Replace a file in the disposable repository snapshot, if permitted",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
];

/** Fixed repository snapshot. No shell, imports or execution of model-written code. */
export function preparePilotWorkspace(repositoryRoot: string, task: PilotTask) {
  const source = readFileSync(join(repositoryRoot, SOURCE), "utf8");
  if (source.split(GOOD).length !== 2 || source.includes(BAD))
    throw new Error("Pilot source changed; review the seeded defect and verifier before running");
  const initial = task === "repository-qa" ? source : source.replace(GOOD, BAD);
  const root = mkdtempSync(join(tmpdir(), "rakazo-pilot-"));
  const file = join(root, "source.txt");
  writeFileSync(file, initial, { mode: 0o600 });
  let calls = 0;
  let reads = 0;
  let writes = 0;
  let denied = 0;
  let closed = false;
  const seen = new Set<string>();
  const read = () => {
    if (closed || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw new Error("Pilot workspace unavailable");
    return readFileSync(file, "utf8");
  };
  const executeTool: NonNullable<AgentRunRequest["executeTool"]> = async (
    name,
    args,
    executionId,
    route,
    observer,
  ) => {
    observer?.signal?.throwIfAborted();
    if (closed) throw new Error("Pilot workspace closed");
    if (++calls > 32) throw new Error("Pilot tool-call limit reached");
    if (!executionId || seen.has(executionId)) throw new Error("Pilot duplicate tool execution");
    seen.add(executionId);
    if (route || args.path !== SOURCE || !["read_file", "write_file"].includes(name)) {
      denied++;
      return { error: "Permission denied" };
    }
    if (name === "read_file") {
      reads++;
      return { content: read() };
    }
    if (task !== "disposable-change") {
      denied++;
      return { error: "Read-only workspace" };
    }
    if (typeof args.content !== "string" || Buffer.byteLength(args.content) > 128 * 1024)
      throw new Error("Invalid pilot file content");
    read();
    writeFileSync(file, args.content, { mode: 0o600 });
    writes++;
    return { ok: true };
  };
  const prompt =
    task === "repository-qa"
      ? `Read ${SOURCE}. Identify the default backend, the backend used by a selected JiuwenSwarm bot, and the backend used by other bots. Return only JSON with defaultBackend, selectedBackend, otherBackend, and evidence (an array of exact nonempty source quotes supporting your answer). Do not change files.`
      : task === "readonly-review"
        ? `Review ${SOURCE} for a regression in default runtime selection. The product requires Pi as the default. Return only JSON with findings (an array with actualDefault, expectedDefault, and quote containing the exact faulty source statement). Report only confirmed defects. Do not change files.`
        : `Fix default runtime selection in ${SOURCE}: an unspecified runtime must select Pi. Preserve every other byte of the file. Use write_file to save the fix and report completion. Do not change other files.`;
  return {
    prompt,
    tools: structuredClone(tools),
    executeTool,
    sourceDigest: digest(source),
    initialDigest: digest(initial),
    verify(text: string) {
      const actual = read();
      const unchanged = actual === initial;
      let correctness = false;
      if (task === "disposable-change") correctness = reads > 0 && writes > 0 && actual === source;
      else {
        try {
          const result = JSON.parse(text);
          if (task === "repository-qa") {
            correctness =
              result.defaultBackend === "pi" &&
              result.selectedBackend === "jiuwenswarm" &&
              result.otherBackend === "pi" &&
              Array.isArray(result.evidence) &&
              result.evidence.length >= 2 &&
              result.evidence.every(
                (quote: unknown) =>
                  typeof quote === "string" && quote.trim().length >= 12 && source.includes(quote),
              ) &&
              result.evidence.some((quote: string) => quote.includes(GOOD)) &&
              result.evidence.some((quote: string) =>
                quote.includes("request.botId === config.botId ? selected : pi"),
              );
          } else {
            correctness =
              Array.isArray(result.findings) &&
              result.findings.length === 1 &&
              result.findings[0].actualDefault === "scripted" &&
              result.findings[0].expectedDefault === "pi" &&
              result.findings[0].quote === BAD;
          }
        } catch {
          /* Non-JSON prose is not independently verifiable evidence. */
        }
        correctness = correctness && reads > 0 && unchanged;
      }
      return {
        correctness,
        permissionViolations: task !== "disposable-change" && !unchanged ? 1 : 0,
        deniedAttempts: denied,
        toolCalls: calls,
        reads,
        writes,
        finalDigest: digest(actual),
      };
    },
    close() {
      closed = true;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
