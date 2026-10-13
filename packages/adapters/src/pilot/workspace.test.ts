import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { preparePilotWorkspace } from "./workspace.js";

const root = resolve(import.meta.dirname, "../../../..");
const path = "packages/adapters/src/agent-runtime.ts";
const source = readFileSync(resolve(root, path), "utf8");
const good = 'if (value === undefined) return "pi";';
const bad = 'if (value === undefined) return "scripted";';
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function open(task: Parameters<typeof preparePilotWorkspace>[1]) {
  const workspace = preparePilotWorkspace(root, task);
  cleanup.push(workspace.close);
  return workspace;
}
const answer = JSON.stringify({
  defaultBackend: "pi",
  selectedBackend: "jiuwenswarm",
  otherBackend: "pi",
  evidence: [good, "request.botId === config.botId ? selected : pi"],
});

it("requires a source read and independently checks Q&A facts and quotes", async () => {
  const workspace = open("repository-qa");
  expect(workspace.verify(answer).correctness).toBe(false);
  await workspace.executeTool("read_file", { path }, "read");
  expect(workspace.verify(answer).correctness).toBe(true);
  expect(
    workspace.verify(answer.replace('"defaultBackend":"pi"', '"defaultBackend":"scripted"'))
      .correctness,
  ).toBe(false);
  expect(
    workspace.verify(answer.replace(good.replaceAll('"', '\\"'), "invented statement")).correctness,
  ).toBe(false);
  expect(workspace.verify("The answer is correct.").correctness).toBe(false);
});

it("denies read-only writes, traversal, foreign routes and unknown tools without effects", async () => {
  const workspace = open("readonly-review");
  const before = workspace.verify("").finalDigest;
  for (const [i, args] of [
    { path, content: source },
    { path: "../escape", content: "bad" },
    { path: "/tmp/escape", content: "bad" },
  ].entries())
    expect(await workspace.executeTool("write_file", args, `write-${i}`)).toHaveProperty("error");
  expect(
    await workspace.executeTool("read_file", { path }, "foreign", {
      connectorId: "other",
      resourceId: "other",
      toolName: "read",
    }),
  ).toHaveProperty("error");
  expect(await workspace.executeTool("shell", { path }, "shell")).toHaveProperty("error");
  const checks = workspace.verify("");
  expect(checks.finalDigest).toBe(before);
  expect(checks.permissionViolations).toBe(0);
  expect(checks.deniedAttempts).toBe(5);
  expect(checks.writes).toBe(0);
});

it("requires identifying the actual seeded defect with no spurious findings", async () => {
  const workspace = open("readonly-review");
  await workspace.executeTool("read_file", { path }, "read");
  const finding = { actualDefault: "scripted", expectedDefault: "pi", quote: bad };
  expect(workspace.verify(JSON.stringify({ findings: [finding] })).correctness).toBe(true);
  expect(workspace.verify(JSON.stringify({ findings: [] })).correctness).toBe(false);
  expect(workspace.verify(JSON.stringify({ findings: [finding, finding] })).correctness).toBe(
    false,
  );
});

it("checks saved bytes instead of accepting a claimed fix and confines the change to its snapshot", async () => {
  const workspace = open("disposable-change");
  expect(workspace.verify("Fixed!").correctness).toBe(false);
  await workspace.executeTool("read_file", { path }, "read");
  await workspace.executeTool(
    "write_file",
    { path, content: `${source}\n// unrelated change` },
    "wrong",
  );
  expect(workspace.verify("Fixed!").correctness).toBe(false);
  await workspace.executeTool("write_file", { path, content: source }, "fix");
  expect(workspace.verify("Done").correctness).toBe(true);
  expect(readFileSync(resolve(root, path), "utf8")).toBe(source);
  await expect(
    workspace.executeTool("write_file", { path, content: "bad" }, "fix"),
  ).rejects.toThrow("duplicate");
  expect(workspace.verify("").correctness).toBe(true);
});

it("refuses tools after cancellation and cleanup", async () => {
  const workspace = open("disposable-change");
  const controller = new AbortController();
  controller.abort();
  await expect(
    workspace.executeTool("write_file", { path, content: "bad" }, "cancelled", undefined, {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(workspace.verify("").writes).toBe(0);
  workspace.close();
  await expect(workspace.executeTool("read_file", { path }, "closed")).rejects.toThrow("closed");
});
