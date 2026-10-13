// Remove stale Assign-dropdown names: assignees no longer linked to any member and holding no chats.
//   npx tsx scripts/cleanupOrphanAssignees.ts <workspaceId>          lists what would be deleted (nothing changes)
//   npx tsx scripts/cleanupOrphanAssignees.ts <workspaceId> --apply  backs the rows up to backups/ and deletes them
// Orphans that still hold chats are never deleted (that would unassign the chats); they are listed as "kept".
import '../src/env.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { prisma } from '../src/prisma.js';
import { removeOrphanAssignees } from '../src/services/assign.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const workspaceId = args.find((a) => !a.startsWith('--'));
if (!workspaceId) {
  console.error('Usage: npx tsx scripts/cleanupOrphanAssignees.ts <workspaceId> [--apply]');
  process.exit(1);
}
const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
if (!workspace) {
  console.error(`No workspace with id ${workspaceId}`);
  process.exit(1);
}
const orphans = await prisma.assignee.findMany({
  where: { workspaceId, userId: null },
  include: { _count: { select: { conversations: true } } },
  orderBy: { createdAt: 'asc' },
});
const rows = orphans.map((a) => ({ id: a.id, name: a.name, color: a.color, createdAt: a.createdAt, chats: a._count.conversations }));
if (!apply) {
  console.log(JSON.stringify({ workspace: workspace.name, dryRun: true, wouldDelete: rows.filter((r) => r.chats === 0), wouldKeep: rows.filter((r) => r.chats > 0) }, null, 2));
  await prisma.$disconnect();
  process.exit(0);
}
let backup: string | null = null;
if (rows.some((r) => r.chats === 0)) {
  mkdirSync('backups', { recursive: true });
  backup = `backups/orphan-assignees-${workspaceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(backup, JSON.stringify(rows.filter((r) => r.chats === 0), null, 2));
}
const result = await removeOrphanAssignees(workspaceId);
console.log(JSON.stringify({ workspace: workspace.name, backup, ...result }, null, 2));
await prisma.$disconnect();
