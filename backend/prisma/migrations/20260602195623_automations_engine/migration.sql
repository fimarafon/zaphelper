/*
  Warnings:

  - You are about to drop the `ReactionRule` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "ReactionRule";

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "chatId" TEXT,
    "triggerType" TEXT NOT NULL,
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "delaySeconds" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "actionType" TEXT NOT NULL,
    "actionPayload" JSONB NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastResult" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingAutomation" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "targetWaMessageId" TEXT,
    "chatId" TEXT,
    "triggerContext" JSONB NOT NULL DEFAULT '{}',
    "fireAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_enabled_triggerType_idx" ON "Automation"("enabled", "triggerType");

-- CreateIndex
CREATE INDEX "Automation_enabled_chatId_idx" ON "Automation"("enabled", "chatId");

-- CreateIndex
CREATE INDEX "PendingAutomation_status_fireAt_idx" ON "PendingAutomation"("status", "fireAt");

-- CreateIndex
CREATE INDEX "PendingAutomation_automationId_idx" ON "PendingAutomation"("automationId");
