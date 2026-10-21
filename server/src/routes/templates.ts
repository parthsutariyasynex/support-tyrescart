import express, { Router } from 'express';
import { requireAuth } from '../auth.js';
import { createMessageTemplate, updateMessageTemplate } from '../services/templates.js';

// Settings → Templates, for templates with an image/video/document header: the body is the sample file Meta
// reviews; `spec` (JSON, as for the GraphQL mutations) and `fileName` are query parameters. Owners/admins.
export const templatesRouter = Router();
templatesRouter.use(requireAuth);

const specOf = (raw: unknown) => {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
};
const fileOf = (req: express.Request) => ({
  bytes: Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined,
  mime: req.headers['content-type'],
  name: typeof req.query.fileName === 'string' ? req.query.fileName : undefined,
});

templatesRouter.post('/', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  res.json(await createMessageTemplate(req.auth!, specOf(req.query.spec), fileOf(req)));
});

templatesRouter.put('/:id', express.raw({ type: () => true, limit: '100mb' }), async (req, res) => {
  res.json({ ok: await updateMessageTemplate(req.auth!, req.params.id, specOf(req.query.spec), fileOf(req)) });
});
