ALTER TABLE "ContactRequest"
ADD COLUMN "notificationStatus" TEXT NOT NULL DEFAULT 'not_requested',
ADD COLUMN "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "notificationNextAttemptAt" TIMESTAMP(3),
ADD COLUMN "notificationClaimedAt" TIMESTAMP(3),
ADD COLUMN "notificationSentAt" TIMESTAMP(3),
ADD COLUMN "notificationLastErrorCode" TEXT;

CREATE INDEX "ContactRequest_notificationStatus_notificationNextAttemptAt_idx"
ON "ContactRequest"("notificationStatus", "notificationNextAttemptAt");
