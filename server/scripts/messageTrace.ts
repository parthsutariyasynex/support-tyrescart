// Follow WhatsApp messages through the log files (read-only: the files are never changed). In the log folder
// (LOG_DIR, default logs/), both formats:
//   npm run logs:trace -- <messageId | wamid | wa:ref>   one message end to end: send, Meta's answer, each status
//   npm run logs:trace -- --audit [--days 7]               every message: sent, delivered, read, failed, unconfirmed;
//                                                          failures without a reason; customer data found in clear
// Printing follows LOG_CUSTOMER_DATA: tokens are always redacted; with it off, wamids and numbers are masked too.
import { env } from '../src/env.js';
import { audit, describeEntry, findTrace, logFiles, readLogs } from '../src/services/messageTrace.js';
import { redactText } from '../src/services/logging.js';

const args = process.argv.slice(2);
const daysArg = args.includes('--days') ? Number(args[args.indexOf('--days') + 1]) : undefined;
if (daysArg !== undefined && !(Number.isInteger(daysArg) && daysArg > 0)) {
  console.error('--days must be a whole number of days, 1 or more');
  process.exit(1);
}
const files = logFiles(env.logDir, daysArg);
if (!files.length) {
  console.error(`No log files in ${env.logDir}`);
  process.exit(1);
}

if (args.includes('--audit')) {
  const a = audit(files);
  console.log(`Files: ${a.files.join(', ')}`);
  console.log(`Lines: ${a.lines} (JSON ${a.byFormat.json}, older text ${a.byFormat.text}, unreadable ${a.unreadable})`);
  console.log(`Outgoing messages traced: ${a.messages}`);
  console.log(`  Send result:      ${JSON.stringify(a.bySend)}`);
  console.log(`  Delivery status:  ${JSON.stringify(a.byDeliveryStatus)}`);
  console.log(`  Customer received: confirmed ${a.confirmedReceived}, confirmed failed ${a.confirmedFailed}, not confirmed ${a.unconfirmed}`);
  console.log(`  Failed without a reason from Meta: ${a.failuresWithoutReason}`);
  console.log('Gaps (messages affected):');
  for (const [gap, n] of Object.entries(a.gaps).sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(4)}  ${gap}`);
  console.log('Customer data or secrets in clear (lines; expected for customer data when LOG_CUSTOMER_DATA is on, never for tokens):');
  console.log(`  raw wamid ${a.privacy.rawWamid}, phone numbers ${a.privacy.phoneNumbers}, bearer tokens ${a.privacy.bearerTokens}, message text ${a.privacy.messageContent}`);
} else {
  const id = args.find((a) => !a.startsWith('--') && a !== String(daysArg));
  if (!id) {
    console.error('Usage: npm run logs:trace -- <messageId | wamid | wa:ref>   or   npm run logs:trace -- --audit [--days N]');
    process.exit(1);
  }
  const trace = findTrace(readLogs(files).entries, id);
  if (!trace) {
    console.error(`No outgoing message ${redactText(id)} in ${files.length} log file(s)`);
    process.exit(1);
  }
  console.log(`Message ${trace.messageId ?? '(id not logged)'} · ${trace.waMessageRef ?? '(no WhatsApp reference)'} · chat ${trace.conversationId ?? '?'}`);
  console.log(`Send: ${trace.send} · delivery status: ${trace.deliveryStatus ?? 'none reported'} · customer received: ${trace.customerReceived === 1 ? 'yes (confirmed)' : trace.customerReceived === 0 ? 'no (confirmed)' : 'not confirmed'}`);
  for (const r of trace.failureReasons) console.log(`Why it failed: ${redactText(r)}`);
  for (const g of trace.gaps) console.log(`Gap: ${g}`);
  console.log('');
  for (const e of trace.entries) console.log(describeEntry(e));
}
