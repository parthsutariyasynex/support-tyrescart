import { z } from 'zod';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { AppError } from './errors.js';
import { parse } from './validate.js';

const connectSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  accessToken: z.string().trim().min(10),
});

// Never select accessToken here: this is what clients get to see
const publicFields = { wabaId: true, phoneNumberId: true, displayPhone: true } as const;

export function getWhatsAppAccount(workspaceId: string) {
  return prisma.whatsAppAccount.findUnique({ where: { workspaceId }, select: publicFields });
}

// Manual connect (paste IDs from Meta). Replace with Embedded Signup for real customers.
export async function connectWhatsApp(workspaceId: string, rawInput: unknown) {
  const { wabaId, phoneNumberId, accessToken } = parse(connectSchema, rawInput);

  // Check the credentials work and fetch the display number
  let r: Response;
  let info: any;
  try {
    r = await fetch(
      `https://graph.facebook.com/${env.graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) },
    );
    info = await r.json();
  } catch {
    throw new AppError('Could not reach Meta. Try again.', 502, 'META_UNREACHABLE');
  }
  if (!r.ok) throw new AppError(info?.error?.message ?? 'Invalid credentials', 400, 'INVALID_CREDENTIALS');

  const taken = await prisma.whatsAppAccount.findUnique({ where: { phoneNumberId } });
  if (taken && taken.workspaceId !== workspaceId)
    throw new AppError('Number is connected to another workspace', 409, 'NUMBER_TAKEN');

  const data = { wabaId, phoneNumberId, accessToken, displayPhone: info.display_phone_number };
  return prisma.whatsAppAccount.upsert({
    where: { workspaceId },
    update: data,
    create: { workspaceId, ...data },
    select: publicFields,
  });
}
