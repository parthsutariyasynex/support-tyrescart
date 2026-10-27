// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EMPTY_MENU_FILTERS, GULF_COUNTRIES, activeFilterCount, callingCodesOf, countryFilterList, dayEnd, dayStart, matchesCountryQuery, matchesMenuFilters, toServerFilter, toggle } from './chatFilters';

// Device time zones the result must not depend on (UTC, India, US west coast, UTC+14)
function inEveryMachineZone(check: () => void) {
  const original = process.env.TZ;
  try {
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      check();
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('chat list "Filter by" menu', () => {
  const chat = {
    labels: [{ id: 'l-vip', name: 'VIP', color: '#000' }],
    assignee: { id: 'm-ana', name: 'Ana', color: '#000', userId: 'u-ana' },
    lastMessageAt: '2026-10-10T08:00:00.000Z', // 12:00 on 10 Oct in Dubai
    contact: { id: 'c-1', waId: '971500000001', name: 'Sam', leadStage: 'new' },
  };
  const f = (over: Partial<typeof EMPTY_MENU_FILTERS>) => ({ ...EMPTY_MENU_FILTERS, ...over });

  test('nothing selected matches everything and counts zero', () => {
    assert.equal(matchesMenuFilters(chat, EMPTY_MENU_FILTERS), true);
    assert.equal(activeFilterCount(EMPTY_MENU_FILTERS), 0);
    assert.deepEqual(toServerFilter(EMPTY_MENU_FILTERS), { labelIds: null, assigneeIds: null, from: null, to: null, leadStages: null, countries: null });
  });
  test('labels: any of the chosen', () => {
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-vip'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-other', 'l-vip'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-other'] })), false);
  });
  test('collaborator: any of the chosen assignees, or unassigned', () => {
    assert.equal(matchesMenuFilters(chat, f({ assigneeIds: ['m-ana'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ assigneeIds: ['m-ben'] })), false);
    assert.equal(matchesMenuFilters({ ...chat, assignee: null }, f({ assigneeIds: ['unassigned'] })), true);
    assert.equal(matchesMenuFilters({ ...chat, assignee: null }, f({ assigneeIds: ['m-ana'] })), false);
  });
  test('a day in the filter is a whole Dubai day, whatever the device time zone', () => {
    inEveryMachineZone(() => {
      assert.equal(dayStart('2026-10-21'), '2026-10-20T20:00:00.000Z');
      assert.equal(dayEnd('2026-10-21'), '2026-10-21T19:59:59.999Z');
      assert.deepEqual(toServerFilter(f({ from: '2026-10-01', to: '2026-10-02' })), { labelIds: null, assigneeIds: null, from: '2026-09-30T20:00:00.000Z', to: '2026-10-02T19:59:59.999Z', leadStages: null, countries: null });
      // 00:30 on 11 Oct in Dubai (still the 10th in UTC, and already 02:00 on the 11th in India)
      const late = { ...chat, lastMessageAt: '2026-10-10T20:30:00.000Z' };
      assert.equal(matchesMenuFilters(late, f({ from: '2026-10-11', to: '2026-10-11' })), true);
      assert.equal(matchesMenuFilters(late, f({ from: '2026-10-10', to: '2026-10-10' })), false);
      // 23:45 on 10 Oct in Dubai (already 00:15 on the 11th in India): still the 10th
      const evening = { ...chat, lastMessageAt: '2026-10-10T19:45:00.000Z' };
      assert.equal(matchesMenuFilters(evening, f({ from: '2026-10-10', to: '2026-10-10' })), true);
    });
  });
  test('date range on last activity, whole Dubai days, open ends', () => {
    assert.equal(matchesMenuFilters(chat, f({ from: '2026-10-10', to: '2026-10-10' })), true);
    assert.equal(matchesMenuFilters(chat, f({ from: '2026-10-11' })), false);
    assert.equal(matchesMenuFilters(chat, f({ to: '2026-10-09' })), false);
    assert.equal(matchesMenuFilters(chat, f({ from: '2026-10-01' })), true);
  });
  test('stage: any of the chosen lifecycle stages; a customer without a stage never matches', () => {
    assert.equal(matchesMenuFilters(chat, f({ leadStages: ['new'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ leadStages: ['won', 'new'] })), true);
    assert.equal(matchesMenuFilters(chat, f({ leadStages: ['won'] })), false);
    assert.equal(matchesMenuFilters({ ...chat, contact: { ...chat.contact, leadStage: null } }, f({ leadStages: ['new'] })), false);
    assert.equal(activeFilterCount(f({ leadStages: ['new', 'won'] })), 1);
    assert.deepEqual(toServerFilter(f({ leadStages: ['new'] })).leadStages, ['new']);
  });
  test('groups combine with AND; count is per group; toggle adds and removes', () => {
    assert.equal(matchesMenuFilters(chat, f({ labelIds: ['l-vip'], assigneeIds: ['m-ben'] })), false);
    assert.equal(activeFilterCount(f({ labelIds: ['a', 'b'], assigneeIds: ['c'], from: '2026-10-01' })), 3);
    assert.deepEqual(toggle(['a'], 'b'), ['a', 'b']);
    assert.deepEqual(toggle(['a', 'b'], 'a'), ['b']);
  });
});

describe('Filter by → Country code', () => {
  test('Gulf countries first (UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman), then every other country A–Z', () => {
    const { gulf, others } = countryFilterList();
    assert.deepEqual(gulf.map((c) => c.code), ['AE', 'SA', 'QA', 'KW', 'BH', 'OM']);
    assert.deepEqual(gulf.map((c) => c.dial), ['971', '966', '974', '965', '973', '968']);
    assert.ok(others.length > 200);
    assert.ok(!others.some((c) => (GULF_COUNTRIES as readonly string[]).includes(c.code)), 'not listed twice');
    const names = others.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
    assert.ok(others.some((c) => c.code === 'IN' && c.dial === '91' && c.flag === '🇮🇳'));
  });

  test('search by name, ISO code or calling code', () => {
    const { gulf, others } = countryFilterList();
    const all = [...gulf, ...others];
    const find = (q: string) => all.filter((c) => matchesCountryQuery(c, q)).map((c) => c.code);
    assert.deepEqual(find('saudi'), ['SA']);
    assert.ok(find('ae').includes('AE'));
    assert.deepEqual(find('+971'), ['AE']);
    assert.deepEqual(find('9665'), []); // a code plus more digits isn't a country code
    assert.ok(find('97').includes('AE') && find('97').includes('QA'));
    assert.equal(find('  ').length, all.length);
  });

  test("a chat matches when the customer's number starts with a chosen country's code", () => {
    const chat = (waId: string) => ({ labels: [], assignee: null, lastMessageAt: '2026-10-01T10:00:00.000Z', contact: { waId, leadStage: null } }) as any;
    const f = { ...EMPTY_MENU_FILTERS, countries: ['AE', 'SA'] };
    assert.equal(matchesMenuFilters(chat('971501234567'), f), true);
    assert.equal(matchesMenuFilters(chat('966501234567'), f), true);
    assert.equal(matchesMenuFilters(chat('919274834118'), f), false);
    assert.equal(matchesMenuFilters(chat('919274834118'), EMPTY_MENU_FILTERS), true);
    assert.equal(activeFilterCount(f), 1);
    assert.deepEqual(toServerFilter(f).countries, ['AE', 'SA']);
    assert.deepEqual(callingCodesOf(['US', 'CA', 'XX']), ['1']); // shared code once; unknown ignored
  });
});
