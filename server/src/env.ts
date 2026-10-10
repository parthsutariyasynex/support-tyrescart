import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 5000),
  jwtSecret: required('JWT_SECRET'),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  metaAppSecret: process.env.META_APP_SECRET ?? '',
  metaVerifyToken: required('META_VERIFY_TOKEN'),
  graphVersion: process.env.GRAPH_API_VERSION ?? 'v21.0',
  isProd: process.env.NODE_ENV === 'production',
};
