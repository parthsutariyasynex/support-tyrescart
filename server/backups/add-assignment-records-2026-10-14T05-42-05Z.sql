-- CreateTable
CREATE TABLE `AssignmentRecord` (
    `id` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `conversationId` VARCHAR(191) NOT NULL,
    `previousMemberId` VARCHAR(191) NULL,
    `previousUserId` VARCHAR(191) NULL,
    `previousName` VARCHAR(191) NULL,
    `newMemberId` VARCHAR(191) NULL,
    `newUserId` VARCHAR(191) NULL,
    `newName` VARCHAR(191) NULL,
    `assignedById` VARCHAR(191) NULL,
    `assignedByName` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AssignmentRecord_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    INDEX `AssignmentRecord_conversationId_createdAt_idx`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AssignmentRecord` ADD CONSTRAINT `AssignmentRecord_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `Workspace`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AssignmentRecord` ADD CONSTRAINT `AssignmentRecord_conversationId_fkey` FOREIGN KEY (`conversationId`) REFERENCES `Conversation`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

