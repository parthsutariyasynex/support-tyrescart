import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getMe, login, register } from '../services/auth.js';

// REST version of the auth API. The web app uses the GraphQL one (/graphql);
// both share the same logic in services/auth.ts.
export const authRouter = Router();

// "Create workspace": new user + workspace, user becomes owner
authRouter.post('/register', async (req, res) => {
  const { token } = await register(req.body);
  res.json({ token });
});

authRouter.post('/login', async (req, res) => {
  const { token } = await login(req.body, req.ip ?? 'unknown');
  res.json({ token });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json(await getMe(req.auth!));
});
