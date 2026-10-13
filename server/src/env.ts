import 'dotenv/config';

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
  // Creating new workspaces (sign-up without a team link, "Create workspace"): closed in production unless
  // ALLOW_WORKSPACE_CREATION=true; open elsewhere so development and the e2e tests can set up workspaces.
  // Admins add users from the Teams page instead.
  allowWorkspaceCreation: process.env.ALLOW_WORKSPACE_CREATION
    ? process.env.ALLOW_WORKSPACE_CREATION === 'true'
    : process.env.NODE_ENV !== 'production',
};
