-- Vehicle id as a number: BIGINT UNSIGNED AUTO_INCREMENT instead of the text (cuid) id. Run once on each database
-- BEFORE starting the new server code: the regenerated Prisma client expects a number, so vehicle screens fail until
-- this is done.
--
-- Safe: nothing refers to Vehicle.id (no foreign keys, the app never stores it), so the old text ids are simply
-- replaced. Every existing vehicle keeps all its other data and gets a new number (1, 2, 3, … in table order).
-- Run with:  npx prisma db execute --file prisma/sql/2026-11-02_vehicle_id_bigint.sql --schema prisma/schema.prisma
-- (do NOT use `prisma db push` here: on this database it would also drop Workspace.companyId)

ALTER TABLE `Vehicle`
  DROP PRIMARY KEY,
  DROP COLUMN `id`,
  ADD COLUMN `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;

-- Check: id is bigint unsigned, auto_increment, first column
-- SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Vehicle' ORDER BY ORDINAL_POSITION;

-- Undo (vehicles get new text ids; the old cuids are gone either way):
-- ALTER TABLE `Vehicle` MODIFY `id` BIGINT UNSIGNED NOT NULL, DROP PRIMARY KEY, DROP COLUMN `id`,
--   ADD COLUMN `id` VARCHAR(191) NOT NULL FIRST;
-- UPDATE `Vehicle` SET `id` = UUID();
-- ALTER TABLE `Vehicle` ADD PRIMARY KEY (`id`);
