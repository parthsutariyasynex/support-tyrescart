// Pure helpers of the assignment report (no database). Run: npm run test:e2e (picks up test/*.test.ts)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CSV_COLUMNS, REASON_MAX_LENGTH, assignmentReportCsv, csvCell, normalizeReason } from '../src/services/assignmentReports.js';

describe('assignment reason: normalisation', () => {
  test('trims; empty or missing means no reason; keeps inner newlines', () => {
    assert.equal(normalizeReason(undefined), null);
    assert.equal(normalizeReason(null), null);
    assert.equal(normalizeReason(''), null);
    assert.equal(normalizeReason('   \n '), null);
    assert.equal(normalizeReason('  Customer asked for Arabic support \n'), 'Customer asked for Arabic support');
    assert.equal(normalizeReason('line 1\nline 2'), 'line 1\nline 2');
  });

  test('refuses more than the maximum and anything that is not text', () => {
    assert.equal(normalizeReason('x'.repeat(REASON_MAX_LENGTH)), 'x'.repeat(REASON_MAX_LENGTH));
    assert.throws(() => normalizeReason('x'.repeat(REASON_MAX_LENGTH + 1)), /too long/);
    assert.throws(() => normalizeReason(123), /must be text/);
    assert.throws(() => normalizeReason({ text: 'x' }), /must be text/);
  });
});

describe('assignment report CSV', () => {
  test('cells: quotes commas, quotes and newlines; neutralises spreadsheet formulas', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell(null), '');
    assert.equal(csvCell('a, b'), '"a, b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('two\nlines'), '"two\nlines"');
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell('+1 234'), "'+1 234");
    assert.equal(csvCell('-x'), "'-x");
    assert.equal(csvCell('@cmd'), "'@cmd");
  });

  test('one header line and one line per record, CRLF, with a UTF-8 BOM; unassigned and system shown by name', () => {
    const at = new Date('2026-10-14T07:30:00.000Z');
    const csv = assignmentReportCsv([
      {
        id: 'r1',
        conversationId: 'conv-1',
        contactName: 'Riya, Dubai',
        contactWaId: '971500000001',
        previousAssignee: null,
        newAssignee: { memberId: 'm1', userId: 'u1', name: 'Asha' },
        assignedBy: { userId: 'u2', name: 'Sam' },
        reason: 'Speaks Hindi; "VIP"',
        createdAt: at,
      },
      {
        id: 'r2',
        conversationId: 'conv-1',
        contactName: null,
        contactWaId: '971500000001',
        previousAssignee: { memberId: 'm1', userId: 'u1', name: 'Asha' },
        newAssignee: null,
        assignedBy: null,
        reason: null,
        createdAt: at,
      },
    ]);
    assert.ok(csv.startsWith('﻿'));
    const lines = csv.slice(1).split('\r\n');
    assert.deepEqual(lines, [
      CSV_COLUMNS.join(','),
      `2026-10-14T11:30:00+04:00,conv-1,"Riya, Dubai",971500000001,Unassigned,Asha,Sam,"Speaks Hindi; ""VIP"""`,
      '2026-10-14T11:30:00+04:00,conv-1,,971500000001,Asha,Unassigned,System,',
      '',
    ]);
  });
});
