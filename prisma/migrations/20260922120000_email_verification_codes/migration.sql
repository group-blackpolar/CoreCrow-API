CREATE TABLE "email_verification_challenges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_verification_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_verification_challenges_userId_key"
    ON "email_verification_challenges"("userId");
CREATE INDEX "email_verification_challenges_expiresAt_idx"
    ON "email_verification_challenges"("expiresAt");

ALTER TABLE "email_verification_challenges"
    ADD CONSTRAINT "email_verification_challenges_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
