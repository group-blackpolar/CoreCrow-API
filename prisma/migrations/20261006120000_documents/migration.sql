-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('DRAFT', 'READY', 'SENT', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentTypeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DocumentAttachmentStorage" AS ENUM ('DATABASE');

-- CreateTable
CREATE TABLE "DocumentType" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "referencePrefix" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" "DocumentTypeStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSequence" (
    "typeId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DocumentSequence_pkey" PRIMARY KEY ("typeId")
);

-- CreateTable
CREATE TABLE "DocumentClient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "emailKey" TEXT,
    "phone" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "typeId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "documentDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientId" TEXT,
    "clientName" TEXT NOT NULL,
    "clientEmail" TEXT,
    "clientPhone" TEXT,
    "comments" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sku" TEXT,
    "unit" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "DocumentItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage" "DocumentAttachmentStorage" NOT NULL DEFAULT 'DATABASE',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAttachmentBlob" (
    "attachmentId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "DocumentAttachmentBlob_pkey" PRIMARY KEY ("attachmentId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_id_organizationId_key" ON "DocumentType"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_organizationId_key_key" ON "DocumentType"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_organizationId_referencePrefix_key" ON "DocumentType"("organizationId", "referencePrefix");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSequence_typeId_organizationId_key" ON "DocumentSequence"("typeId", "organizationId");

-- CreateIndex
CREATE INDEX "DocumentClient_organizationId_name_idx" ON "DocumentClient"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentClient_id_organizationId_key" ON "DocumentClient"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentClient_organizationId_emailKey_key" ON "DocumentClient"("organizationId", "emailKey");

-- CreateIndex
CREATE INDEX "Document_organizationId_status_createdAt_idx" ON "Document"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Document_organizationId_clientId_idx" ON "Document"("organizationId", "clientId");

-- CreateIndex
CREATE INDEX "Document_organizationId_documentDate_idx" ON "Document"("organizationId", "documentDate");

-- CreateIndex
CREATE UNIQUE INDEX "Document_id_organizationId_key" ON "Document"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_reference_key" ON "Document"("organizationId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "Document_typeId_sequence_key" ON "Document"("typeId", "sequence");

-- CreateIndex
CREATE INDEX "DocumentItem_organizationId_documentId_idx" ON "DocumentItem"("organizationId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentItem_documentId_position_key" ON "DocumentItem"("documentId", "position");

-- CreateIndex
CREATE INDEX "DocumentAttachment_organizationId_documentId_idx" ON "DocumentAttachment"("organizationId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAttachment_id_organizationId_key" ON "DocumentAttachment"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "DocumentType" ADD CONSTRAINT "DocumentType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSequence" ADD CONSTRAINT "DocumentSequence_typeId_organizationId_fkey" FOREIGN KEY ("typeId", "organizationId") REFERENCES "DocumentType"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentClient" ADD CONSTRAINT "DocumentClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_typeId_organizationId_fkey" FOREIGN KEY ("typeId", "organizationId") REFERENCES "DocumentType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_clientId_organizationId_fkey" FOREIGN KEY ("clientId", "organizationId") REFERENCES "DocumentClient"("id", "organizationId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentItem" ADD CONSTRAINT "DocumentItem_documentId_organizationId_fkey" FOREIGN KEY ("documentId", "organizationId") REFERENCES "Document"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAttachment" ADD CONSTRAINT "DocumentAttachment_documentId_organizationId_fkey" FOREIGN KEY ("documentId", "organizationId") REFERENCES "Document"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAttachmentBlob" ADD CONSTRAINT "DocumentAttachmentBlob_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "DocumentAttachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Database-level invariants (defense in depth; the service validates the same rules).
ALTER TABLE "DocumentType" ADD CONSTRAINT "DocumentType_prefix_check" CHECK ("referencePrefix" ~ '^[A-Z]{2,6}$');
ALTER TABLE "DocumentType" ADD CONSTRAINT "DocumentType_key_check" CHECK ("key" ~ '^[a-z][a-z0-9-]{1,40}$');
ALTER TABLE "Document" ADD CONSTRAINT "Document_amounts_check" CHECK ("subtotal" >= 0 AND "discountTotal" >= 0 AND "taxTotal" >= 0 AND "total" >= 0);
ALTER TABLE "Document" ADD CONSTRAINT "Document_version_check" CHECK ("version" >= 1 AND "sequence" >= 1);
ALTER TABLE "DocumentItem" ADD CONSTRAINT "DocumentItem_amounts_check" CHECK ("quantity" > 0 AND "unitPrice" >= 0 AND "total" >= 0 AND "position" >= 0);
ALTER TABLE "DocumentAttachment" ADD CONSTRAINT "DocumentAttachment_size_check" CHECK ("size" > 0 AND "size" <= 10485760);
