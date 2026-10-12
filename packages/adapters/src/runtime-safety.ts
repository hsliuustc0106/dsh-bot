import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

export const RUNTIME_RECONCILIATION_MESSAGE =
  "This run cannot be resumed safely. Verify unfinished actions before starting a new run.";
const ledgerKind = "runtime_tool";
const key = (runId: string, executionId: string) => `runtime-tool:${runId}:${executionId}`;

/** Commit the no-replay marker before the model process or any tool can start. */
export async function claimFreshRuntime(
  prisma: PrismaClient,
  target: { runId: string; workerId: string; fence: number },
  runtimeId: string,
) {
  const claimed = await prisma.run.updateMany({
    where: {
      id: target.runId,
      status: "running",
      leaseOwner: target.workerId,
      leaseFence: target.fence,
      runtimeNoReplay: false,
    },
    data: { executionRuntime: runtimeId, runtimeNoReplay: true },
  });
  if (claimed.count !== 1) throw new Error(RUNTIME_RECONCILIATION_MESSAGE);
}

/** Metadata only: never persist raw arguments, model context or tool output. */
export function runtimeToolLedger(
  prisma: PrismaClient,
  target: { runId: string; spaceId: string },
  execute: NonNullable<AgentRunRequest["executeTool"]>,
) {
  const uncertain = async (executionId: string) => {
    await prisma.externalEffect.updateMany({
      where: {
        runId: target.runId,
        kind: ledgerKind,
        idempotencyKey: key(target.runId, executionId),
        status: "executing",
      },
      data: { status: "uncertain" },
    });
  };
  const executeTool: NonNullable<AgentRunRequest["executeTool"]> = async (
    name,
    args,
    executionId,
    route,
    observer,
  ) => {
    observer?.signal?.throwIfAborted();
    await prisma.externalEffect.create({
      data: {
        ...target,
        kind: ledgerKind,
        idempotencyKey: key(target.runId, executionId),
        status: "executing",
        request: { name, executionId },
      },
    });
    try {
      observer?.signal?.throwIfAborted();
      const result = await execute(name, args, executionId, route, observer);
      // A known late return can resolve uncertainty, but never dispatches again.
      await prisma.externalEffect.updateMany({
        where: {
          runId: target.runId,
          kind: ledgerKind,
          idempotencyKey: key(target.runId, executionId),
          status: { in: ["executing", "uncertain"] },
        },
        data: { status: "completed" },
      });
      return result;
    } catch (error) {
      await uncertain(executionId);
      throw error;
    }
  };
  return { executeTool, onToolUncertain: uncertain };
}

export async function markInterruptedRuntimeTools(prisma: PrismaClient, runId: string) {
  await prisma.externalEffect.updateMany({
    where: { runId, kind: ledgerKind, status: "executing" },
    data: { status: "uncertain" },
  });
}

/** Also covers a worker dying after a run was already cancelled or finalized. */
export async function reconcileRuntimeToolOutcomes(prisma: PrismaClient, now: Date) {
  await prisma.externalEffect.updateMany({
    where: {
      kind: ledgerKind,
      status: "executing",
      run: {
        runtimeNoReplay: true,
        OR: [
          { status: { in: ["completed", "failed", "cancelled"] } },
          { leaseExpiresAt: { lte: now } },
        ],
      },
    },
    data: { status: "uncertain" },
  });
}
