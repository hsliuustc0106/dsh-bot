import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { answerRunInput, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { claimRuntimeInvocation } from "./runtime-identity.js";
import { createRuntimeSessionCoordinator } from "./runtime-session.js";
import { createRuntimeToolLedger, reconcileRuntimeToolLedger } from "./runtime-tool-ledger.js";

const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describePostgres("runtime recovery with PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const users: string[] = [];
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
  });
  afterAll(async () => {
    if (!db) return;
    await prisma.organization.deleteMany({ where: { id: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
    await db.pool.end();
  });
  async function setup() {
    const id = randomUUID();
    users.push(id);
    await prisma.user.create({
      data: { id, name: "Recovery test", email: `${id}@example.test`, emailVerified: true },
    });
    await prisma.organization.create({
      data: { id, name: "Recovery test", slug: id, createdAt: new Date() },
    });
    await prisma.space.create({
      data: { id, organizationId: id, name: "Recovery test", isDefault: true },
    });
    const bot = await prisma.bot.create({
      data: { spaceId: id, userId: id, name: "Recovery test", color: "test-color" },
    });
    const thread = await prisma.thread.create({ data: { spaceId: id, userId: id, botId: bot.id } });
    const task = await prisma.task.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        prompt: "Test",
        status: "running",
      },
    });
    const run = await prisma.run.create({
      data: {
        spaceId: id,
        userId: id,
        botId: bot.id,
        threadId: thread.id,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    return {
      id,
      run,
      target: { runId: run.id, spaceId: id, botId: bot.id, workerId: "worker", fence: 1 },
    };
  }

  it("allows exactly one invocation when duplicate workers race", async () => {
    const f = await setup();
    const claims = await Promise.allSettled([
      claimRuntimeInvocation(prisma, f.target),
      claimRuntimeInvocation(prisma, f.target),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_invocation" } }),
    ).toBe(1);
  });

  it("rejects replay under a new worker lease, even before any host callbacks existed", async () => {
    const f = await setup();
    await claimRuntimeInvocation(prisma, f.target);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseFence: 2, leaseOwner: "replacement" },
    });
    await expect(
      claimRuntimeInvocation(prisma, { ...f.target, workerId: "replacement", fence: 2 }),
    ).rejects.toThrow("cannot be replayed");
  });

  it("only a validated pending answer permits one more invocation", async () => {
    const f = await setup();
    await claimRuntimeInvocation(prisma, f.target);
    await prisma.run.update({
      where: { id: f.run.id },
      data: { status: "waiting_input", leaseOwner: null, leaseExpiresAt: null },
    });
    const message = await prisma.message.create({
      data: {
        threadId: f.run.threadId,
        runId: f.run.id,
        botId: f.run.botId,
        seq: 1,
        role: "bot",
        blocks: [
          {
            kind: "ask",
            text: "Choose",
            status: "pending",
            actions: [
              { id: "one", label: "One" },
              { id: "two", label: "Two" },
            ],
          },
        ],
      },
    });
    const answer = {
      spaceId: f.id,
      threadId: f.run.threadId,
      runId: f.run.id,
      messageId: message.id,
      answeredByUserId: f.id,
      answer: "one",
    };
    expect(await answerRunInput(prisma, { ...answer, spaceId: "foreign" })).toBe(false);
    expect(await answerRunInput(prisma, { ...answer, messageId: "stale" })).toBe(false);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).runtimeInputGeneration,
    ).toBe(0);
    const answers = await Promise.all([
      answerRunInput(prisma, answer),
      answerRunInput(prisma, answer),
    ]);
    expect(answers.sort()).toEqual([false, true]);
    expect(
      (await prisma.run.findUniqueOrThrow({ where: { id: f.run.id } })).runtimeInputGeneration,
    ).toBe(1);
    await prisma.run.update({
      where: { id: f.run.id },
      data: {
        status: "running",
        leaseOwner: "worker",
        leaseFence: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await claimRuntimeInvocation(prisma, { ...f.target, fence: 2 });
    await expect(claimRuntimeInvocation(prisma, { ...f.target, fence: 2 })).rejects.toThrow(
      "cannot be replayed",
    );
  });

  it("deduplicates concurrent tool dispatch across independent ledger instances", async () => {
    const f = await setup();
    const execute = vi.fn(async () => ({ ok: true }));
    const signal = new AbortController().signal;
    const first = createRuntimeToolLedger(prisma, f.target, execute, signal);
    const second = createRuntimeToolLedger(prisma, f.target, execute, signal);
    const results = await Promise.allSettled([
      first.executeTool("write", {}, "call"),
      second.executeTool("write", {}, "call"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, status: "completed" } }),
    ).toBe(1);
  });

  it("recovers an expired worker's in-flight action and accepts its late result without replay", async () => {
    const f = await setup();
    const entered = deferred<void>();
    const remote = deferred<unknown>();
    const execute = vi.fn(async () => {
      entered.resolve();
      return remote.promise;
    });
    const ledger = createRuntimeToolLedger(prisma, f.target, execute, new AbortController().signal);
    const result = ledger.executeTool("write", { private: "do-not-store" }, "call");
    await entered.promise;
    await prisma.run.update({ where: { id: f.run.id }, data: { leaseExpiresAt: new Date(0) } });
    await reconcileRuntimeToolLedger(prisma);
    const row = await prisma.externalEffect.findFirstOrThrow({
      where: { runId: f.run.id, kind: "runtime_host_tool" },
    });
    expect(row.status).toBe("uncertain");
    expect(row.request).toEqual({ name: "write", fence: 1 });
    await prisma.run.update({
      where: { id: f.run.id },
      data: { leaseFence: 2, leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    const restarted = createRuntimeToolLedger(
      prisma,
      { ...f.target, fence: 2 },
      execute,
      new AbortController().signal,
    );
    await expect(restarted.executeTool("write", {}, "different-call")).rejects.toThrow(
      "requires reconciliation",
    );
    remote.resolve({ ok: true });
    await result;
    expect((await prisma.externalEffect.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "completed",
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("serializes session turns without consuming a busy invocation, and fences late cleanup", async () => {
    const f = await setup();
    const coordinator = createRuntimeSessionCoordinator(prisma, {
      ...f.target,
      threadId: f.run.threadId,
      runtimeId: "test",
    });
    const first = await coordinator.acquire("definition");
    await expect(coordinator.acquire("definition")).rejects.toThrow("session is busy");
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_invocation" } }),
    ).toBe(1);
    await first.finish("completed", "checkpoint");
    await expect(coordinator.acquire("definition")).rejects.toThrow("cannot be replayed");
    await prisma.run.update({
      where: { id: f.run.id },
      data: { runtimeInputGeneration: { increment: 1 } },
    });
    const next = await coordinator.acquire("definition");
    expect(next.storageKey).toBe(first.storageKey);
    expect(next.checkpoint).toBe("checkpoint");
    await expect(first.finish("interrupted")).rejects.toThrow("ownership was lost");
    await next.finish("completed", "next-checkpoint");
  });

  it("rotates storage after definition changes, history clearing, and answered pauses", async () => {
    const f = await setup();
    const coordinator = createRuntimeSessionCoordinator(prisma, {
      ...f.target,
      threadId: f.run.threadId,
      runtimeId: "test",
    });
    const first = await coordinator.acquire("definition");
    await first.finish("completed", "checkpoint");
    const advance = () =>
      prisma.run.update({
        where: { id: f.run.id },
        data: { runtimeInputGeneration: { increment: 1 } },
      });
    await advance();
    const changed = await coordinator.acquire("changed-definition");
    expect(changed.storageKey).not.toBe(first.storageKey);
    expect(changed.checkpoint).toBeNull();
    await changed.finish("completed", "checkpoint");
    await prisma.thread.update({
      where: { id: f.run.threadId },
      data: { historyCompactionGeneration: { increment: 1 } },
    });
    await advance();
    const cleared = await coordinator.acquire("changed-definition");
    expect(cleared.storageKey).not.toBe(changed.storageKey);
    expect(cleared.checkpoint).toBeNull();
    await cleared.finish("paused");
    await advance();
    const answered = await coordinator.acquire("changed-definition");
    expect(answered.storageKey).not.toBe(cleared.storageKey);
    expect(answered.checkpoint).toBeNull();
    await answered.finish("completed", "checkpoint");
  });

  it("never steals an abandoned session after its bounded cleanup window", async () => {
    const f = await setup();
    const coordinator = createRuntimeSessionCoordinator(prisma, {
      ...f.target,
      threadId: f.run.threadId,
      runtimeId: "test",
    });
    await coordinator.acquire("definition");
    await prisma.runtimeConversation.updateMany({
      where: { threadId: f.run.threadId },
      data: { acquiredAt: new Date(0) },
    });
    await expect(coordinator.acquire("definition")).rejects.toThrow("requires reconciliation");
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_invocation" } }),
    ).toBe(1);
  });

  it("never replays an interrupted invocation; fresh user input starts a new session after cleanup", async () => {
    const f = await setup();
    const target = { ...f.target, threadId: f.run.threadId, runtimeId: "test" };
    const coordinator = createRuntimeSessionCoordinator(prisma, target);
    const lease = await coordinator.acquire("definition");
    await lease.finish("interrupted");
    await expect(coordinator.acquire("definition")).rejects.toThrow("cannot be replayed");
    const nextRun = await prisma.run.create({
      data: {
        spaceId: f.id,
        userId: f.id,
        botId: f.run.botId,
        threadId: f.run.threadId,
        taskId: f.run.taskId,
        status: "running",
        trigger: "user",
        leaseOwner: "worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const fresh = await createRuntimeSessionCoordinator(prisma, {
      ...target,
      runId: nextRun.id,
    }).acquire("definition");
    expect(fresh.storageKey).not.toBe(lease.storageKey);
    expect(fresh.checkpoint).toBeNull();
    await fresh.finish("completed", "checkpoint");
  });

  it("isolates routine context from a prior conversation checkpoint", async () => {
    const f = await setup();
    const target = { ...f.target, threadId: f.run.threadId, runtimeId: "test" };
    const coordinator = createRuntimeSessionCoordinator(prisma, target);
    const first = await coordinator.acquire("definition");
    await first.finish("completed", "conversation-checkpoint");
    await prisma.run.update({
      where: { id: f.run.id },
      data: { trigger: "routine", runtimeInputGeneration: { increment: 1 } },
    });
    const routine = await coordinator.acquire("definition");
    expect(routine.checkpoint).toBeNull();
    expect(routine.storageKey).not.toBe(first.storageKey);
    await routine.finish("completed", "routine-checkpoint");
  });

  it("blocks session acquisition while an earlier conversation action is uncertain", async () => {
    const f = await setup();
    await prisma.externalEffect.create({
      data: {
        runId: f.run.id,
        spaceId: f.id,
        kind: "runtime_host_tool",
        status: "uncertain",
        idempotencyKey: randomUUID(),
        request: { name: "write", fence: 1 },
      },
    });
    const coordinator = createRuntimeSessionCoordinator(prisma, {
      ...f.target,
      threadId: f.run.threadId,
      runtimeId: "test",
    });
    await expect(coordinator.acquire("definition")).rejects.toThrow("requires reconciliation");
    expect(
      await prisma.externalEffect.count({ where: { runId: f.run.id, kind: "runtime_invocation" } }),
    ).toBe(0);
  });

  it("does not dispatch after lease loss or in a foreign space", async () => {
    const f = await setup();
    const execute = vi.fn(async () => null);
    const signal = new AbortController().signal;
    const foreign = createRuntimeToolLedger(
      prisma,
      { ...f.target, spaceId: "foreign" },
      execute,
      signal,
    );
    await expect(foreign.executeTool("write", {}, "call")).rejects.toThrow("lease lost");
    await prisma.run.update({ where: { id: f.run.id }, data: { leaseFence: 2 } });
    const stale = createRuntimeToolLedger(prisma, f.target, execute, signal);
    await expect(stale.executeTool("write", {}, "call")).rejects.toThrow("lease lost");
    expect(execute).not.toHaveBeenCalled();
  });
});
