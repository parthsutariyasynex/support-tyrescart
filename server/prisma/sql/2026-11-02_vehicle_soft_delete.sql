-- Vehicle soft delete (Delete on a saved vehicle sets deletedAt/deletedBy; the vehicle is hidden, nothing is lost).
-- Run once on each database BEFORE starting the new server code: every vehicle query filters on deletedAt, so vehicle
-- screens fail with "column deletedAt does not exist" until both columns are there.
--
-- Safe: adds two nullable columns; existing vehicles keep all their data (deletedAt = NULL = not deleted).
-- Run with:  npx prisma db execute --file prisma/sql/2026-11-02_vehicle_soft_delete.sql --schema prisma/schema.prisma
-- (do NOT use `prisma db push` here: on this database it would also drop Workspace.companyId)

ALTER TABLE `Vehicle` ADD COLUMN `deletedAt` DATETIME(3) NULL AFTER `updatedBy`, ADD COLUMN `deletedBy` VARCHAR(191) NULL AFTER `deletedAt`;

-- Undo (drops the record of which vehicles were deleted; they would show again):
-- ALTER TABLE `Vehicle` DROP COLUMN `deletedBy`, DROP COLUMN `deletedAt`;
