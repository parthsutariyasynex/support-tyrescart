// One-off data migration: chat assignments move from the Assignee table to Member ids.
//   npx tsx scripts/migrateAssigneesToMembers.ts            dry run: reports what would change
//   npx tsx scripts/migrateAssigneesToMembers.ts --apply    rewrites Conversation.assignedToId, then run
//                                                           `prisma db push --accept-data-loss` to drop Assignee
// For every assigned conversation: assignee linked to a user -> that user's membership in the same workspace;
// name-only assignee (no user) or a user no longer in the workspace -> unassigned, with a history entry.
// Nothing else is touched. Safe to re-run; does nothing once the Assignee table is gone.
//
// Matching is by Assignee.userId only (never by name): an assignee named "Alice" with no linked userId is
// NOT assumed to be the member named Alice, because name collisions can't be told apart from coincidence.
// If a name-only assignee happens to match a real member's name, --apply refuses to run (see below) until
// someone confirms it by hand: `UPDATE Assignee SET userId = '<the member's User.id>' WHERE id = '<assignee id>'`
// before re-running, or passes --allow-unlinked-name-matches to accept the conversation going Unassigned instead.
import '../src/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/prisma.js';

const apply = process.argv.includes('--apply');
const allowUnlinkedNameMatches = process.argv.includes('--allow-unlinked-name-matches');
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

// Flag (never auto-apply) cases where an unlinked assignee's name matches a real member in the same
// workspace: that conversation would silently go Unassigned even though the intended person is identifiable.
const nameMatchCandidates: { conversationId: string; assigneeId: string; assigneeName: string; candidateUserId: string; candidateUserName: string }[] = [];
for (const r of unassigned) {
  const candidates: { candidateUserId: string; candidateUserName: string }[] = await prisma.$queryRawUnsafe(
    `SELECT u.id AS candidateUserId, u.name AS candidateUserName
     FROM Role m JOIN User u ON u.id = m.userId
     WHERE m.workspaceId = ? AND LOWER(u.name) = LOWER(?)`,
    r.workspaceId,
    r.assigneeName,
  );
  for (const c of candidates) nameMatchCandidates.push({ conversationId: r.conversationId, assigneeId: r.assigneeId, assigneeName: r.assigneeName, ...c });
}

console.log(JSON.stringify({ apply, assignedConversations: rows.length, toMember: moved.length, toUnassigned: unassigned.map((r) => ({ conversation: r.conversationId, assignee: r.assigneeName })), nameMatchCandidates }, null, 2));

if (nameMatchCandidates.length && !allowUnlinkedNameMatches) {
  console.error(
    `Refusing to proceed: ${nameMatchCandidates.length} unlinked assignee(s) share a name with a real member but are not linked via userId (see nameMatchCandidates above).\n` +
    `Fix each one with: UPDATE Assignee SET userId = '<candidateUserId>' WHERE id = '<assigneeId>';  then re-run.\n` +
    `Or re-run with --allow-unlinked-name-matches to accept those conversations going Unassigned instead.`,
  );
  await prisma.$disconnect();
  process.exit(1);
}
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
