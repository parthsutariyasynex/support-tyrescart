import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { AppError, notFound } from './errors.js';

// Your own profile picture (Settings → General → Profile). JPEG, PNG or WebP up to 2 MB, checked from the bytes;
// stored at uploads/avatars/<user id> and served only through the API with your sign-in.
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const TYPES: [string, (b: Buffer) => boolean][] = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];
const dir = () => path.join(env.uploadsDir, 'avatars');
const fileOf = (userId: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw notFound('Picture');
  return path.join(dir(), userId);
};

export async function saveAvatar(userId: string, bytes: Buffer | undefined, rawMime: string | undefined) {
  if (!bytes?.length) throw new AppError('Choose a picture', 400, 'BAD_USER_INPUT');
  if (bytes.length > AVATAR_MAX_BYTES) throw new AppError('Profile pictures can be up to 2 MB', 413, 'TOO_LARGE');
  const mime = (rawMime ?? '').toLowerCase().split(';')[0].trim();
  const type = TYPES.find(([m, looks]) => m === mime && looks(bytes));
  if (!type) throw new AppError('Use a JPG, PNG or WebP picture', 415, 'UNSUPPORTED_MEDIA');
  await mkdir(dir(), { recursive: true });
  await writeFile(fileOf(userId), bytes);
  return prisma.user.update({
    where: { id: userId },
    data: { avatarMime: type[0], avatarUpdatedAt: new Date(), updatedBy: userId },
    select: { avatarUpdatedAt: true },
  });
}

export async function removeAvatar(userId: string) {
  await rm(fileOf(userId), { force: true });
  await prisma.user.update({ where: { id: userId }, data: { avatarMime: null, avatarUpdatedAt: null, updatedBy: userId } });
}

export async function readAvatar(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarMime: true } });
  if (!user?.avatarMime) throw notFound('Picture');
  try {
    return { bytes: await readFile(fileOf(userId)), mime: user.avatarMime };
  } catch {
    throw notFound('Picture');
  }
}
