-- Vehicle plate number optional (Add Vehicle form → Plate Number is no longer required). Run once on each database
-- BEFORE starting the new server code: until then, saving a vehicle without a plate fails.
--
-- Safe: only allows NULL; existing plate numbers stay as they are.
-- Run with:  npx prisma db execute --file prisma/sql/2026-11-02_vehicle_plate_optional.sql --schema prisma/schema.prisma
-- (do NOT use `prisma db push` here: on this database it would also drop Workspace.companyId)

ALTER TABLE `Vehicle` MODIFY `plateNumber` VARCHAR(20) NULL;

-- Undo (only works while no vehicle has an empty plate):
-- ALTER TABLE `Vehicle` MODIFY `plateNumber` VARCHAR(20) NOT NULL;
