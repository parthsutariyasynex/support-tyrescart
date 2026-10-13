import '../src/env.js';
import { prisma } from '../src/prisma.js';

async function main() {
  try {
    const tables: any = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log('--- ALL TABLES ---');
    console.log(tables);

    const fkeys: any = await prisma.$queryRawUnsafe(`
      SELECT 
        TABLE_NAME, 
        COLUMN_NAME, 
        CONSTRAINT_NAME, 
        REFERENCED_TABLE_NAME, 
        REFERENCED_COLUMN_NAME
      FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE()
        AND (TABLE_NAME = 'Conversation' OR REFERENCED_TABLE_NAME LIKE '%ssignee%' OR TABLE_NAME LIKE '%ssignee%')
    `);
    console.log('--- FOREIGN KEYS ---');
    console.log(fkeys);

    const assigneeColumns: any = await prisma.$queryRawUnsafe(`
      DESCRIBE Assignee
    `).catch(e => e.message);
    console.log('--- ASSIGNEE COLUMNS ---');
    console.log(assigneeColumns);

    const convColumns: any = await prisma.$queryRawUnsafe(`
      DESCRIBE Conversation
    `).catch(e => e.message);
    console.log('--- CONVERSATION COLUMNS ---');
    console.log(convColumns);

    const assigneeCount: any = await prisma.$queryRawUnsafe('SELECT COUNT(*) as count FROM Assignee').catch(e => e.message);
    console.log('--- ASSIGNEE COUNT ---', assigneeCount);

    const convAssignedCount: any = await prisma.$queryRawUnsafe('SELECT COUNT(*) as count FROM Conversation WHERE assignedToId IS NOT NULL').catch(e => e.message);
    console.log('--- CONVERSATIONS WITH ASSIGNED_TO_ID ---', convAssignedCount);

    const sampleAssignees: any = await prisma.$queryRawUnsafe('SELECT * FROM Assignee').catch(e => e.message);
    console.log('--- ALL ASSIGNEES ---', sampleAssignees);

    const sampleAssignedConv: any = await prisma.$queryRawUnsafe('SELECT id, workspaceId, assignedToId FROM Conversation WHERE assignedToId IS NOT NULL').catch(e => e.message);
    console.log('--- ALL ASSIGNED CONVERSATIONS ---', sampleAssignedConv);
  } catch (err) {
    console.error('Error during inspection:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
