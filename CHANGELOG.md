# Changelog

Every notable change to **TyresCart Support Chat** (web client and API server), newest version first.

## How this file works

- **Format**: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Each version lists **Added**, **Changed**,
  **Fixed**, **Removed** and **Security**, then **Database** (schema changes) and **Deploy notes** (steps production
  needs) when there are any.
- **Versions**: [Semantic Versioning](https://semver.org/) — `MAJOR.MINOR.PATCH`.
  - **PATCH** (1.1.0 → 1.1.1): bug fixes only.
  - **MINOR** (1.1.x → 1.2.0): new features, nothing existing breaks.
  - **MAJOR** (1.x → 2.0.0): a change that breaks how the app or its API is used (e.g. a removed feature or API field
    that something depends on).
- Versions up to 1.2.0 were assigned afterwards from the git history (the project had no version numbers before).
  Each version lists its commits; `git show <commit>` shows the code.
- Entries describe what agents and admins notice. Technical details are kept to what's needed to deploy or debug.

### Adding a change

1. Write it under **[Unreleased]** in the right section, in the same commit as the code.
2. If production needs a step (SQL, new `.env` value, config, server restart), add it under **Deploy notes**.
3. When releasing: rename **[Unreleased]** to the new version and date (e.g. `## [1.3.0] - 2026-10-30`), add a new
   empty **[Unreleased]** above it, set the same version in `package.json`, and tag the commit: `git tag v1.3.0`.

---

## [Unreleased]

Status: **not yet deployed to production**. The logging below is committed (`1cb532e`); everything else here is not
committed yet.

- **WhatsApp text formatting**: \*bold\*, \_italic\_, \~strikethrough\~, monospace, code, lists and quotes, shown in
  messages and notes, and in the message box while you type, like WhatsApp.
- **Location**: send your location or any place (map, search), shown as a map in the chat that opens in Google Maps or
  Apple Maps; plus **live location** for 15 minutes, 1 hour or 8 hours.
- **Centralized backend logging**: what happens on the server (sign-ins, refusals, WhatsApp/Meta calls, webhooks,
  message sends and deliveries, errors) is recorded in one place, so a problem can be traced afterwards.

### Added
- **WhatsApp formatting in the chat**: messages (sent, received, history, arriving live) and internal notes show
  WhatsApp's formatting: `*bold*`, `_italic_`, `~strikethrough~`, ```` ```monospace``` ```` (may span lines),
  `` `inline code` ``, `- ` / `* ` bulleted lists, `1. ` numbered lists (numbers kept as typed), `> ` quotes, and
  combinations such as `*_bold italic_*`. The rules are WhatsApp's: markers must touch the text and sit at word edges,
  so `2*3*4`, `snake_case` and web addresses (`https://x.ae/a_b_c`) stay as typed. Links still open in a new tab;
  "Search in conversation" still marks matches; @mentions in notes stay highlighted.
- **Formatting while typing**: the message box (Reply and Add note) shows the formatting as you type, like WhatsApp:
  close `*abcd*` and it turns bold, with the `*` shown faded. The text is sent exactly as typed, so the customer's
  WhatsApp formats it the same way.
- **Format bar on selection**: selecting text in the message box shows a small bar (bold, italic, strikethrough,
  monospace, code, bulleted list, numbered list, quote) that wraps the selection or the lines it touches, or takes the
  formatting off again. Shortcuts as in WhatsApp Desktop: Ctrl/⌘+B bold, Ctrl/⌘+I italic, Ctrl/⌘+Shift+X
  strikethrough, Ctrl/⌘+Shift+M monospace. Ctrl/⌘+Z undoes formatting like typing.
- **Location** (📎 → Location): a map that opens on where you are (the browser asks for permission the first time),
  with a pin you drag or move by tapping the map.
  - **Send your current location** (with its address) or **Send this location** (the pinned place, with its name and
    address).
  - **Search** for a place or address (press Enter or Search).
  - Sent with WhatsApp's own location message, so the customer sees a normal WhatsApp location pin. Inside the 24-hour
    window only, like any message that isn't a template.
  - Location blocked, unavailable or not on https: a clear message says what to do; the map and search still work.
- **Locations in the chat**: sent and received locations show as a map with the pin, the place's name and address,
  and **Google Maps** / **Apple Maps** buttons. Clicking the map opens the exact point in Apple Maps on Apple devices,
  Google Maps elsewhere. Chat list and reply quotes read "📍 Place name".
- **Live location** (15 minutes, 1 hour or 8 hours): WhatsApp's Business API can't send a live location, so the
  customer gets a message with a private link to a map page that follows the teammate's position in real time and
  links to Google/Apple Maps. A "You're sharing your live location until …" bar has **Stop sharing**; the card in the
  chat shows live or ended. The sharer or an admin can stop it; the link stops working once it ends.
- **Customer's live location**: WhatsApp doesn't pass it on to businesses; the chat now says so and suggests asking
  for their current location instead.
- **Webhook: calls and Meta's errors**: a Calls event (WhatsApp Business Calling) is logged as a count only (never who
  called or the call details). Incoming messages log Meta's errors when it sends some (e.g. 131051 for a message type
  it doesn't support): a `message.received` log entry per incoming message, WARNING with the provider's code and
  explanation (`providerErrorCode`, `providerErrorMessage`, at most 500 characters), SUCCESS otherwise.
- **Backend log** (`LogEntry` table): one entry per notable event, as SUCCESS, WARNING or ERROR, with the time, the
  event name, the workspace and person involved, the error code and how long it took. Covers:
  - sign-ins (successful, wrong password, unknown email, deactivated account, too many attempts);
  - permission refusals (e.g. an agent trying an admin-only action);
  - every GraphQL mutation (succeeded or refused with its code) and unexpected GraphQL errors;
  - HTTP errors, unhandled errors, and REST requests that change something;
  - every WhatsApp/Meta API call (send, upload, download, templates) with Meta's numeric error code;
  - webhooks (bad signature, unknown number, failed items, a summary per delivery);
  - message sends (sent / refused) and delivery statuses (sent → delivered → read, or failed with Meta's code and a
    plain explanation for 131047, 131049, 131026 and 131050).
- **Daily log files**: the same entries as readable lines in `server/logs/app-YYYY-MM-DD.log` (server time, with its
  offset). `tail -f` / grep friendly. `LOG_DIR` sets the folder, `LOG_TO_FILE=false` turns them off.
- **Request ids**: every request gets an `X-Request-Id` (also in each of its log entries and in a 500 error's
  response), so one request can be followed through everything it caused.
- **Log retention**: a daily job finds log entries and log files older than `LOG_RETENTION_DAYS` (default 90). By
  default it only counts them (`LOG_RETENTION_MODE=dry-run`); `delete` removes them in small batches, `off` disables
  it. `npm run logs:retention` runs the same check by hand (add `-- --delete` to remove).
- `GraphApiError`: a refusal from Meta keeps its numeric code, subcode and trace id (same message as before).

### Changed
- The 📎 button opens a small menu: **Photo or document** (as before) and **Location**. Dropping a file on the chat
  works as before.
- The message box no longer uses kerning (spacing tweaks between letter pairs, barely visible), so the formatted
  text drawn in it lines up exactly with the cursor.

### Fixed
- Auto-reply: when the chat or its workspace was deleted while WhatsApp was still answering, the reply's message was
  already gone and updating it failed with "No record was found for an update" ("auto-reply failed"). It now finishes
  quietly and logs a WARNING (`automation.auto_reply_discarded`).

### Security
- Logs never contain passwords, tokens, secrets, authorization headers, customer phone numbers or message text:
  values are sanitized (redacted and shortened) before they are saved or written. Logging can't break or slow down
  the app: if the database or the folder can't be written, the entry goes to the terminal instead.
- `server/logs/` is git-ignored.
- Formatting is shown as text, never as HTML, so nothing a customer writes can inject markup. Only `http(s)` and
  `www.` addresses become links (`javascript:` and the like stay text); links open in a new tab with
  `rel="noopener noreferrer"`.
- The live location page (`/live/<token>`) needs no sign-in: its random token is the key. It shows only the shared
  position and the sharer's name (never the chat, the customer or anything else of the workspace), only while
  sharing. It has a strict Content-Security-Policy (no outside scripts), isn't cached or indexed, and the map tiles'
  server never sees the token. Positions are accepted only from the person sharing.
- Place search goes through the server, which keeps OpenStreetMap's usage rules for the whole app: at most 1 request
  a second, results cached, requests identified, searches only when asked (no search-as-you-type).

### Known limits
- Live location keeps updating only while the sharer has the app open (a browser gives no position to a closed tab),
  and a server restart ends every live location (they are kept in memory; the messages stay).
- Live locations are held by one API process: run the API as a single process (not PM2 cluster mode), or the link may
  reach a process that doesn't know it.
- Map pictures and place search use OpenStreetMap's free servers, meant for light use with no guarantee; they can be
  switched to another provider in `.env` without code changes.

### Database
- New table `LogEntry` (no links to other tables; indexes on time, workspace + time, level + time and request id).
- Formatting, Location and the webhook logging need no database changes: a location is a message of type `location`
  (live: `live_location`) whose text ends with a Google Maps link holding the exact coordinates.

### Deploy notes
- Back up the production database, then create the table with the saved SQL
  (`server/backups/logentry-20261024-181902.sql`, only `CREATE TABLE LogEntry`) or `npm run db:push` after checking
  the target.
- Optional `.env`: `LOG_DIR` (e.g. `/var/log/support-tyrescart`), `LOG_TO_FILE`, `LOG_RETENTION_DAYS`,
  `LOG_RETENTION_MODE` (leave dry-run until you have reviewed `npm run logs:retention`).
- Run `npm install` from the project root: the client has a new package, `leaflet` 1.9.4 (the map on the Location
  screen).
- Server `.env`: set `PUBLIC_APP_URL` to the app's **https** address (live location links start with it; browsers
  share a location only over https) and `GEOCODER_CONTACT` to a contact email (OpenStreetMap asks apps to identify
  themselves). Optional: `GEOCODER_URL` (another Nominatim server, or `off` to hide search), `MAP_TILE_URL` /
  `MAP_ATTRIBUTION` (the live page's map). Client: `NEXT_PUBLIC_MAP_TILE_URL` / `NEXT_PUBLIC_MAP_ATTRIBUTION`.
- Deploy the client too: `next.config.ts` sends `/live/*` to the API (the customer's live location page).
- Keep the API to one process while live location is used (see Known limits).

---

## [1.2.0] - 2026-10-23 — Internal notes, @mentions and note attachments

Commit: `b78a5d8`. Status: **not yet deployed to production**.

Team members can now leave internal notes inside a chat, mention each other, and attach files — none of it is ever
sent to the customer.

### Added
- **Internal notes in the chat**: the "Add note" tab (next to Reply) saves a note; it appears between the messages as a
  yellow, dashed "Internal note" bubble on the team's side, with the author's name and "only your team sees this".
  Notes appear live for everyone with the chat open, show "edited" after an edit, and disappear when deleted.
- **@mentions**: typing `@` in a note lists the workspace's active teammates (avatar, name, email; never yourself).
  Typing filters the list; ↑ ↓ / Enter / Tab pick a person; Esc closes only the list. Mentions are highlighted in the
  bubble.
- **Mentions inbox** in the left menu: the chats where a teammate @mentioned you, with the usual tabs, filters and sort;
  updates live.
- **Mention notifications**: the person mentioned gets a pop-up ("deep patel mentioned you in a note.") and, while in
  another tab, a desktop notification with sound. A 🔔 entry is kept for them even if they were offline, and shows as
  new next time. Only the person mentioned sees it (not even admins see other people's mentions).
- **Files on notes**: 📎 in Add note attaches up to 10 images (JPEG, PNG) or documents (PDF, Word, Excel, PowerPoint,
  text) per note. Images show as thumbnails, documents with name and size; a click downloads. A note may be files only.
- **Agents on New Leads** can add a note on an unassigned chat ("Add note" next to "Assign to Me"); replying still needs
  Assign to Me, and a note doesn't assign the chat.

### Changed
- Editing a note updates its mentions: an `@Name` taken out removes that mention; a new one is mentioned and notified;
  people still mentioned keep one entry with the new text.
- Profile → Remarks shows a note's files.
- Clear chat also hides older notes, for the person who cleared it only.

### Fixed
- Deleting a note removes it from the Mentions inbox and the 🔔 of everyone it mentioned.

### Security
- Note files are checked by their actual bytes (a renamed `.exe` is refused), stored in the uploads folder and served
  only to signed-in members of the same workspace. A file uploaded but never saved with a note is visible only to the
  uploader and removed after a day. Deleting a note deletes its files from the database and disk.
- Only active teammates of the workspace can be mentioned; anything else is refused and the note isn't saved.
- Notes are never messages: nothing reaches WhatsApp or Meta.

### Database
- New table **`RemarkFile`** (files on notes). No existing table changes.

### Deploy notes
1. Back up the production database, then run `server/backups/remark-files-20261023-162253.sql`.
2. Deploy the server and the client together. The client's `next.config.ts` adds the rewrites
   `/inbox/contacts/:id/remark-files` and `/inbox/remark-files/:id`; without them note files fail to upload (404).

---

## [1.1.1] - 2026-10-23 — 24-hour window fixes

Commit: `6fa7836`. Status: **not yet deployed to production**.

### Fixed
- The auto-reply is no longer sent after the 24-hour window has closed (for example, a webhook Meta delivers hours
  late for a message the customer wrote over a day ago).
- Meta's own notices — `system` (e.g. "customer changed number") and `request_welcome` — are no longer treated as
  customer messages: no `[system]` bubble, no unread count, no window, no auto-reply.
- The chat screen uses only the server's "customer last wrote" time (Meta's timestamp), so screen and server always
  agree on whether the window is open.
- If the server refuses a reply because the window has closed, the message box switches to "Send template" at once
  (per chat) and says why.

---

## [1.1.0] - 2026-10-23 — New chat and favicon

Commits: `9537f21` (with the New chat dialog first added in `b20fd33`). Status: **not yet deployed to production**.

### Added
- **New chat** (＋ in the chat list header, always available): country code (searchable, defaults to the workspace's
  country) and number, checked as you type ("+97112345 isn't a valid number"); a pasted `+91 …` number works too;
  optional name for a new contact. The first message must be a template, so the chat opens on "Send template".
- **Browser tab icon (favicon)**: the TyresCart logo (`client/app/icon.png`, `client/app/favicon.ico`).

### Changed
- Starting a chat with a number that already has one opens that chat ("This number already has a chat: opened it.");
  the saved name is kept and a deleted contact comes back instead of being added again.
- New chats appear in every agent's inbox live.

### Fixed
- Two people starting the same number at the same moment get the same contact and chat (no duplicates).

---

## [1.0.0] - 2026-10-23 — WhatsApp templates and the 24-hour window

Commit: `b20fd33`. Status: **not yet deployed to production**.

The first version that follows WhatsApp's messaging rules end to end: templates are only ever sent by a person, and
free-form messages only within 24 hours of the customer's last message.

### Added
- **24-hour customer service window**: after 24 hours since the customer last wrote, the message box, attachments,
  voice notes, replies and reactions give way to "24-hour window closed · The customer last wrote … · Send template".
  A timer switches the box the moment the 24 hours run out; a new customer message opens it again. Enforced on the
  server for every role (`WINDOW_CLOSED`), through the API and the live "typing…" indicator.
- **Bar above the message box**: Reply · Add note · Template.
- **Templates in the chat**: choosing a template shows just the finished message, with `{{1}}` / `{{2}}` filled from the
  customer's first / last name (saved name, else the WhatsApp name). A customer with no name gets "Hello 👋, …" (an
  invisible value is sent so WhatsApp accepts it). Boxes appear only for values that can't be filled in (an order number,
  a header file).
- **"Yes, Send" confirmation** before any template goes out, showing the template name and message. Cancel, Esc or a
  click outside send nothing; repeated clicks or retried requests send once.
- **Add note** (first version): an internal note saved to the customer's Remarks.

### Changed
- Template list: only the account's **approved** templates, read live from Meta; Meta's `hello_world` sample is hidden.
  Pending, rejected, paused and disabled templates are never offered or sent.
- Message length limits are now only WhatsApp's or the database's: 4,096 characters per message, edit and auto-reply;
  1,024 per caption; 16,000 per note (was 500 for auto-replies and 2,000 for notes). Text over a limit is kept as typed,
  marked red and not sent — never cut.
- A send that fails gives the text back in the message box.
- The "customer last wrote" time comes from Meta's timestamp, not from when the webhook reached the server.

### Removed
- **"Follow-up after 24 hours"** automation (Settings → Simple automations) and its background job and template
  watcher. Templates are never sent automatically any more. Follow-ups already sent keep their "🤖 Follow-up" tag.

### Security
- The server refuses any template request without the agent's confirmation (`CONFIRMATION_REQUIRED`, one-time request
  id), and the old send route without confirmation no longer accepts templates.

### Database
- No schema change. The follow-up columns (`AutomationSettings.followUp*`, `Conversation.followUpSentAt`) stay in the
  database, unused.

### Deploy notes
- Until 1.0.0 is deployed, production keeps running the old follow-up automation (it sends `follow_up_inquiry` 24 hours
  after a customer's last message). To stop it before deploying, switch off "Follow-up after 24 hours" in production's
  Settings → Simple automations.

---

## [0.10.0] - 2026-10-23 — Chat screen improvements

Commit: `060db9b`.

### Added
- **Stage filter** in the chat list's "Filter by" menu (lifecycle stages, several at once, live).
- **New-message pop-ups** on every page: the customer's name and message slide in at the top right; desktop
  notifications when the app is in the background; only for chats you may work on (owners/admins: all; others:
  unassigned, theirs and chats they collaborate on).
- **Notification sound** on/off in Settings → Notifications (saved per browser).
- **Country code** drop-down in the chat header (flag and code, e.g. 🇮🇳 +91, every country, searchable), also as a
  drop-down in the profile's Country field.
- **Esc closes the open chat**, like WhatsApp Web — not while a menu or dialog is open, or while typing.
- Opening a chat puts the cursor in the message box (not on phones).

---

## [0.9.0] - 2026-10-22 — Desktop notifications, forwarding, replies

Commits: `1bf80f6`, `1394344`, `f8529d7`, `1cd3ee2`.

### Added
- Desktop notifications for new customer messages, with the customer's name and a preview; clicking opens the chat.
- **Reply to a message** (quoted, also shown quoted to the customer on WhatsApp) and **Forward** to other chats.
- Emoji picker in the message box.
- "Follow-up after 24 hours" automation (removed again in 1.0.0).
- Company settings page; lifecycle stage counts in the left menu.

### Changed
- Customer messages no longer appear in the 🔔 bell; they come as desktop notifications, one per message.

### Fixed
- Notifications fire for every chat except the one on screen, even while the app has focus.
- WebSocket connections no longer fall back to polling (`/socket.io/` redirect).

### Database
- `Message.replyToId`; `Conversation.followUpSentAt`; `AutomationSettings` follow-up fields, `createdAt`, `createdBy`.

---

## [0.8.0] - 2026-10-21 — Simple automations, reactions, templates, Dubai time

Commits: `0753729`, `12855c1`, `27972fe`.

### Added
- **Simple automations**: auto-reply during and outside working hours (per-day hours, cooldown, variables like
  `{{contact.first_name}}`), and routing of new chats (specific teammate, round robin, or unassigned).
- **Message reactions** (customer and team).
- **Message templates** in Settings → Templates: create and edit with a live preview; send approved ones from the chat.
- Paste an image into the message box to send it.

### Changed
- Every date and time is shown in Dubai time (UTC+4), whatever the browser or server time zone.
- The chat follows new messages when you're at the bottom and offers a "new messages" button when you've scrolled up.

### Database
- New table `AutomationSettings`; `Conversation.lastAutoReplyAt`; `Message.customerReaction`, `teamReaction`,
  `teamReactionById`, `automation`.

---

## [0.7.0] - 2026-10-16 — Settings, contacts, voice notes, media

Commits: `eee2828`, `0cf49cc`.

### Added
- Settings: profile (phone, job title, avatar), company, workspace preferences, labels, lifecycle stages, contact
  properties (custom fields), lists, saved replies, deleted contacts, notifications.
- Contact profile panel in the chat and a contact details page with an activity log and media tab.
- Voice notes and sending images and documents.
- A "can't reach the server" screen with retry when the backend restarts, instead of logging people out.

### Fixed
- Layout shifts and pop-overs cut off at the edges.

### Deploy notes
- `npm run deploy` (`scripts/deploy.sh`): rolling reload of the client (2 instances) and restart of the server, waiting
  on each health check — no downtime during deploys.

---

## [0.6.0] - 2026-10-15 — Toasts, reminders, collaborators, filters, snooze, pins

Commits: `9be039b`, `42f364f`, `ad27eae`.

### Added
- App-wide toasts (new chat, assignment, reminders, collaborators, labels, pins).
- **Assignment reminders** every 5 minutes until a chat is handled, saved so restarts don't reset them.
- **Collaborators** on a chat and a Collaborations tab.
- Chat list filters (channel, labels, collaborator, date range), status menu with **snooze**, newest/oldest sort,
  **pin** and **mark as unread**.

### Fixed
- One broken message in a webhook delivery no longer drops the other messages in it.
- Unassigned chats keep reminding after someone only viewed them.

### Database
- `Conversation.assignedAt`, `reminderSentAt`, `snoozedUntil`; new tables `ConversationPin`, `ConversationCollaborator`.

---

## [0.5.0] - 2026-10-14 — Presence, assignment history, reports

Commit: `39008c7`.

### Added
- Online / away / offline status for teammates.
- Assignment history with an optional reason, and an assignment **report** (Reports page, CSV export).
- Search in a conversation, menu search, confirmation dialogs.

### Database
- New table `AssignmentRecord`; `Conversation.assigneeOpenedAt`.

---

## [0.4.0] - 2026-10-13 — New Leads, admin and permissions

Commits: `0a7c93a`, `88802bd`, `615df23`, `01096f0`.

### Added
- **New Leads** page; Teams page; admins manage roles, create users and edit them.
- My account page; password rules.

### Changed
- Audit fields on the main tables (`createdBy`, `updatedBy`, `deletedAt`, `deletedBy`, `status`) and table renames.

### Security
- `server/backups/` is no longer tracked in git (it held real emails and password hashes).
- The unsafe assignee migration script was removed; the safe one refuses to run when it would lose an assignment.

---

## [0.3.0] - 2026-10-12 — Roles, team, assignment, My Chats, quick replies

Commits: `9093930`, `b2b99d9`.

### Added
- **Roles**: owner/admin, supervisor, agent, enforced on GraphQL, REST and Socket.IO.
- Team management (invites, role changes, removal, join links); the Assign drop-down; **My Chats**.
- **Quick replies**: `/` in the message box; multi-line messages (Enter sends, Shift+Enter new line).
- Dubai time with date separators; login remembers the last workspace.

### Security
- WhatsApp webhook signature check; phone number validation; no customer data in webhook logs.

---

## [0.2.0] - 2026-10-10 — Chat, webhook, labels, assignment, notifications

Commits: `9bb7d83`, `865b66f`, `8e95202`, `7014a93`.

### Added
- Receiving WhatsApp messages (webhook) and replying from the chat.
- Sign up, log in, forgot / reset password.
- Labels, assignment, the 🔔 notification bell, activity timeline, typing indicator, close / reopen and clear chat.

### Fixed
- API port in the client proxy and the PM2 config (5000).

---

## [0.1.0] - 2026-10-09 — Project setup

Commits: `c161e6c`, `2ad5241`, `e44ebfa`.

### Added
- Next.js web client and Express + GraphQL + Prisma (MySQL) API server; workspaces, users, contacts and conversations.
