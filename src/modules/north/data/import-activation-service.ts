import { transaction } from "../../../shared/transaction.js";
import { fail } from "../../../shared/errors.js";
import { auditRepository } from "../../audit/repository.js";
import { authorizeDataset } from "./authorization.js";
import { importView } from "./import-service.js";
import { assertAppendAllowed } from "./import-append-policy.js";

export type ActivationInput = { mappingId: string; mode: "REPLACE_DATASET" | "APPEND"; periodStart?: string | null; periodEnd?: string | null };
const day = (value?: string | null) => (value ? new Date(`${value}T00:00:00.000Z`) : null);

export const northDatasetImportActivation = {
  activate(userId: string, organizationId: string, datasetId: string, importId: string, input: ActivationInput) {
    const { mappingId, mode } = input;
    return transaction(async (tx) => {
      await authorizeDataset(tx, userId, organizationId, datasetId, "north.data.manage");
      const job = await tx.northDatasetImportJob.findFirst({ where: { id: importId, organizationId, datasetId } });
      if (!job) fail(404, "NOT_FOUND", "Dataset import not found");
      if (job.status !== "AWAITING_MAPPING") fail(409, "IMPORT_ACTIVATION_NOT_AVAILABLE", "Import is not awaiting activation");
      const mapping = await tx.northDatasetImportMappingVersion.findFirst({ where: { id: mappingId, importId, organizationId, datasetId } });
      if (!mapping) fail(422, "IMPORT_MAPPING_INVALID", "Mapping does not belong to this import");
      const periodStart = day(input.periodStart);
      const periodEnd = day(input.periodEnd);
      if (mode === "APPEND") await assertAppendAllowed(tx, { organizationId, datasetId, importId, checksum: job.declaredChecksum, periodStart, periodEnd });
      const updated = await tx.northDatasetImportJob.updateMany({
        where: { id: importId, organizationId, datasetId, status: "AWAITING_MAPPING", activationMappingId: null },
        data: { status: "READY_TO_ACTIVATE", progress: 75, activationMappingId: mappingId, activationRequestedBy: userId, activationMode: mode, periodStart: mode === "APPEND" ? periodStart : null, periodEnd: mode === "APPEND" ? periodEnd : null, materializationAttempts: 0, availableAt: new Date(), lastErrorCode: null },
      });
      if (updated.count !== 1) fail(409, "IMPORT_ACTIVATION_CONFLICT", "Import activation state changed; retry");
      await auditRepository.append(tx, {
        actorId: userId, organizationId, action: "NORTH_DATASET_IMPORT_ACTIVATION_REQUESTED",
        targetType: "NorthDatasetImportJob", targetId: importId,
        metadata: { datasetId, mappingId, mode, ...(mode === "APPEND" ? { periodStart: input.periodStart ?? null, periodEnd: input.periodEnd ?? null, checksum: job.declaredChecksum } : {}) },
      });
      return importView(await tx.northDatasetImportJob.findUniqueOrThrow({ where: { id: importId } }));
    });
  },
};
