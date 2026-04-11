-- CreateTable
CREATE TABLE "ScheduledTask" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cronExpression" TEXT,
    "fireAt" TIMESTAMP(3),
    "actionType" TEXT NOT NULL,
    "actionPayload" JSONB NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "nextFireAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastResult" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledTask_enabled_nextFireAt_idx" ON "ScheduledTask"("enabled", "nextFireAt");

-- CreateIndex
CREATE INDEX "ScheduledTask_enabled_fireAt_idx" ON "ScheduledTask"("enabled", "fireAt");
