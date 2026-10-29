import express, { Router } from 'express';
import { requireAuth } from '../auth.js';
import { avatarChanged, readAvatar, readTeamAvatar, removeAvatar, saveAvatar } from '../services/avatar.js';

// Your own profile picture: the body is the image itself (Content-Type image/jpeg, image/png or image/webp)
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.put('/avatar', express.raw({ type: () => true, limit: '3mb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  const { avatarUpdatedAt } = await saveAvatar(req.auth!.userId, body, req.headers['content-type']);
  await avatarChanged(req.auth!.userId, avatarUpdatedAt);
  res.json({ avatarUpdatedAt });
});

meRouter.delete('/avatar', async (req, res) => {
  await removeAvatar(req.auth!.userId);
  await avatarChanged(req.auth!.userId, null);
  res.json({ ok: true });
});

meRouter.get('/avatar', async (req, res) => {
  sendAvatar(res, await readAvatar(req.auth!.userId));
});

// A teammate's profile picture (chats: message bubbles, Assign menu, @mentions, collaborators), only for people in
// the same workspace
export const avatarsRouter = Router();
avatarsRouter.use(requireAuth);

avatarsRouter.get('/:userId', async (req, res) => {
  sendAvatar(res, await readTeamAvatar(req.auth!.workspaceId, req.params.userId));
});

function sendAvatar(res: express.Response, { bytes, mime }: { bytes: Buffer; mime: string }) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
}
