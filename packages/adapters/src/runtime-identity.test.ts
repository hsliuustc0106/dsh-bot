import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { recordRuntimeIdentity } from "./runtime-identity.js";

it.each([1, 0])(
  "records the selected bot's runtime only under the active lease (%i matched)",
  async (count) => {
    const updateMany = vi.fn(async () => ({ count }));
    const prisma = { run: { updateMany } } as unknown as PrismaClient;
    const runtime = {
      describe: vi.fn(() => ({ id: "test-runtime", adapterVersion: "1+revision" })),
    } as unknown as AgentRuntime;
    const target = { runId: "run", botId: "selected", workerId: "worker", fence: 7 };
    const result = recordRuntimeIdentity(prisma, runtime, target);
    if (count) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("lease lost");
    expect(runtime.describe).toHaveBeenCalledExactlyOnceWith({ botId: "selected" });
    expect(updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "run", status: "running", leaseOwner: "worker", leaseFence: 7 },
      data: { runtimeId: "test-runtime", runtimeVersion: "1+revision" },
    });
  },
);

it("claims the invocation before returning a protected runtime identity", async () => {
  const create = vi.fn(async () => ({}));
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: { findFirst: vi.fn(async () => ({ spaceId: "space", runtimeInputGeneration: 2 })) },
    externalEffect: { findUnique: vi.fn(async () => null), create },
  };
  const prisma = {
    run: { updateMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: async (callback: (client: typeof tx) => unknown) => callback(tx),
  } as unknown as PrismaClient;
  const runtime = {
    describe: () => ({
      id: "test",
      adapterVersion: "1",
      capabilities: { requiresInvocationClaim: true },
    }),
  } as unknown as AgentRuntime;
  await recordRuntimeIdentity(prisma, runtime, {
    runId: "run",
    botId: "bot",
    workerId: "worker",
    fence: 3,
  });
  expect(create).toHaveBeenCalledExactlyOnceWith({
    data: {
      runId: "run",
      spaceId: "space",
      kind: "runtime_invocation",
      idempotencyKey: "runtime-invocation:run:2",
      status: "claimed",
      request: { generation: 2, fence: 3 },
    },
  });
});
