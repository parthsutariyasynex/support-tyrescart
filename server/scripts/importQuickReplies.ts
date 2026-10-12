// Import quick replies from a klever_tyres_chat SQL dump into one workspace.
//   npx tsx scripts/importQuickReplies.ts <dump.sql> <workspaceId>
// Safe to run again: replies already in the workspace (same shortcut and text) are skipped.
import { readFileSync } from 'node:fs';
import { prisma } from '../src/prisma.js';
import { parseQuickReplyDump, possibleLostEmojis } from '../src/services/quickReplyImport.js';

const [file, workspaceId] = process.argv.slice(2);
if (!file || !workspaceId) {
  console.error('Usage: npx tsx scripts/importQuickReplies.ts <dump.sql> <workspaceId>');
  process.exit(1);
}
const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });
if (!workspace) {
  console.error(`No workspace with id ${workspaceId}`);
  process.exit(1);
}
const replies = parseQuickReplyDump(readFileSync(file, 'utf8'));
const existing = await prisma.quickReply.findMany({ where: { workspaceId }, select: { shortcut: true, description: true } });
const key = (r: { shortcut: string; description: string | null }) => `${r.shortcut}\u0000${r.description ?? ''}`;
const have = new Set(existing.map(key));
const fresh = replies.filter((r) => !have.has(key(r)));
if (fresh.length) await prisma.quickReply.createMany({ data: fresh.map((r) => ({ ...r, workspaceId })) });
console.log(`${workspace.name} (${workspaceId}): ${replies.length} in file, ${fresh.length} imported, ${replies.length - fresh.length} already there`);
// Imported exactly as in the file; these probably lost emojis before the export and need their text restored
const damaged = replies.map((r) => ({ shortcut: r.shortcut, n: possibleLostEmojis(r.description) })).filter((r) => r.n > 0);
if (damaged.length) {
  console.warn(`\n${damaged.length} replies have "?" where an emoji probably was (lost before the export; restore the text at the source):`);
  for (const d of damaged) console.warn(`  - ${d.shortcut}: ${d.n}`);
}
await prisma.$disconnect();
