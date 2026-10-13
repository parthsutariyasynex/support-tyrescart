// One-off data migration: chat assignments move from the Assignee table to Member ids.
//   npx tsx scripts/migrateAssigneesToMembers.ts            dry run: reports what would change
//   npx tsx scripts/migrateAssigneesToMembers.ts --apply    rewrites Conversation.assignedToId, then run
//                                                           `prisma db push --accept-data-loss` to drop Assignee
// For every assigned conversation: assignee linked to a user -> that user's membership in the same workspace;
// name-only assignee (no user) or a user no longer in the workspace -> unassigned, with a history entry.
// Nothing else is touched. Safe to re-run; does nothing once the Assignee table is gone.
import '../src/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/prisma.js';

const apply = process.argv.includes('--apply');
const tables: any[] = await prisma.$queryRawUnsafe('SHOW TABLES');
if (!tables.some((t) => Object.values(t)[0] === 'Assignee')) {
  console.log('Assignee table not present: nothing to migrate');
  await prisma.$disconnect();
  process.exit(0);
}
const rows: { conversationId: string; workspaceId: string; assigneeId: string; assigneeName: string; userId: string | null; memberId: string | null }[] =
  await prisma.$queryRawUnsafe(`
    SELECT c.id AS conversationId, c.workspaceId, a.id AS assigneeId, a.name AS assigneeName, a.userId,
           (SELECT m.id FROM Role m WHERE m.userId = a.userId AND m.workspaceId = c.workspaceId) AS memberId
    FROM Conversation c JOIN Assignee a ON a.id = c.assignedToId`);
const moved = rows.filter((r) => r.memberId);
const unassigned = rows.filter((r) => !r.memberId);
console.log(JSON.stringify({ apply, assignedConversations: rows.length, toMember: moved.length, toUnassigned: unassigned.map((r) => ({ conversation: r.conversationId, assignee: r.assigneeName })) }, null, 2));
if (!apply) {
  await prisma.$disconnect();
  process.exit(0);
}
mkdirSync('backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`backups/assignments-migrated-to-members-${stamp}.json`, JSON.stringify(rows, null, 2));
await prisma.$transaction(async (tx) => {
  // The column still references Assignee; the key is dropped so it can hold member ids (db push adds the new one)
  const fks: any[] = await tx.$queryRawUnsafe(`SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Conversation' AND COLUMN_NAME = 'assignedToId' AND REFERENCED_TABLE_NAME = 'Assignee'`);
  for (const fk of fks) await tx.$executeRawUnsafe(`ALTER TABLE Conversation DROP FOREIGN KEY ${fk.CONSTRAINT_NAME}`);
  for (const r of moved) await tx.$executeRawUnsafe(`UPDATE Conversation SET assignedToId = ? WHERE id = ? AND assignedToId = ?`, r.memberId, r.conversationId, r.assigneeId);
  for (const r of unassigned) {
    await tx.$executeRawUnsafe(`UPDATE Conversation SET assignedToId = NULL WHERE id = ? AND assignedToId = ?`, r.conversationId, r.assigneeId);
    await tx.activityEvent.create({ data: { workspaceId: r.workspaceId, conversationId: r.conversationId, actorId: null, type: 'unassigned', data: { assignee: r.assigneeName, reason: 'assignee_removed' } } });
  }
});
console.log(`done: ${moved.length} moved to members, ${unassigned.length} unassigned. Now run: npx prisma db push --accept-data-loss`);
await prisma.$disconnect();
