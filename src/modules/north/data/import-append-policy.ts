import { DomainError } from "../../../shared/errors.js";
import type { Transaction } from "../../../shared/transaction.js";

const day = (value: Date) => value.toISOString().slice(0, 10);

/**
 * Preconditions of an APPEND activation, checked when it is requested and again inside the materialization transaction
 * (two concurrent requests could both pass the first check). Refuses, never silently skips:
 *  - the same file (SHA-256) already imported into this dataset or any dataset of its group;
 *  - a period that overlaps a period already appended to this dataset;
 *  - a dataset period (union with the new one) that would overlap another active dataset of the group.
 * Returns the dataset period after the append.
 */
export async function assertAppendAllowed(
  tx: Transaction,
  input: { organizationId: string; datasetId: string; importId: string; checksum: string; periodStart: Date | null; periodEnd: Date | null },
) {
  const { organizationId, datasetId, importId } = input;
  if (!input.periodStart || !input.periodEnd)
    throw new DomainError(422, "IMPORT_PERIOD_REQUIRED", "APPEND needs the period covered by the file");
  if (input.periodEnd < input.periodStart) throw new DomainError(422, "PERIOD_INVALID", "Period end is before its start");
  const dataset = await tx.northDataset.findFirstOrThrow({ where: { id: datasetId, organizationId } });

  const duplicate = await tx.northDatasetImportJob.findFirst({
    where: {
      organizationId, status: "SUCCEEDED", declaredChecksum: input.checksum, id: { not: importId },
      OR: [{ datasetId }, ...(dataset.groupId ? [{ dataset: { groupId: dataset.groupId } }] : [])],
    },
    select: { datasetId: true, filename: true, completedAt: true },
  });
  if (duplicate)
    throw new DomainError(409, "IMPORT_DUPLICATE_FILE", "This exact file was already imported", { sameDataset: duplicate.datasetId === datasetId, filename: duplicate.filename });

  const overlapping = await tx.northDatasetImportJob.findFirst({
    where: { organizationId, datasetId, id: { not: importId }, status: "SUCCEEDED", periodStart: { lte: input.periodEnd }, periodEnd: { gte: input.periodStart } },
    select: { periodStart: true, periodEnd: true },
  });
  if (overlapping)
    throw new DomainError(409, "IMPORT_PERIOD_OVERLAP", "The period overlaps data already appended to this dataset", { periodStart: day(overlapping.periodStart!), periodEnd: day(overlapping.periodEnd!) });

  const start = dataset.periodStart && dataset.periodStart < input.periodStart ? dataset.periodStart : input.periodStart;
  const end = dataset.periodEnd && dataset.periodEnd > input.periodEnd ? dataset.periodEnd : input.periodEnd;
  if (dataset.groupId) {
    const sibling = await tx.northDataset.findFirst({
      where: { organizationId, groupId: dataset.groupId, id: { not: datasetId }, status: "ACTIVE", periodStart: { lte: end }, periodEnd: { gte: start } },
      select: { slug: true },
    });
    if (sibling) throw new DomainError(409, "IMPORT_PERIOD_OVERLAP", "The resulting period overlaps another dataset of the group", { dataset: sibling.slug });
  }
  return { periodStart: start, periodEnd: end };
}
