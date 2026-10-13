import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeToolLedger, reconcileRuntimeToolLedger } from "./runtime-tool-ledger.js";

const target = { runId: "run", spaceId: "space", workerId: "worker", fence: 3 };
function fixture() {
  const records = new Map<string, { status: string; request: unknown }>();
  const create = vi.fn(async ({ data }) => {
    if (records.has(data.idempotencyKey)) throw new Error("Unique key conflict");
    records.set(data.idempotencyKey, { status: data.status, request: data.request });
  });
  const updateMany = vi.fn(async ({ where, data }) => {
    let count = 0;
    for (const [key, row] of records) {
      if (where.idempotencyKey && key !== where.idempotencyKey) continue;
      const allowed = typeof where.status === "string" ? [where.status] : where.status.in;
      if (allowed.includes(row.status)) {
        row.status = data.status;
        count++;
      }
    }
    return { count };
  });
  const findFirst = vi.fn(async () => ({ id: "run" }) as { id: string } | null);
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: { findFirst },
    externalEffect: {
      create,
      updateMany,
      findFirst: vi.fn(
        async () =>
          [...records.values()].find(
            (row) =>
              row.status === "uncertain" ||
              (row.status === "executing" &&
                (row.request as { fence: number }).fence !== target.fence),
          ) ?? null,
      ),
    },
  };
  const prisma = {
    ...tx,
    $transaction: async (callback: (transaction: typeof tx) => unknown) => callback(tx),
  } as unknown as PrismaClient;
  const controller = new AbortController();
  const execute = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }));
  const ledger = createRuntimeToolLedger(prisma, target, execute, controller.signal);
  const status = () => [...records.values()][0]?.status;
  return { prisma, records, create, updateMany, findFirst, controller, execute, ledger, status };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("durable runtime host-tool outcomes", () => {
  it("records intent before dispatch, stores no arguments/results, and rejects duplicate wakes", async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      expect(f.status()).toBe("executing");
      return { value: "private-result" };
    });
    await expect(
      f.ledger.executeTool("write", { value: "private-argument" }, "call"),
    ).resolves.toEqual({ value: "private-result" });
    expect(f.status()).toBe("completed");
    const restarted = createRuntimeToolLedger(f.prisma, target, f.execute, f.controller.signal);
    await expect(restarted.executeTool("write", {}, "call")).rejects.toThrow("Unique key");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect([...f.records.values()]).toEqual([
      { status: "completed", request: { name: "write", fence: 3 } },
    ]);
    expect(f.findFirst).toHaveBeenCalledWith({
      where: {
        id: "run",
        spaceId: "space",
        status: "running",
        leaseOwner: "worker",
        leaseFence: 3,
        leaseExpiresAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
  });

  it.each(["lease", "persistence"])("does not dispatch when %s fails", async (failure) => {
    const f = fixture();
    if (failure === "lease") f.findFirst.mockResolvedValue(null);
    else f.create.mockRejectedValue(new Error("database unavailable"));
    await expect(f.ledger.executeTool("write", {}, "call")).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("marks cancellation uncertain without waiting for the remote action; a late result settles it", async () => {
    const f = fixture();
    const remote = deferred<unknown>();
    const entered = deferred<void>();
    f.execute.mockImplementation(async () => {
      entered.resolve();
      return remote.promise;
    });
    const result = f.ledger.executeTool("write", {}, "call");
    await entered.promise;
    f.controller.abort();
    await f.ledger.close();
    expect(f.status()).toBe("uncertain");
    remote.resolve({ ok: true });
    await result;
    expect(f.status()).toBe("completed");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("tracks the process cancellation signal independently of the run", async () => {
    const f = fixture();
    const process = new AbortController();
    const entered = deferred<void>();
    const remote = deferred<unknown>();
    f.execute.mockImplementation(async () => {
      entered.resolve();
      return remote.promise;
    });
    const result = f.ledger.executeTool("write", {}, "call", undefined, { signal: process.signal });
    await entered.promise;
    process.abort();
    await f.ledger.close();
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.status()).toBe("uncertain");
    remote.resolve(null);
    await result;
  });

  it("retains uncertainty when dispatch throws and does not retry", async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error("response lost"));
    await expect(f.ledger.executeTool("write", {}, "call")).rejects.toThrow("response lost");
    expect(f.status()).toBe("uncertain");
    await expect(f.ledger.executeTool("write", {}, "different-call")).rejects.toThrow(
      "requires reconciliation",
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("stops when a tool returns an explicitly uncertain outcome", async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ error: "response lost", uncertain: true });
    await expect(f.ledger.executeTool("write", {}, "call")).rejects.toThrow("outcome is uncertain");
    expect(f.status()).toBe("uncertain");
  });

  it("blocks new dispatch while an older worker's action is still executing", async () => {
    const f = fixture();
    f.records.set("old-call", { status: "executing", request: { name: "write", fence: 2 } });
    await expect(f.ledger.executeTool("write", {}, "new-call")).rejects.toThrow(
      "requires reconciliation",
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("marks an outstanding host action uncertain when the process ends without abort", async () => {
    const f = fixture();
    const entered = deferred<void>();
    const remote = deferred<unknown>();
    f.execute.mockImplementation(async () => {
      entered.resolve();
      return remote.promise;
    });
    const result = f.ledger.executeTool("write", {}, "call");
    await entered.promise;
    await f.ledger.close();
    expect(f.status()).toBe("uncertain");
    remote.resolve({ ok: true });
    await result;
    expect(f.status()).toBe("completed");
  });

  it("leaves durable intent when result persistence fails", async () => {
    const f = fixture();
    f.updateMany.mockRejectedValue(new Error("database unavailable"));
    await expect(f.ledger.executeTool("write", {}, "call")).rejects.toThrow("database unavailable");
    expect(f.status()).toBe("executing");
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it("does not let a delayed cancellation write overwrite a known result", async () => {
    const f = fixture();
    const remote = deferred<unknown>();
    const entered = deferred<void>();
    const release = deferred<void>();
    const update = f.updateMany.getMockImplementation()!;
    f.updateMany.mockImplementation(async (input) => {
      if (input.data.status === "uncertain") await release.promise;
      return update(input);
    });
    f.execute.mockImplementation(async () => {
      entered.resolve();
      return remote.promise;
    });
    const result = f.ledger.executeTool("write", {}, "call");
    await entered.promise;
    f.controller.abort();
    remote.resolve({ ok: true });
    await result;
    release.resolve();
    await f.ledger.close();
    expect(f.status()).toBe("completed");
  });

  it("cannot dispatch after its invocation closes", async () => {
    const f = fixture();
    await f.ledger.close();
    await expect(f.ledger.executeTool("write", {}, "call")).rejects.toThrow("ledger is closed");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  });

  it("reconciles terminal or abandoned leases without calling the executor", async () => {
    const f = fixture();
    const now = new Date("2026-01-01T00:00:00Z");
    await reconcileRuntimeToolLedger(f.prisma, now);
    expect(f.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        kind: "runtime_host_tool",
        status: "executing",
        run: {
          OR: [
            {
              status: {
                in: ["completed", "failed", "cancelled", "waiting_input", "waiting_takeover"],
              },
            },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
      },
      data: { status: "uncertain" },
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
});
