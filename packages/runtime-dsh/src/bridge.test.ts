import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { DshEvent, DshTask } from "./bridge.js";
import { DshBridge } from "./bridge.js";
import { validateDshInstallation } from "./profile.js";

const cliPath = fileURLToPath(new URL("./fixtures/fake-dsh/lib/bin.js", import.meta.url));
const task = (prompt = "echo"): DshTask => ({
  prompt,
  instructions: "Use the supplied echo tool.",
  model: { id: "test-model" },
  connection: { apiKey: "test-placeholder" },
  tools: [
    {
      name: "echo",
      description: "Echo input",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
});
function fixture(prompt = "echo") {
  const controller = new AbortController();
  const events: DshEvent[] = [];
  const executeTool = vi.fn(async (call) => call.args.text);
  const run = () =>
    new DshBridge({ cliPath, startupTimeoutMs: 500 }).run(task(prompt), {
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
      },
      executeTool,
    });
  return { controller, events, executeTool, run };
}

describe("versioned DSH bridge", () => {
  it("uses a private, fresh profile and restricted environment, then removes the home", async () => {
    vi.stubEnv("DATABASE_URL", "test-placeholder");
    vi.stubEnv("NODE_OPTIONS", "--invalid-inherited-option");
    vi.stubEnv("DSH_HOME", "/tmp/foreign-dsh-profile");
    try {
      const test = fixture("inspect");
      await test.run();
      const text = test.events.find((event) => event.type === "text");
      expect(text?.type).toBe("text");
      const result = JSON.parse(text!.text);
      expect(result.inherited).toBe(false);
      expect(result.home).not.toBe("/tmp/foreign-dsh-profile");
      expect(result.plugins.join(" ")).not.toMatch(
        /sandbox|subprocess|filesystem|mcp|subagent|persistence|terminal/,
      );
      await expect(access(result.home)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("attests the actual tool set before dispatching a harmless echo", async () => {
    const test = fixture();
    expect(await test.run()).toBe("completed");
    expect(test.executeTool).toHaveBeenCalledOnce();
    expect(test.events.map((event) => event.type)).toEqual([
      "started",
      "tool",
      "text",
      "usage",
      "done",
    ]);
    expect(test.events[2]).toMatchObject({ text: "example" });
  });
  it.each(["toolset", "schema"])("rejects mismatched %s before execution", async (prompt) => {
    const test = fixture(prompt);
    await expect(test.run()).rejects.toMatchObject({ code: "TOOL_SET" });
    expect(test.executeTool).not.toHaveBeenCalled();
    expect(test.events).toEqual([]);
  });
  it.each(["malformed", "version", "session", "early-tool", "oversize"])(
    "fails closed on %s without exposing raw output",
    async (prompt) => {
      const test = fixture(prompt);
      await expect(test.run()).rejects.toMatchObject({
        code: "PROTOCOL",
        message: "DSH bridge failed: PROTOCOL",
      });
      expect(test.executeTool).not.toHaveBeenCalled();
    },
  );
  it("rejects unexpected tools and child-process crashes", async () => {
    const unknown = fixture("unknown");
    await expect(unknown.run()).rejects.toMatchObject({ code: "UNEXPECTED_TOOL" });
    expect(unknown.executeTool).not.toHaveBeenCalled();
    await expect(fixture("crash").run()).rejects.toMatchObject({ code: "CRASH" });
  });
  it("does not execute duplicate tool-call IDs twice", async () => {
    const test = fixture("duplicate");
    await expect(test.run()).rejects.toMatchObject({ code: "PROTOCOL" });
    expect(test.executeTool).toHaveBeenCalledOnce();
  });
  it("bounds startup when the child never attests its tools", async () => {
    await expect(fixture("hang-startup").run()).rejects.toMatchObject({ code: "STARTUP_TIMEOUT" });
  });
  it("stops dispatch immediately when cancelled by an event observer, including late calls", async () => {
    const controller = new AbortController();
    const executeTool = vi.fn();
    expect(
      await new DshBridge({ cliPath }).run(task("late"), {
        signal: controller.signal,
        executeTool,
        onEvent: (event) => {
          if (event.type === "tool") controller.abort();
        },
      }),
    ).toBe("cancelled");
    expect(executeTool).not.toHaveBeenCalled();
  });
  it("isolates concurrent runs on the same bridge instance", async () => {
    const bridge = new DshBridge({ cliPath });
    const run = async () => {
      const events: DshEvent[] = [];
      await bridge.run(task(), {
        signal: new AbortController().signal,
        onEvent: (event) => {
          events.push(event);
        },
        executeTool: async () => "ok",
      });
      return events;
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first[0]?.sessionId).not.toBe(second[0]?.sessionId);
    expect(new Set(first.map((event) => event.sessionId)).size).toBe(1);
    expect(new Set(second.map((event) => event.sessionId)).size).toBe(1);
  });
  it("enforces the exact installation version before starting a child", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-version-test-"));
    try {
      await mkdir(join(root, "lib"));
      await writeFile(join(root, "lib", "bin.js"), "throw new Error('must not start');");
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.0" }),
      );
      expect(() => validateDshInstallation(join(root, "lib", "bin.js"))).toThrow("0.2.1-alpha.2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
