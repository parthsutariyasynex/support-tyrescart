-- AI Robot (Settings → AI Robot, automatic replies in unassigned chats; services/aiRobot.ts). Run once on each database
-- BEFORE starting the new server code: the regenerated Prisma client reads these columns and tables, so the inbox fails
-- with "column aiRobotState does not exist" until they're there.
--
-- Safe: adds nullable columns to Conversation (existing chats keep all their data; the robot treats NULL as "not started")
-- and two new tables. Nothing is changed or removed. The robot stays off until an admin turns it on (enabled = false).
-- Run with:  npx prisma db execute --file prisma/sql/2026-11-04_ai_robot.sql --schema prisma/schema.prisma
-- (do NOT use `prisma db push` here: on this database it would also drop Workspace.companyId)

ALTER TABLE `Conversation`
    ADD COLUMN `aiRobotState` VARCHAR(12) NULL,
    ADD COLUMN `aiRobotReason` VARCHAR(30) NULL,
    ADD COLUMN `aiRobotStateAt` DATETIME(3) NULL,
    ADD COLUMN `aiRobotSessionAt` DATETIME(3) NULL,
    ADD COLUMN `aiRobotLastInId` VARCHAR(191) NULL;

CREATE TABLE `AiRobotSettings` (
    `workspaceId` VARCHAR(191) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `mode` VARCHAR(10) NOT NULL DEFAULT 'draft',
    `firstReplyMins` INTEGER NOT NULL DEFAULT 5,
    `groupSeconds` INTEGER NOT NULL DEFAULT 8,
    `hoursRule` VARCHAR(10) NOT NULL DEFAULT 'any',
    `maxRepliesPerDay` INTEGER NOT NULL DEFAULT 20,
    `minConfidence` DOUBLE NOT NULL DEFAULT 0.7,
    `webSearch` BOOLEAN NOT NULL DEFAULT true,
    `handoverMessage` TEXT NULL,
    `companyInfo` TEXT NULL,
    `bannedPhrases` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdBy` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedBy` VARCHAR(191) NULL,
    PRIMARY KEY (`workspaceId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `AiRobotRun` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `workspaceId` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(10) NOT NULL,
    `reason` TEXT NULL,
    `confidence` DOUBLE NULL,
    `draft` TEXT NULL,
    `tools` TEXT NULL,
    `inMessageId` VARCHAR(191) NULL,
    `messageId` VARCHAR(191) NULL,
    `model` VARCHAR(100) NOT NULL,
    `durationMs` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `AiRobotRun_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    INDEX `AiRobotRun_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AiRobotSettings` ADD CONSTRAINT `AiRobotSettings_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `AiRobotRun` ADD CONSTRAINT `AiRobotRun_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Check: SHOW COLUMNS FROM `Conversation` LIKE 'aiRobot%';   (5 rows)

-- Undo (removes every robot setting and history):
-- DROP TABLE `AiRobotRun`;
-- DROP TABLE `AiRobotSettings`;
-- ALTER TABLE `Conversation` DROP COLUMN `aiRobotState`, DROP COLUMN `aiRobotReason`, DROP COLUMN `aiRobotStateAt`,
--   DROP COLUMN `aiRobotSessionAt`, DROP COLUMN `aiRobotLastInId`;
