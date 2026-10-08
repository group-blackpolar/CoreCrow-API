-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "iconAssetId" TEXT;

-- CreateTable
CREATE TABLE "UserAvatar" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "NorthAssetStatus" NOT NULL DEFAULT 'UPLOADING',
    "confirmedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAvatar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAvatar_storageKey_key" ON "UserAvatar"("storageKey");

-- CreateIndex
CREATE INDEX "UserAvatar_userId_status_idx" ON "UserAvatar"("userId", "status");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_iconAssetId_id_fkey" FOREIGN KEY ("iconAssetId", "id") REFERENCES "NorthAsset"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAvatar" ADD CONSTRAINT "UserAvatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one live (READY, not deleted) avatar per user; concurrent confirmations cannot both win.
CREATE UNIQUE INDEX "UserAvatar_one_ready_per_user" ON "UserAvatar"("userId") WHERE "status" = 'READY' AND "deletedAt" IS NULL;

-- Additive and reversible: no existing row is rewritten. `Organization.iconData` is intentionally kept as the
-- fallback and as the source for the progressive conversion; drop it only in a later migration after verification.
