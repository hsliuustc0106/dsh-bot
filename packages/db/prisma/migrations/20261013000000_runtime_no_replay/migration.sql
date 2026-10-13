ALTER TABLE "runs" ADD COLUMN "executionRuntime" TEXT;
ALTER TABLE "runs" ADD COLUMN "runtimeNoReplay" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "external_effects_runtime_pending_idx" ON "external_effects" ("runId")
  WHERE "kind" = 'runtime_tool' AND "status" = 'executing';
