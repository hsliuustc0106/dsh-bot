CREATE TABLE "runtime_conversations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "runtimeId" TEXT NOT NULL,
  "definition" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "checkpoint" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ready',
  "activeToken" TEXT,
  "acquiredAt" TIMESTAMP(3),
  CONSTRAINT "runtime_conversations_threadId_botId_runtimeId_key" UNIQUE ("threadId", "botId", "runtimeId")
);
