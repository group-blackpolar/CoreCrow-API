-- TASK 11P-A2: the global platform audit listing is ordered by
-- (createdAt, id) without a tenant filter, so it needs indexes that do not
-- depend on organizationId. Purely additive: the existing tenant index
-- (organizationId, createdAt, id) is preserved unchanged.

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_id_idx" ON "AuditLog"("createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_id_idx" ON "AuditLog"("actorId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_id_idx" ON "AuditLog"("action", "createdAt", "id");
