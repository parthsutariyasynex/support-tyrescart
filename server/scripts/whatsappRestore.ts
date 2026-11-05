// Restore a workspace's previous WhatsApp number (rollback after Settings → Company details → WhatsApp replaced it).
//   npm run whatsapp:restore                         list every workspace's backups (tokens are never printed)
//   npm run whatsapp:restore -- <workspaceId>        restore the newest backup of that workspace
//   npm run whatsapp:restore -- <workspaceId> <backupId>   restore a specific backup
//   add --by=<admin email> to record who ran it (default: the computer's user name)
// The number connected now is itself backed up first, so a restore can be undone the same way. Nothing is checked
// with Meta here: the restored credentials are the ones that worked before.
import '../src/env.js';
import { prisma } from '../src/prisma.js';
import { recordWhatsAppConnection } from '../src/services/whatsappAudit.js';
import os from 'node:os';

// Who ran it, for the audit log: --by=<email> (an existing user), else the computer's user name
async function whoRan(by: string | undefined) {
  const user = by ? await prisma.user.findUnique({ where: { email: by }, select: { id: true } }) : null;
  if (by && !user) throw new Error(`No user with the email ${by}`);
  return { actorId: user?.id ?? null, actorLabel: user ? null : `Command line (${os.userInfo().username})` };
}

async function main() {
  const args = process.argv.slice(2);
  const by = args.find((a) => a.startsWith('--by='))?.slice(5);
  const [workspaceId, backupId] = args.filter((a) => !a.startsWith('--'));
  if (!workspaceId) {
    const backups = await prisma.whatsAppAccountBackup.findMany({
      orderBy: { replacedAt: 'desc' },
      select: { id: true, workspaceId: true, displayPhone: true, phoneNumberId: true, wabaId: true, replacedAt: true },
    });
    if (!backups.length) return console.log('No WhatsApp backups.');
    console.table(backups.map((b) => ({ ...b, replacedAt: b.replacedAt.toISOString() })));
    return;
  }

  const actor = await whoRan(by);
  const current = await prisma.whatsAppAccount.findUnique({ where: { workspaceId }, select: { wabaId: true, phoneNumberId: true, displayPhone: true } });
  let backup: Awaited<ReturnType<typeof prisma.whatsAppAccountBackup.findFirst>> = null;
  let newBackupId: string | null = null;
  try {
    await restore();
    await recordWhatsAppConnection({ workspaceId, ...actor, action: 'restore', status: 'success', source: 'script', previous: current, newDisplayPhone: backup!.displayPhone, phoneNumberId: backup!.phoneNumberId, wabaId: backup!.wabaId, backupId: newBackupId });
  } catch (err) {
    await recordWhatsAppConnection({ workspaceId, ...actor, action: 'restore', status: 'failed', source: 'script', previous: current, newDisplayPhone: backup?.displayPhone, phoneNumberId: backup?.phoneNumberId, wabaId: backup?.wabaId, backupId: null, error: err }); // a failed restore rolled back its backup too
    throw err;
  }

  async function restore() {
    backup = await prisma.whatsAppAccountBackup.findFirst({
      where: { workspaceId, ...(backupId ? { id: backupId } : {}) },
      orderBy: { replacedAt: 'desc' },
    });
    if (!backup) throw Object.assign(new Error(`No backup found for workspace ${workspaceId}${backupId ? ` with id ${backupId}` : ''}`), { code: 'NO_BACKUP' });
    const chosen = backup;

    const taken = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId: chosen.phoneNumberId } });
    if (taken && taken.workspaceId !== workspaceId) throw Object.assign(new Error(`Number ${chosen.displayPhone} is now connected to workspace ${taken.workspaceId}`), { code: 'NUMBER_TAKEN' });

    await prisma.$transaction(async (tx) => {
      const current = await tx.whatsAppAccount.findUnique({ where: { workspaceId } });
      if (current)
        newBackupId = (
          await tx.whatsAppAccountBackup.create({
            data: { workspaceId, wabaId: current.wabaId, phoneNumberId: current.phoneNumberId, displayPhone: current.displayPhone, accessToken: current.accessToken, replacedBy: actor.actorId ?? 'whatsapp:restore' },
            select: { id: true },
          })
        ).id;
      const data = { wabaId: chosen.wabaId, phoneNumberId: chosen.phoneNumberId, displayPhone: chosen.displayPhone, accessToken: chosen.accessToken };
      await tx.whatsAppAccount.upsert({ where: { workspaceId }, update: { ...data, updatedBy: 'whatsapp:restore' }, create: { workspaceId, ...data, createdBy: 'whatsapp:restore' } });
      await tx.whatsAppAccountBackup.delete({ where: { id: chosen.id } });
      console.log(`Restored ${chosen.displayPhone ?? chosen.phoneNumberId}${current ? ` (replacing ${current.displayPhone ?? current.phoneNumberId}, now backed up)` : ''}.`);
    });
  }
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
