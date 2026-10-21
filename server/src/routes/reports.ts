import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { AppError } from '../services/errors.js';
import { assignmentReportCsv, listAssignmentReport } from '../services/assignmentReports.js';
import { dubaiDay } from '../time.js';

// Reports export. Owners and admins only (checked in the service), signed-in with the usual Bearer token.
export const reportsRouter = Router();
reportsRouter.use(requireAuth);

function dateParam(value: unknown, name: string) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new AppError(`Invalid ${name} date`, 400, 'BAD_USER_INPUT');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError(`Invalid ${name} date`, 400, 'BAD_USER_INPUT');
  return d;
}

// GET /reports/assignments.csv?from=<ISO>&to=<ISO>&conversationId=<id>
reportsRouter.get('/assignments.csv', async (req, res) => {
  const rows = await listAssignmentReport(req.auth!, {
    from: dateParam(req.query.from, 'from'),
    to: dateParam(req.query.to, 'to'),
    conversationId: typeof req.query.conversationId === 'string' && req.query.conversationId ? req.query.conversationId : null,
  });
  const day = dubaiDay(new Date()); // today in Dubai
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="assignment-report-${day}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(assignmentReportCsv(rows));
});
