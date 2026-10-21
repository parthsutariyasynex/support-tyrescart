import 'dotenv/config';
import path from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: required('JWT_SECRET'),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:4000',
  metaAppSecret: process.env.META_APP_SECRET ?? '',
  metaVerifyToken: required('META_VERIFY_TOKEN'),
  graphVersion: process.env.GRAPH_API_VERSION ?? 'v21.0',
  isProd: process.env.NODE_ENV === 'production',
  // Meta's Graph API (overridable only so tests can point it at a mock; nothing to set in normal use)
  graphBase: (process.env.GRAPH_API_BASE || 'https://graph.facebook.com').replace(/\/$/, ''),
  // Meta app id: only needed to create templates with an image/video/document header (Meta wants a sample file,
  // uploaded through the app's Resumable Upload API). Optional.
  metaAppId: process.env.META_APP_ID || '',
  // Product name used in emails (subjects and text)
  appName: process.env.APP_NAME || 'support-tyrescart',
  // How often assignees are reminded (toast) about their open chats still waiting for a reply; 0 disables
  assignmentReminderMinutes: Number(process.env.ASSIGNMENT_REMINDER_MINUTES ?? 5),
  // Minutes without activity on any tab before a connected person shows as Away
  presenceAwayMinutes: Number(process.env.PRESENCE_AWAY_MINUTES ?? 5),
  // Where copies of images sent from the app are kept (one folder per workspace); back it up with the database
  uploadsDir: path.resolve(process.env.UPLOADS_DIR || 'uploads'),
  // Creating new workspaces (sign-up without a team link, "Create workspace"): closed in production unless
  // ALLOW_WORKSPACE_CREATION=true; open elsewhere so development and the e2e tests can set up workspaces.
  // Admins add users from the Teams page instead.
  allowWorkspaceCreation: process.env.ALLOW_WORKSPACE_CREATION
    ? process.env.ALLOW_WORKSPACE_CREATION === 'true'
    : process.env.NODE_ENV !== 'production',
};
