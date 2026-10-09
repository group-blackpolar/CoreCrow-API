CREATE TYPE "AIApplication" AS ENUM ('NORTH');
CREATE TYPE "AIRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "AIMessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL');
CREATE TYPE "AIToolCallStatus" AS ENUM ('PROPOSED', 'RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "AIActionStatus" AS ENUM ('PENDING_CONFIRMATION', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED');

CREATE TABLE "AIConversation" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "application" "AIApplication" NOT NULL, "title" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIConversation_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIRun" (
  "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL, "application" "AIApplication" NOT NULL,
  "status" "AIRunStatus" NOT NULL DEFAULT 'QUEUED', "provider" TEXT NOT NULL, "model" TEXT NOT NULL,
  "failureCode" TEXT, "failureMessage" TEXT, "cancellationRequestedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AIRun_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIMessage" (
  "id" TEXT NOT NULL, "conversationId" TEXT NOT NULL, "runId" TEXT,
  "role" "AIMessageRole" NOT NULL, "content" TEXT NOT NULL, "toolName" TEXT, "toolCallId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIMessage_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIEvent" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "sequence" INTEGER NOT NULL,
  "type" TEXT NOT NULL, "data" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIToolCall" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "providerId" TEXT, "name" TEXT NOT NULL,
  "risk" TEXT NOT NULL, "arguments" JSONB NOT NULL, "result" JSONB,
  "status" "AIToolCallStatus" NOT NULL DEFAULT 'PROPOSED', "errorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "AIToolCall_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIAction" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL, "arguments" JSONB NOT NULL,
  "status" "AIActionStatus" NOT NULL DEFAULT 'PENDING_CONFIRMATION', "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3), "cancelledAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIAction_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AIUsage" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL, "userId" TEXT NOT NULL, "application" "AIApplication" NOT NULL,
  "provider" TEXT NOT NULL, "model" TEXT NOT NULL, "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL, "totalTokens" INTEGER NOT NULL, "latencyMs" INTEGER NOT NULL,
  "estimatedCostMicrousd" BIGINT NOT NULL, "pricingVersion" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AIUsage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AIConversation_organizationId_userId_updatedAt_idx" ON "AIConversation"("organizationId", "userId", "updatedAt");
CREATE INDEX "AIRun_organizationId_userId_createdAt_idx" ON "AIRun"("organizationId", "userId", "createdAt");
CREATE INDEX "AIRun_status_createdAt_idx" ON "AIRun"("status", "createdAt");
CREATE INDEX "AIMessage_conversationId_createdAt_id_idx" ON "AIMessage"("conversationId", "createdAt", "id");
CREATE INDEX "AIMessage_runId_idx" ON "AIMessage"("runId");
CREATE UNIQUE INDEX "AIEvent_runId_sequence_key" ON "AIEvent"("runId", "sequence");
CREATE INDEX "AIEvent_runId_createdAt_idx" ON "AIEvent"("runId", "createdAt");
CREATE INDEX "AIToolCall_runId_createdAt_idx" ON "AIToolCall"("runId", "createdAt");
CREATE INDEX "AIAction_organizationId_userId_status_idx" ON "AIAction"("organizationId", "userId", "status");
CREATE INDEX "AIUsage_organizationId_createdAt_idx" ON "AIUsage"("organizationId", "createdAt");
CREATE INDEX "AIUsage_runId_idx" ON "AIUsage"("runId");

ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIConversation" ADD CONSTRAINT "AIConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIRun" ADD CONSTRAINT "AIRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIRun" ADD CONSTRAINT "AIRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIRun" ADD CONSTRAINT "AIRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIMessage" ADD CONSTRAINT "AIMessage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIEvent" ADD CONSTRAINT "AIEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIToolCall" ADD CONSTRAINT "AIToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIAction" ADD CONSTRAINT "AIAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIAction" ADD CONSTRAINT "AIAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIAction" ADD CONSTRAINT "AIAction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AIRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AIConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AIUsage" ADD CONSTRAINT "AIUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

