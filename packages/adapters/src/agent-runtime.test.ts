import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeOptionsFromEnv, createAgentRuntime } from "./agent-runtime.js";

const calls = vi.hoisted(() => ({ constructPi: vi.fn(), runPi: vi.fn(), abortPi: vi.fn() }));
vi.mock("./pi-runtime.js", () => ({
  PiAgentRuntime: class {
    constructor(options: unknown) {
      calls.constructPi(options);
    }
    describe() {
      return {
        id: "pi",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
      };
    }
    run = calls.runPi;
    abort = calls.abortPi;
  },
}));

beforeEach(() => vi.clearAllMocks());
const dsh = () =>
  ({
    describe: () => ({
      id: "dsh",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: false, tools: true, scripted: false },
    }),
    run: vi.fn(),
    abort: vi.fn(),
  }) satisfies AgentRuntime;

describe("shared runtime selection", () => {
  it("defaults to Pi without ambient runtime or transcript settings", () => {
    expect(createAgentRuntime().describe().id).toBe("pi");
    expect(calls.constructPi).toHaveBeenCalledExactlyOnceWith({ sessionRoot: undefined });
    expect(agentRuntimeOptionsFromEnv({}).kind).toBe("pi");
  });
  it("preserves explicit Pi and scripted behavior", () => {
    expect(createAgentRuntime({ kind: "pi" }).describe().capabilities.scripted).toBe(false);
    expect(createAgentRuntime({ kind: "scripted" }).describe()).toMatchObject({
      id: "scripted",
      capabilities: { scripted: true, compaction: false },
    });
  });
  it("preserves opt-in Pi session recording from the supplied environment", () => {
    const options = agentRuntimeOptionsFromEnv({
      DATA_DIR: "/tmp/rakazo-test-data",
      PI_SESSION_RECORDING: "true",
    });
    createAgentRuntime(options);
    expect(calls.constructPi).toHaveBeenCalledWith({
      sessionRoot: "/tmp/rakazo-test-data/pi-sessions",
    });
    expect(agentRuntimeOptionsFromEnv({ PI_SESSION_RECORDING: "1" }).recordPiSessions).toBe(false);
  });
  it.each(["", "unknown", "PI", " dsh "])(
    "rejects invalid selection %j without falling back",
    (kind) => {
      expect(() => createAgentRuntime({ kind })).toThrow("Unknown AGENT_RUNTIME");
      expect(() => agentRuntimeOptionsFromEnv({ AGENT_RUNTIME: kind })).toThrow(
        "Unknown AGENT_RUNTIME",
      );
      expect(calls.constructPi).not.toHaveBeenCalled();
    },
  );
  it("rejects missing, relative, and unavailable DSH configuration", () => {
    expect(() => createAgentRuntime({ kind: "dsh" })).toThrow("AGENT_RUNTIME_BOT_ID");
    expect(() =>
      agentRuntimeOptionsFromEnv({ AGENT_RUNTIME: "dsh", AGENT_RUNTIME_BOT_ID: "bot" }),
    ).toThrow("absolute DSH_CLI_PATH");
    expect(() =>
      agentRuntimeOptionsFromEnv({
        AGENT_RUNTIME: "dsh",
        AGENT_RUNTIME_BOT_ID: "bot",
        DSH_CLI_PATH: "relative.js",
      }),
    ).toThrow("absolute DSH_CLI_PATH");
    expect(() =>
      createAgentRuntime({ kind: "dsh", dsh: { cliPath: "/opt/dsh/bin.js", botId: "bot" } }),
    ).toThrow("0.2.1-alpha.2");
  });
  it("routes only selected bots to DSH, reports conservative capabilities, and cancels both runtimes", async () => {
    const implementation = dsh();
    const options = agentRuntimeOptionsFromEnv({
      AGENT_RUNTIME: "dsh",
      AGENT_RUNTIME_BOT_ID: "pilot",
      DSH_CLI_PATH: "/opt/dsh/bin.js",
    });
    const constructDsh = vi.fn(() => implementation);
    const runtime = createAgentRuntime(options, constructDsh);
    const request = { botId: "pilot", runId: "run" } as AgentRunRequest;
    runtime.run(request);
    runtime.run({ ...request, botId: "other" });
    expect(constructDsh).toHaveBeenCalledExactlyOnceWith(options.dsh);
    expect(implementation.run).toHaveBeenCalledExactlyOnceWith(request, undefined);
    expect(calls.runPi).toHaveBeenCalledExactlyOnceWith({ ...request, botId: "other" }, undefined);
    expect(runtime.describe().capabilities).toEqual({
      streaming: true,
      tools: true,
      compaction: false,
      scripted: false,
    });
    await runtime.abort("run");
    expect(implementation.abort).toHaveBeenCalledWith("run");
    expect(calls.abortPi).toHaveBeenCalledWith("run");
  });
});
