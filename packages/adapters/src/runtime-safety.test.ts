import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  claimFreshRuntime,
  markInterruptedRuntimeTools,
  runtimeToolLedger,
} from "./runtime-safety.js";

function database() {
  const row = { status: "absent", request: undefined as unknown };
  let claimed = false;
  const prisma = {
    run: {
      updateMany: vi.fn(async () => {
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      }),
    },
    externalEffect: {
      create: vi.fn(async ({ data }) => {
        if (row.status !== "absent") throw new Error("duplicate");
        row.status = data.status;
        row.request = data.request;
        return { id: "effect" };
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const valid =
          typeof where.status === "string"
            ? row.status === where.status
            : where.status.in.includes(row.status);
        if (valid) row.status = data.status;
        return { count: valid ? 1 : 0 };
      }),
    },
  };
  return { row, raw: prisma, prisma: prisma as unknown as PrismaClient };
}
const target = { runId: "run", spaceId: "space" };
describe("non-replayable runtime safety", () => {
  it("claims once under the active lease before any runtime starts", async () => {
    const { prisma, raw } = database();
    const lease = { runId: "run", workerId: "worker", fence: 2 };
    await claimFreshRuntime(prisma, lease, "dsh");
    await expect(claimFreshRuntime(prisma, lease, "pi")).rejects.toThrow(
      "cannot be resumed safely",
    );
    expect(raw.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "run",
          status: "running",
          leaseOwner: "worker",
          leaseFence: 2,
          runtimeNoReplay: false,
        },
        data: { executionRuntime: "dsh", runtimeNoReplay: true },
      }),
    );
  });
  it("persists only metadata before dispatch and never replays an execution identity", async () => {
    const { prisma, row } = database();
    const execute = vi.fn(async () => {
      expect(row.status).toBe("executing");
      return { content: "private output" };
    });
    const ledger = runtimeToolLedger(prisma, target, execute);
    await ledger.executeTool("read_file", { private: "input" }, "call");
    expect(row.status).toBe("completed");
    expect(row.request).toEqual({ name: "read_file", executionId: "call" });
    await expect(ledger.executeTool("read_file", {}, "call")).rejects.toThrow("duplicate");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("records uncertainty on rejection without replaying the call", async () => {
    const { prisma, row } = database();
    const execute = vi.fn(async () => {
      throw new Error("remote connection lost");
    });
    await expect(
      runtimeToolLedger(prisma, target, execute).executeTool("read_file", {}, "call"),
    ).rejects.toThrow();
    expect(row.status).toBe("uncertain");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("records uncertainty on restart, then records a known late return without dispatching again", async () => {
    const { prisma, row } = database();
    const result = deferred<string>();
    const started = deferred<void>();
    const execute = vi.fn(async () => {
      started.resolve();
      return result.promise;
    });
    const ledger = runtimeToolLedger(prisma, target, execute);
    const work = ledger.executeTool("read_file", {}, "call");
    await started.promise;
    await markInterruptedRuntimeTools(prisma, "run");
    expect(row.status).toBe("uncertain");
    result.resolve("known result");
    expect(await work).toBe("known result");
    expect(row.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
  });
  it("does not dispatch when cancelled before persistence or when persistence fails", async () => {
    const { prisma, raw } = database();
    const execute = vi.fn();
    const ledger = runtimeToolLedger(prisma, target, execute);
    await expect(
      ledger.executeTool("read_file", {}, "cancelled", undefined, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(raw.externalEffect.create).not.toHaveBeenCalled();
    raw.externalEffect.create.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(ledger.executeTool("read_file", {}, "call")).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("the real executor refuses an interrupted runtime even after rollback to Pi", async () => {
  const { createRunExecutor } = await import("./executor.js");
  const run = {
    id: "run",
    spaceId: "space",
    botId: "bot",
    threadId: "thread",
    taskId: "task",
    status: "running",
    leaseFence: 1,
    leaseOwner: "old-worker",
    runtimeNoReplay: true,
    executionRuntime: "dsh",
  };
  const runtimeRun = vi.fn();
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const markUncertain = vi.fn(async () => ({ count: 1 }));
  const executor = createRunExecutor({
    prisma: {
      run: {
        findUnique: vi.fn(async () => run),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ ...run, status: "leased" })),
      },
      attempt: { create: vi.fn(async () => ({ id: "attempt" })) },
      externalEffect: { updateMany: markUncertain },
    },
    runtime: { describe: () => ({ id: "pi" }), run: runtimeRun },
    events: { finalizeRun },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  await executor.continueRun("run", "new-worker");
  expect(runtimeRun).not.toHaveBeenCalled();
  expect(markUncertain).toHaveBeenCalledWith({
    where: { runId: "run", kind: "runtime_tool", status: "executing" },
    data: { status: "uncertain" },
  });
  expect(finalizeRun).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: "failed",
      error: expect.stringContaining("cannot be resumed safely"),
    }),
  );
});
