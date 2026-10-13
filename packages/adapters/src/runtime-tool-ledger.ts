import { createHash } from "node:crypto";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

const kind = "runtime_host_tool";
type Execute = NonNullable<AgentRunRequest["executeTool"]>;
type Target = { runId: string; spaceId: string; workerId: string; fence: number };

/** Persist dispatch intent before calling a host tool. Never store arguments or results. */
export function createRuntimeToolLedger(
  prisma: PrismaClient,
  target: Target,
  execute: Execute,
  runSignal: AbortSignal,
) {
  const active = new Set<string>();
  const writes = new Set<Promise<void>>();
  let persistenceFailure: unknown;
  let closed = false;
  const uncertain = async (idempotencyKey: string) => {
    await prisma.externalEffect.updateMany({
      where: { runId: target.runId, kind, idempotencyKey, status: "executing" },
      data: { status: "uncertain" },
    });
  };
  const trackUncertainty = (idempotencyKey: string) => {
    const write = uncertain(idempotencyKey).catch((error: unknown) => {
      persistenceFailure = error;
    });
    writes.add(write);
    void write.finally(() => writes.delete(write));
  };
  const executeTool: Execute = async (name, args, executionId, route, observer) => {
    const signal = observer?.signal ? AbortSignal.any([runSignal, observer.signal]) : runSignal;
    signal.throwIfAborted();
    if (closed) throw new Error("Runtime host tool ledger is closed");
    const idempotencyKey = `runtime-host-tool:${createHash("sha256")
      .update(JSON.stringify([target.runId, executionId]))
      .digest("hex")}`;
    await prisma.$transaction(async (tx) => {
      // Serialize authorization with cancellation and worker lease transitions.
      await tx.$queryRaw`SELECT id FROM runs WHERE id = ${target.runId} FOR UPDATE`;
      const owner = await tx.run.findFirst({
        where: {
          id: target.runId,
          spaceId: target.spaceId,
          status: "running",
          leaseOwner: target.workerId,
          leaseFence: target.fence,
          leaseExpiresAt: { gt: new Date() },
        },
        select: { id: true },
      });
      if (!owner) throw new Error("Run lease lost before host tool dispatch");
      const unresolved = await tx.externalEffect.findFirst({
        where: {
          runId: target.runId,
          kind,
          OR: [
            { status: "uncertain" },
            { status: "executing", request: { path: ["fence"], not: target.fence } },
          ],
        },
        select: { id: true },
      });
      if (unresolved) throw new Error("An earlier host action requires reconciliation");
      signal.throwIfAborted();
      // Unique key failure is terminal: never replay a previously dispatched call.
      await tx.externalEffect.create({
        data: {
          runId: target.runId,
          spaceId: target.spaceId,
          kind,
          idempotencyKey,
          status: "executing",
          request: { name, fence: target.fence },
        },
      });
    });
    active.add(idempotencyKey);
    const aborted = () => trackUncertainty(idempotencyKey);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      if (closed) throw new Error("Runtime host tool ledger is closed");
      const result = await execute(name, args, executionId, route, { ...observer, signal });
      if (
        result &&
        typeof result === "object" &&
        "uncertain" in result &&
        result.uncertain === true
      )
        throw new Error("Host tool outcome is uncertain; verify the action before retrying");
      // A late known result may resolve uncertainty, but cannot initiate another action.
      const saved = await prisma.externalEffect.updateMany({
        where: {
          runId: target.runId,
          kind,
          idempotencyKey,
          status: { in: ["executing", "uncertain"] },
        },
        data: { status: "completed" },
      });
      if (saved.count !== 1) throw new Error("Host tool outcome could not be recorded");
      return result;
    } catch (error) {
      await uncertain(idempotencyKey);
      throw error;
    } finally {
      signal.removeEventListener("abort", aborted);
      active.delete(idempotencyKey);
    }
  };
  return {
    executeTool,
    async close() {
      closed = true;
      // Process exit is not evidence that an outstanding remote operation stopped.
      await Promise.all([...active].map(uncertain));
      await Promise.all(writes);
      if (persistenceFailure) throw persistenceFailure;
    },
  };
}

/** Worker death has no abort callback; recover intent records without replaying tools. */
export async function reconcileRuntimeToolLedger(prisma: PrismaClient, now = new Date()) {
  await prisma.externalEffect.updateMany({
    where: {
      kind,
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
}
