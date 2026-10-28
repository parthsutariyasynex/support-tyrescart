import 'dotenv/config';
import os from 'node:os';
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
  // Push notifications (Firebase Cloud Messaging). Off unless a Firebase service account is given: the JSON itself
  // (FIREBASE_SERVICE_ACCOUNT) or the path to its file (FIREBASE_SERVICE_ACCOUNT_FILE). Secret: server only.
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  firebaseServiceAccountFile: process.env.FIREBASE_SERVICE_ACCOUNT_FILE || '',
  // AI Assistant (AI Summary and AI Reply): through OpenRouter when OPENROUTER_API_KEY is set (AI_MODEL: an OpenRouter
  // model id), otherwise Anthropic's Claude (ANTHROPIC_API_KEY). Off when neither is set. Secrets: server only.
  openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
  // Overridable only so tests can point it at a mock
  openRouterBase: (process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || (process.env.OPENROUTER_API_KEY ? 'google/gemma-4-26b-a4b-it:free' : 'claude-opus-5-5'),
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
  // Backend logs (LogEntry): days they are kept, and what the daily clean-up does with older ones: dry-run (default,
  // only counts them), delete, or off. Checked in services/logRetention.ts.
  logRetentionDays: process.env.LOG_RETENTION_DAYS,
  logRetentionMode: process.env.LOG_RETENTION_MODE,
  // The daily log files (logs/YYYY-MM-DD.log, JSON lines): their folder, and LOG_TO_FILE=false to not write them
  // Test runs (node --test) never write to the real logs/ folder: a temporary one unless LOG_DIR is set
  logDir: path.resolve(process.env.LOG_DIR || (process.env.NODE_TEST_CONTEXT ? path.join(os.tmpdir(), 'support-tyrescart-test-logs') : 'logs')),
  logToFile: process.env.LOG_TO_FILE !== 'false',
  // Customer data in the logs (default on): message text, the customer's number and name, WhatsApp's ids (wamid) and
  // the full payloads sent to and received from Meta, so every message can be traced exactly. LOG_CUSTOMER_DATA=false
  // logs ids, statuses and errors only (numbers masked, wamids as one-way references). Secrets are redacted either way.
  logCustomerData: process.env.LOG_CUSTOMER_DATA !== 'false',
  // How long a call to Meta may take before it is given up and logged as a timeout: sends and other JSON calls, and
  // file uploads (large documents take longer)
  metaTimeoutMs: Number(process.env.META_TIMEOUT_MS) > 0 ? Number(process.env.META_TIMEOUT_MS) : 30_000,
  metaUploadTimeoutMs: Number(process.env.META_UPLOAD_TIMEOUT_MS) > 0 ? Number(process.env.META_UPLOAD_TIMEOUT_MS) : 300_000,
  // Address search and "what's here" for the Location screen (services/geocoding.ts): an OpenStreetMap Nominatim
  // server. Default: the free public one (1 request a second, no search-as-you-type; its usage policy applies).
  // Set to your own or a hosted Nominatim, or "off" to turn search off.
  geocoderUrl: (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
  // A contact email or URL sent with those requests (the public server asks every app to identify itself)
  geocoderContact: process.env.GEOCODER_CONTACT || '',
  // The address customers use to open the web app: links in messages (live location pages) start with it
  publicAppUrl: (process.env.PUBLIC_APP_URL || process.env.WEB_ORIGIN || 'http://localhost:4000').replace(/\/$/, ''),
  // Map pictures on the public live location page: a {z}/{x}/{y} tile server (default: OpenStreetMap's, which needs
  // the attribution shown and allows light use only)
  mapTileUrl: process.env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  mapAttribution: process.env.MAP_ATTRIBUTION || '© OpenStreetMap contributors',
};
