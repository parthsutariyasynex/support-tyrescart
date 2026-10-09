# ChatDesk: WhatsApp Business SaaS starter

A shared inbox, broadcasts and automations on the official **WhatsApp Cloud API**.

```
server/   Node.js + Express + Prisma + Socket.io   (API, webhook, real-time)  :4000
web/      Next.js + Tailwind                        (login, inbox, settings)    :3000
```

## Run locally

```bash
# terminal 1: API
cd server
npm install
npx prisma db push      # creates SQLite dev.db
npm run dev

# terminal 2: web
cd web
npm install
npm run dev
```

Open http://localhost:3000, create a workspace, open **Inbox** and click **Simulate**. A fake customer
message appears live. Sending replies needs a real WhatsApp number (see below).

## Connect real WhatsApp

1. Go to developers.facebook.com and create an app (type Business), then add **WhatsApp**.
2. Open **WhatsApp > API Setup** and copy the *Phone number ID*, *WhatsApp Business Account ID* and a token.
   For production, create a System User token with `whatsapp_business_messaging` + `whatsapp_business_management`.
3. In the app, open **Settings** and paste them, then click Connect.
4. Webhook (Meta needs a public HTTPS URL): run `ngrok http 4000`, then in **WhatsApp > Configuration** set
   - Callback URL: `https://<ngrok-id>.ngrok-free.app/webhook`
   - Verify token: `META_VERIFY_TOKEN` from `server/.env`
   - Subscribe to the **messages** field.
5. Set `META_APP_SECRET` (App settings > Basic) in `server/.env` so webhook signatures are verified.

## What's built

- Email/password auth, workspace per business (multi-tenant)
- Webhook: verification, signature check, incoming messages, delivered/read statuses, duplicate protection
- Live shared inbox (Socket.io rooms per workspace), unread counts, status ticks
- 24-hour window rule: free text inside the window, approved template outside it
- Start a new chat by number (first message must be a template)

## Next to build

1. **Templates**: create and sync via `GET/POST /{waba_id}/message_templates`
2. **Contacts**: CSV import, tags, segments
3. **Broadcasts**: BullMQ + Redis queue, scheduling, rate limits, per-recipient status
4. **Media**: download incoming media (`GET /{media_id}`), upload outgoing media to S3/R2
5. **Automations / bot**: keyword replies, welcome/away messages, flow builder (React Flow), AI replies
6. **Embedded Signup**: let customers connect their own number in one click (requires Tech Provider status)
7. **Team**: invite agents, assign conversations, roles
8. **Billing**: plans + message-credit wallet (Stripe/Razorpay)

## Production checklist

- Switch Prisma `provider` to `postgresql` and point `DATABASE_URL` at Postgres
- Encrypt `WhatsAppAccount.accessToken` at rest
- Set `NODE_ENV=production` (disables the simulate endpoint and unsigned webhooks)
- Use the Socket.io Redis adapter if you run more than one API instance
- Put the API behind HTTPS (Nginx + Let's Encrypt)
