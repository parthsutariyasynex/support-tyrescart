-- Vehicle remarks (Add Vehicle form → Remarks). Run once on each database BEFORE starting the new server code:
-- the regenerated Prisma client reads this column, so vehicle screens fail with "column remarks does not exist" until it's there.
--
-- Safe: adds one nullable column; existing vehicles keep all their data (remarks = NULL).
-- Run with:  npx prisma db execute --file prisma/sql/2026-11-02_vehicle_remarks.sql --schema prisma/schema.prisma
-- (do NOT use `prisma db push` here: on this database it would also drop Workspace.companyId)

ALTER TABLE `Vehicle` ADD COLUMN `remarks` TEXT NULL AFTER `tireSize2`;

-- Check: 18 columns, remarks after tireSize2
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Vehicle' ORDER BY ORDINAL_POSITION;

-- Undo (drops any remarks typed in since):
-- ALTER TABLE `Vehicle` DROP COLUMN `remarks`;
