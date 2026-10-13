import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";

/** Record the selected runtime under the same lease that authorizes execution. */
export async function recordRuntimeIdentity(
  prisma: PrismaClient,
  runtime: AgentRuntime,
  target: { runId: string; botId: string; workerId: string; fence: number },
): Promise<void> {
  const descriptor = runtime.describe({ botId: target.botId });
  const updated = await prisma.run.updateMany({
    where: {
      id: target.runId,
      status: "running",
      leaseOwner: target.workerId,
      leaseFence: target.fence,
    },
    data: { runtimeId: descriptor.id, runtimeVersion: descriptor.adapterVersion },
  });
  if (updated.count !== 1) throw new Error("Run lease lost before runtime start");
}
