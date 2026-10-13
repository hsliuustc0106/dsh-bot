import { randomUUID } from "node:crypto";
import type { RuntimeSessionCoordinator } from "@rakazo/adapter-kit";
import { RuntimeSessionBusyError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { claimRuntimeInvocationInTransaction } from "./runtime-identity.js";

/** Thread lock first, matching answer/finalize transactions; never steal an active session. */
export function createRuntimeSessionCoordinator(
  prisma: PrismaClient,
  target: {
    runId: string;
    botId: string;
    threadId: string;
    spaceId: string;
    workerId: string;
    fence: number;
    runtimeId: string;
  },
): RuntimeSessionCoordinator {
  return {
    async acquire(definition) {
      const token = randomUUID();
      const session = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM threads WHERE id = ${target.threadId} FOR UPDATE`;
        const run = await tx.run.findFirst({
          where: {
            id: target.runId,
            botId: target.botId,
            threadId: target.threadId,
            spaceId: target.spaceId,
            status: "running",
            leaseOwner: target.workerId,
            leaseFence: target.fence,
            leaseExpiresAt: { gt: new Date() },
          },
          select: { id: true, trigger: true },
        });
        if (!run) throw new Error("Run lease lost before session acquisition");
        const thread = await tx.thread.findUniqueOrThrow({
          where: { id: target.threadId },
          select: { historyCompactionGeneration: true },
        });
        // Clearing/compacting history must not retain a hidden upstream transcript.
        const scopedDefinition = JSON.stringify([
          definition,
          thread.historyCompactionGeneration,
          run.trigger === "routine" || run.trigger === "created"
            ? run.id
            : ["user", "follow_up"].includes(run.trigger)
              ? "conversation"
              : run.trigger,
        ]);
        const key = { threadId: target.threadId, botId: target.botId, runtimeId: target.runtimeId };
        const previous = await tx.runtimeConversation.findUnique({
          where: { threadId_botId_runtimeId: key },
        });
        if (previous?.status === "active") {
          // Allows bounded cleanup after a rapid answer, without takeover after worker death.
          if (previous.acquiredAt && Date.now() - previous.acquiredAt.getTime() < 150_000)
            throw new RuntimeSessionBusyError();
          throw new Error("Interrupted runtime session requires reconciliation");
        }
        const unresolved = await tx.externalEffect.findFirst({
          where: {
            kind: "runtime_host_tool",
            status: { in: ["executing", "uncertain"] },
            run: { threadId: target.threadId, botId: target.botId, spaceId: target.spaceId },
          },
          select: { id: true },
        });
        if (unresolved) throw new Error("An earlier conversation action requires reconciliation");
        // Busy acquisition never consumes the invocation generation.
        await claimRuntimeInvocationInTransaction(tx, target);
        const reset =
          !previous || previous.status === "uncertain" || previous.definition !== scopedDefinition;
        return tx.runtimeConversation.upsert({
          where: { threadId_botId_runtimeId: key },
          create: {
            ...key,
            definition: scopedDefinition,
            storageKey: randomUUID(),
            status: "active",
            activeToken: token,
            acquiredAt: new Date(),
          },
          update: {
            definition: scopedDefinition,
            status: "active",
            activeToken: token,
            acquiredAt: new Date(),
            ...(reset ? { storageKey: randomUUID(), checkpoint: null } : {}),
          },
        });
      });
      return {
        storageKey: session.storageKey,
        checkpoint: session.checkpoint,
        async finish(outcome, checkpoint) {
          if (outcome === "completed" && !checkpoint)
            throw new Error("Runtime session checkpoint is missing");
          const updated = await prisma.runtimeConversation.updateMany({
            where: { id: session.id, activeToken: token, status: "active" },
            data: {
              activeToken: null,
              acquiredAt: null,
              status: outcome === "interrupted" ? "uncertain" : "ready",
              ...(outcome === "completed" ? { checkpoint } : {}),
              // Cancellation can leave a half-written upstream conversation. An answered
              // pause starts a new generation, with Rakazo history, after cleanup completes.
              ...(outcome === "paused" ? { checkpoint: null, storageKey: randomUUID() } : {}),
            },
          });
          if (updated.count !== 1) throw new Error("Runtime session ownership was lost");
        },
      };
    },
  };
}
