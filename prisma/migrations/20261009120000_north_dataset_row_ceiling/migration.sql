-- Streaming dataset ingestion lifts the provisional 50,000-row batch ceiling to the worksheet maximum (1,048,576 rows).
-- The effective, configurable limit is enforced by the parser (NORTH_DATA_IMPORT_MAX_ROWS, hard ceiling 1,048,576).
-- Relaxing only: existing batches stay valid.
-- Rollback (only while no batch exceeds 50,000 rows):
--   ALTER TABLE "NorthDatasetImportBatch" DROP CONSTRAINT "NorthDatasetImportBatch_rowCount_check";
--   ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_rowCount_check" CHECK ("rowCount" >= 0 AND "rowCount" <= 50000);
ALTER TABLE "NorthDatasetImportBatch" DROP CONSTRAINT "NorthDatasetImportBatch_rowCount_check";
ALTER TABLE "NorthDatasetImportBatch" ADD CONSTRAINT "NorthDatasetImportBatch_rowCount_check" CHECK ("rowCount" >= 0 AND "rowCount" <= 1048576);
