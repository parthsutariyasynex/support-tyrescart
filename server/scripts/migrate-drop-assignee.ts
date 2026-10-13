import '../src/env.js';
import { prisma } from '../src/prisma.js';

async function migrate() {
  console.log('Starting migration to safely drop Assignee table...');

  // Disable FK checks temporarily for the transition
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0');

  try {
    // Step 1: Migrate Conversation.assignedToId to point to Assignee.userId
    const updatedConvs = await prisma.$executeRawUnsafe(`
      UPDATE Conversation c
      JOIN Assignee a ON c.assignedToId = a.id
      SET c.assignedToId = a.userId
      WHERE a.userId IS NOT NULL
    `);
    console.log(`Migrated ${updatedConvs} conversation(s) assignedToId to User ID.`);

    // Step 2: Clear any invalid/dangling assignedToId that do not exist in User
    const clearedConvs = await prisma.$executeRawUnsafe(`
      UPDATE Conversation
      SET assignedToId = NULL
      WHERE assignedToId IS NOT NULL
        AND assignedToId NOT IN (SELECT id FROM User)
    `);
    console.log(`Cleared ${clearedConvs} conversation(s) with invalid assignedToId.`);

    // Step 3: Check and drop foreign key Conversation_assignedToId_fkey
    const fkeys: any = await prisma.$queryRawUnsafe(`
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'Conversation'
        AND COLUMN_NAME = 'assignedToId'
        AND REFERENCED_TABLE_NAME = 'Assignee'
    `);
    console.log('Found foreign key constraints pointing to Assignee:', fkeys);

    for (const fk of fkeys) {
      console.log(`Dropping foreign key constraint: ${fk.CONSTRAINT_NAME}`);
      await prisma.$executeRawUnsafe(`ALTER TABLE Conversation DROP FOREIGN KEY ${fk.CONSTRAINT_NAME}`);
    }

    // Step 4: Add updated foreign key constraint pointing to User
    console.log('Adding updated foreign key constraint Conversation_assignedToId_fkey referencing User(id)...');
    await prisma.$executeRawUnsafe(`
      ALTER TABLE Conversation
      ADD CONSTRAINT Conversation_assignedToId_fkey
      FOREIGN KEY (assignedToId) REFERENCES User(id)
      ON DELETE SET NULL ON UPDATE CASCADE
    `);

    // Step 5: Drop Assignee table
    console.log('Dropping Assignee table...');
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS Assignee`);
    console.log('Assignee table dropped successfully.');

    // Step 6: Verify final database state
    const tables: any = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log('Remaining tables:', tables.map((t: any) => Object.values(t)[0]));

    const newFkeys: any = await prisma.$queryRawUnsafe(`
      SELECT 
        TABLE_NAME, 
        COLUMN_NAME, 
        CONSTRAINT_NAME, 
        REFERENCED_TABLE_NAME, 
        REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'Conversation'
        AND COLUMN_NAME = 'assignedToId'
    `);
    console.log('Updated Conversation foreign key:', newFkeys);

    const sampleConv: any = await prisma.$queryRawUnsafe(`
      SELECT c.id, c.workspaceId, c.assignedToId, u.name as assignedUserName, u.email as assignedUserEmail
      FROM Conversation c
      LEFT JOIN User u ON c.assignedToId = u.id
      WHERE c.assignedToId IS NOT NULL
    `);
    console.log('Conversations with their new User assignments:', sampleConv);

    console.log('Database migration completed successfully!');
  } finally {
    // Re-enable FK checks
    await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1');
  }
}

migrate()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
