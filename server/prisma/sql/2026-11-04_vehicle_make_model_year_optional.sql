-- Vehicle make, model and year optional (Add Vehicle form → only Tyre Size 1 is required). Run once on each database
-- BEFORE starting the new server code: until then, saving a vehicle without a make, model or year fails.
--
-- Safe: only allows NULL; existing values stay as they are.
-- Run with:  npx prisma db execute --file prisma/sql/2026-11-04_vehicle_make_model_year_optional.sql --schema prisma/schema.prisma
-- (do NOT use `prisma db push` here: on this database it would also drop Workspace.companyId)

ALTER TABLE `Vehicle` MODIFY `make` VARCHAR(60) NULL, MODIFY `model` VARCHAR(60) NULL, MODIFY `year` INT NULL;

-- Undo (only works while every vehicle has a make, model and year):
-- ALTER TABLE `Vehicle` MODIFY `make` VARCHAR(60) NOT NULL, MODIFY `model` VARCHAR(60) NOT NULL, MODIFY `year` INT NOT NULL;
