import express, { Router } from 'express';
import { requireAuth } from '../auth.js';
import { readAvatar, removeAvatar, saveAvatar } from '../services/avatar.js';

// Your own profile picture: the body is the image itself (Content-Type image/jpeg, image/png or image/webp)
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.put('/avatar', express.raw({ type: () => true, limit: '3mb' }), async (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : undefined;
  const { avatarUpdatedAt } = await saveAvatar(req.auth!.userId, body, req.headers['content-type']);
  res.json({ avatarUpdatedAt });
});

meRouter.delete('/avatar', async (req, res) => {
  await removeAvatar(req.auth!.userId);
  res.json({ ok: true });
});

meRouter.get('/avatar', async (req, res) => {
  const { bytes, mime } = await readAvatar(req.auth!.userId);
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
});
