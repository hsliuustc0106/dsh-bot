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
