import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { validateInstallation } from "./process-client.js";
import { JIUWENSWARM_REVISION } from "./version.js";

const calls = vi.hoisted(() => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...(await original<object>()), ...calls }));
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});
const installation = { pythonPath: "/opt/runtime/python", sourceDir: "/opt/runtime/source" };
function prepare() {
  calls.execFileSync.mockReturnValueOnce(JIUWENSWARM_REVISION).mockReturnValueOnce("");
  calls.spawnSync.mockReturnValue({
    status: 0,
    stdout: JSON.stringify({
      type: "query_result",
      status: "completed",
      exit_code: 0,
      schema_version: "0.1",
      request_id: "rakazo-probe",
      data: { protocol_revision: 1, features: { empty_tools: true, stable_event_fields: true } },
    }),
  });
}
it("probes the pinned clean installation without inheriting environment or cwd", () => {
  prepare();
  vi.stubEnv("RAKAZO_TEST_SECRET", "fake");
  validateInstallation(installation);
  const [command, args, options] = calls.spawnSync.mock.calls[0]!;
  expect(command).toBe(installation.pythonPath);
  expect(args).toContain("-I");
  expect(args).toContain(installation.sourceDir);
  expect(options.env.RAKAZO_TEST_SECRET).toBeUndefined();
  expect(options.env.HOME).toBe(options.cwd);
  expect(existsSync(options.cwd)).toBe(false);
});
it.each(["wrong-revision", "dirty", "unsupported", "malformed", "crash"])(
  "rejects %s at startup",
  (mode) => {
    if (mode === "wrong-revision") calls.execFileSync.mockReturnValue("different");
    else if (mode === "dirty")
      calls.execFileSync
        .mockReturnValueOnce(JIUWENSWARM_REVISION)
        .mockReturnValueOnce(" M file.py");
    else {
      prepare();
      calls.spawnSync.mockReturnValue({
        status: mode === "crash" ? 1 : 0,
        stdout: mode === "malformed" ? "bad" : "{}",
      });
    }
    expect(() => validateInstallation(installation)).toThrow(JIUWENSWARM_REVISION);
    if (mode === "wrong-revision" || mode === "dirty")
      expect(calls.spawnSync).not.toHaveBeenCalled();
  },
);
