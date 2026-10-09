import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { connectWhatsApp } from '../services/settings.js';

// REST version of the settings API, kept for compatibility. The web app uses GraphQL (/graphql).
export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.post('/whatsapp', async (req, res) => {
  const account = await connectWhatsApp(req.auth!.workspaceId, req.body);
  res.json({ ok: true, displayPhone: account.displayPhone });
});
