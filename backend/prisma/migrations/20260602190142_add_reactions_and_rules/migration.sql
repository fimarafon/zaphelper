-- CreateTable
CREATE TABLE "Reaction" (
    "id" TEXT NOT NULL,
    "targetWaMessageId" TEXT NOT NULL,
    "reactionEventId" TEXT,
    "chatId" TEXT NOT NULL,
    "chatName" TEXT,
    "reactorPhone" TEXT,
    "reactorName" TEXT,
    "emoji" TEXT NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "rawEvent" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReactionRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "matchChatId" TEXT,
    "matchEmoji" TEXT,
    "matchReactorPhone" TEXT,
    "fireOnRemove" BOOLEAN NOT NULL DEFAULT false,
    "actionType" TEXT NOT NULL,
    "actionPayload" JSONB NOT NULL,
    "lastFiredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastResult" TEXT,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReactionRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reaction_targetWaMessageId_idx" ON "Reaction"("targetWaMessageId");

-- CreateIndex
CREATE INDEX "Reaction_chatId_timestamp_idx" ON "Reaction"("chatId", "timestamp");

-- CreateIndex
CREATE INDEX "Reaction_emoji_idx" ON "Reaction"("emoji");

-- CreateIndex
CREATE UNIQUE INDEX "Reaction_targetWaMessageId_reactorPhone_key" ON "Reaction"("targetWaMessageId", "reactorPhone");

-- CreateIndex
CREATE INDEX "ReactionRule_enabled_idx" ON "ReactionRule"("enabled");
