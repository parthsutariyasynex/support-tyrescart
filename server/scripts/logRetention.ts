// Backend log retention by hand (database entries and daily log files). A dry run unless --delete is given:
//   npm run logs:retention                          count entries older than LOG_RETENTION_DAYS (default 90)
//   npm run logs:retention -- --days 30             count entries older than 30 days
//   npm run logs:retention -- --days 30 --delete    delete them
import { env } from '../src/env.js';
import { prisma } from '../src/prisma.js';
import { describeFiles, describeResult, pruneLogFiles, pruneLogs, retentionPolicy } from '../src/services/logRetention.js';

const args = process.argv.slice(2);
const daysArg = args.includes('--days') ? args[args.indexOf('--days') + 1] : undefined;
const policy = retentionPolicy(daysArg ?? env.logRetentionDays, 'dry-run');
if (daysArg !== undefined && policy.problems.length) {
  console.error(`--days must be a whole number of days, 1 or more (got "${daysArg ?? ''}")`);
  process.exit(1);
}
for (const p of policy.problems) console.warn(p);

try {
  const dryRun = !args.includes('--delete');
  console.log(describeResult(await pruneLogs({ days: policy.days, dryRun })));
  const files = await pruneLogFiles({ days: policy.days, dryRun });
  console.log(describeFiles(files));
  for (const name of files.files) console.log(`  ${name}`);
} finally {
  await prisma.$disconnect();
}
