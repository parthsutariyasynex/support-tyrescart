import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type ContactProfile, type Payment, nextStage, filterSortFiles, activityCard, activityKind, groupByMonth, joinedText, timeAgo, applyView, orderKeys, propertyTypeLabel, propertyKey, customRows, withLabels, displayValue, fileLabel, splitFiles, filterPayments, filterRows, profileName, propertyRows } from './contacts';

const base: ContactProfile = {
  id: 'c1', waId: '971500000001', name: 'Satya WA', firstName: null, lastName: null, email: null, companyName: null, jobTitle: null,
  leadStage: null, leadSource: null, priority: null, country: null, phoneCountry: 'United Arab Emirates', subscribed: true, waBsuid: null, waUsername: null, lists: [], conversationId: null, createdAt: '', updatedAt: '',
};
const opts = { leadStages: [{ value: 'won', label: 'Won' }], leadSources: [{ value: 'walk_in', label: 'Walk-in' }], priorities: [{ value: 'high', label: 'High' }], remarkMaxLength: 2000 };

describe('contact profile helpers', () => {
  test('profile name: first/last name, else WhatsApp name, else number', () => {
    assert.equal(profileName({ ...base, firstName: 'Satya', lastName: 'Kumar' }), 'Satya Kumar');
    assert.equal(profileName(base), 'Satya WA');
    assert.equal(profileName({ ...base, name: null }), '+971500000001');
  });
  test('rows: order, first name falls back to the WhatsApp name, phone and owner read-only', () => {
    const rows = propertyRows(base, 'Parth', opts);
    assert.deepEqual(rows.map((r) => r.label), [
      'First name', 'Last name', 'Email', 'Phone number', 'Company name', 'Job title', 'Contact owner', 'Lead stage', 'Lead source', 'Priority',
      'Country', 'Subscriber', 'Last channel', 'Last contact from you', 'Last contact from customer', 'WhatsApp BSUID', 'WhatsApp username',
    ]);
    assert.deepEqual(rows.filter((r) => r.editable).map((r) => r.key), ['firstName', 'lastName', 'email', 'companyName', 'jobTitle', 'leadStage', 'leadSource', 'priority', 'country', 'subscribed']);
    assert.equal(rows[0].value, 'Satya WA');
    assert.equal(rows.find((r) => r.key === 'phone')!.editable, false);
    assert.equal(rows.find((r) => r.key === 'owner')!.value, 'Parth');
    assert.equal(rows.find((r) => r.key === 'owner')!.editable, false);
  });
  test('country from the phone until set; subscriber yes/no; chat details', () => {
    const rows = propertyRows(base, null, opts, { channel: 'WhatsApp · +971 4 000 0000', lastOutboundAt: null, lastInboundAt: '2026-10-14T07:05:00.000Z' });
    const v = (k: string) => displayValue(rows.find((r) => r.key === k)!);
    assert.equal(v('country'), '+971 United Arab Emirates');
    const country = (c: Partial<typeof base>) => propertyRows({ ...base, ...c }, null, opts).find((r) => r.key === 'country')!;
    assert.equal(displayValue(country({ country: 'Oman' })), '+968 Oman');
    // A searchable dropdown of every country (saved by name, shown with its calling code); "Not set" first to clear it
    assert.equal(country({}).kind, 'select');
    assert.equal(country({}).searchable, true);
    assert.deepEqual(country({}).options![0], { value: '', label: '– Not set' });
    assert.ok(country({}).options!.some((o) => o.value === 'United Arab Emirates' && o.label === '+971 United Arab Emirates'));
    assert.ok(country({}).options!.length > 200);
    // A country typed in before the dropdown (not in the list) still shows as it was saved
    assert.equal(displayValue(country({ country: 'Somewhere' })), 'Somewhere');
    assert.equal(v('subscribed'), 'Yes');
    assert.equal(displayValue(propertyRows({ ...base, subscribed: false }, null, opts).find((r) => r.key === 'subscribed')!), 'No');
    assert.equal(v('channel'), 'WhatsApp · +971 4 000 0000');
    assert.equal(v('lastFromYou'), '–');
    assert.match(v('lastFromCustomer'), /11:05/); // shown in Dubai time (07:05 UTC)
    assert.equal(v('waBsuid'), '–');
  });
  test('display: option labels, dash when empty', () => {
    const rows = propertyRows({ ...base, leadStage: 'won', leadSource: 'walk_in' }, null, opts);
    assert.equal(displayValue(rows.find((r) => r.key === 'leadStage')!), 'Won');
    assert.equal(displayValue(rows.find((r) => r.key === 'leadSource')!), 'Walk-in');
    assert.equal(displayValue(rows.find((r) => r.key === 'priority')!), '–');
    assert.equal(displayValue(rows.find((r) => r.key === 'owner')!), '–');
  });
  test('payments: status filter, search, newest first', () => {
    const p = (id: string, status: string, amount: number, at: string, description: string | null = null): Payment => ({ id, status, amount, currency: 'aed', description, createdAt: at });
    const list = [p('pi_1', 'succeeded', 12000, '2026-10-01', 'Michelin x4'), p('pi_2', 'failed', 5000, '2026-10-03'), p('pi_3', 'succeeded', 800, '2026-10-02')];
    assert.deepEqual(filterPayments(list, 'all', '').map((x) => x.id), ['pi_2', 'pi_3', 'pi_1']);
    assert.deepEqual(filterPayments(list, 'succeeded', '').map((x) => x.id), ['pi_3', 'pi_1']);
    assert.deepEqual(filterPayments(list, 'all', 'michelin').map((x) => x.id), ['pi_1']);
    assert.deepEqual(filterPayments(list, 'all', '120.00').map((x) => x.id), ['pi_1']);
    assert.deepEqual(filterPayments(list, 'refunded', ''), []);
    assert.deepEqual(filterPayments([], 'all', 'x'), []);
  });
  test('attachments split into media and documents', () => {
    const f = (id: string, type: string) => ({ id, type });
    const { media, documents } = splitFiles([f('1', 'image'), f('2', 'document'), f('3', 'voice'), f('4', 'video'), f('5', 'document')]);
    assert.deepEqual(media.map((x) => x.id), ['1', '3', '4']);
    assert.deepEqual(documents.map((x) => x.id), ['2', '5']);
  });
  test('property view: default shows all; personal reorders and hides; new keys still appear', () => {
    const rows = [{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }];
    const none = { defaultOrder: [], defaultHidden: [] };
    // Default view with no workspace layout: everything, standard order (your personal settings are ignored)
    assert.deepEqual(applyView(rows, { personal: false, order: ['d'], hidden: ['a'], ...none }).map((r) => r.key), ['a', 'b', 'c', 'd']);
    // The workspace's default view (set by admins)
    assert.deepEqual(applyView(rows, { personal: false, order: [], hidden: [], defaultOrder: ['d', 'b'], defaultHidden: ['c'] }).map((r) => r.key), ['d', 'b', 'a']);
    assert.deepEqual(applyView(rows, { personal: true, order: ['c', 'a'], hidden: ['b'], defaultOrder: ['d'], defaultHidden: ['c'] }).map((r) => r.key), ['c', 'a', 'd']);
    assert.equal(propertyTypeLabel({ key: 'subscribed', kind: 'select' }), 'Boolean');
    assert.equal(propertyTypeLabel({ key: 'firstName', kind: 'text' }), 'SingleLineText');
    assert.equal(propertyTypeLabel({ key: 'phone', kind: 'text' }), 'PhoneNumber');
    assert.equal(propertyTypeLabel({ key: 'leadStage', kind: 'select' }), 'Options');
    assert.equal(propertyTypeLabel({ key: 'email', kind: 'email' }), 'Email');
    assert.equal(propertyTypeLabel({ key: 'lastFromYou', kind: 'text' }), 'DateTime');
    assert.deepEqual(orderKeys(['a', 'b', 'c'], ['c', 'zzz', 'a']), ['c', 'a', 'b']); // unknown dropped, missing appended
  });
  test('contact page: activity kinds, months, time ago, joined', () => {
    assert.equal(activityKind({ type: 'assigned', actorId: 'u1' }), 'user');
    assert.equal(activityKind({ type: 'conversation_reopened', actorId: null }), 'system');
    assert.equal(activityKind({ type: 'message_received', actorId: null }), 'customer');
    const g = groupByMonth([{ createdAt: '2026-09-30T21:00:00.000Z' }, { createdAt: '2026-10-15T10:00:00.000Z' }, { createdAt: '2026-10-01T10:00:00.000Z' }]);
    assert.deepEqual(g.map((x) => [x.month, x.items.length]), [['October 2026', 3]]); // 30 Sep 21:00 UTC is 1 Oct in Dubai
    const now = Date.parse('2026-10-16T10:00:00.000Z');
    assert.equal(timeAgo('2026-10-16T09:59:30.000Z', now), 'just now');
    assert.equal(timeAgo('2026-10-14T10:00:00.000Z', now), '2 days ago');
    assert.equal(timeAgo('2026-10-16T09:00:00.000Z', now), '1 hour ago');
    assert.equal(joinedText('2026-10-14T10:00:00.000Z'), 'Joined Oct 2026');
  });
  test('activity cards: title with who, detail lines', () => {
    const a = (type: string, data: object | null, actorName: string | null = 'Satya Kumar') => activityCard({ type, actorName, contactName: 'Riya', data: data && JSON.stringify(data) });
    assert.deepEqual(a('conversation_closed', null), { title: 'Conversation status changed by Satya Kumar', lines: ['Conversation status: [Open] to [Closed]'] });
    assert.deepEqual(a('conversation_reopened', null).lines, ['Conversation status: [Closed] to [Open]']);
    assert.deepEqual(a('conversation_reopened', { reason: 'snooze_ended' }, null), { title: 'Conversation status changed', lines: ['Conversation status: [Snoozed] to [Open] (snooze ended)'] });
    assert.deepEqual(a('reassigned', { previous: 'Asha', assignee: 'Nikhil' }).lines, ['Assignee: [Asha] to [Nikhil]']);
    assert.deepEqual(a('contact_updated', { changes: [{ label: 'Lead stage', from: null, to: 'Won' }] }), { title: 'Fields changed by Satya Kumar', lines: ['Profile information updated:', 'Lead stage: [–] to [Won]'] });
    assert.deepEqual(a('remark_added', { text: 'hello' }), { title: 'Manual log by Satya Kumar', lines: ['hello'] });
    assert.deepEqual(a('message_received', { preview: 'hi' }, null), { title: 'Message from Riya', lines: ['hi'] });
    assert.equal(a('something_new', null).title, 'Conversation updated by Satya Kumar');
    assert.deepEqual(a('message_sent', { preview: 'In stock', status: 'sent' }), { title: 'Message sent by Satya Kumar', lines: ['In stock'] });
    assert.deepEqual(a('message_sent', { preview: 'Hi', status: 'failed' }).lines, ['Hi', 'Not delivered']);
    assert.deepEqual(a('list_added', { list: 'VIP' }), { title: 'Added to list by Satya Kumar', lines: ['List: [VIP]'] });
    assert.deepEqual(a('list_removed', { list: 'VIP', reason: 'list_deleted' }).lines, ['List: [VIP] (the list was deleted)']);
  });
  test('media: filter by type (audio includes voice), latest or oldest first', () => {
    const f = (id: string, type: string, createdAt: string) => ({ id, type, createdAt });
    const files = [f('1', 'image', '2026-10-01'), f('2', 'voice', '2026-10-03'), f('3', 'audio', '2026-10-02'), f('4', 'document', '2026-10-04'), f('5', 'sticker', '2026-09-30')];
    assert.deepEqual(filterSortFiles(files, 'all', 'latest').map((x) => x.id), ['4', '2', '3', '1', '5']);
    assert.deepEqual(filterSortFiles(files, 'all', 'oldest').map((x) => x.id), ['5', '1', '3', '2', '4']);
    assert.deepEqual(filterSortFiles(files, 'image', 'latest').map((x) => x.id), ['1', '5']); // stickers count as images
    assert.deepEqual(filterSortFiles(files, 'audio', 'latest').map((x) => x.id), ['2', '3']);
    assert.deepEqual(filterSortFiles(files, 'video', 'latest'), []);
  });
  test('next lead stage', () => {
    const st = [
      { value: 'new', closed: false },
      { value: 'contacted', closed: false },
      { value: 'proposal', closed: false },
      { value: 'won', closed: false },
      { value: 'lost', closed: true },
      { value: 'no_reply', closed: true },
    ];
    assert.equal(nextStage(st, null)?.value, 'new');
    assert.equal(nextStage(st, 'new')?.value, 'contacted');
    assert.equal(nextStage(st, 'proposal')?.value, 'won');
    assert.equal(nextStage(st, 'won'), null); // last progressing stage: never on to a Lost one
    assert.equal(nextStage(st, 'lost'), null);
    assert.equal(nextStage(st, 'no_reply'), null);
    assert.equal(nextStage(st, 'gone')?.value, 'new');
    assert.equal(nextStage([], 'new'), null);
  });
  test('file labels', () => {
    assert.deepEqual(['image', 'voice', 'document', 'location'].map(fileLabel), ['Photo', 'Voice message', 'Document', 'File']);
  });
  test('search: by field name or value', () => {
    const rows = propertyRows({ ...base, companyName: 'TyresCart LLC', priority: 'high' }, null, opts);
    assert.deepEqual(filterRows(rows, 'tyres').map((r) => r.key), ['companyName']);
    assert.deepEqual(filterRows(rows, 'lead').map((r) => r.key), ['leadStage', 'leadSource']);
    assert.deepEqual(filterRows(rows, 'HIGH').map((r) => r.key), ['priority']);
    assert.equal(filterRows(rows, '  ').length, rows.length);
  });
});

test('custom properties: key from the name, rows by type, renamed standard properties', () => {
  assert.equal(propertyKey('Tyre size (inches)'), 'tyre_size_inches');
  assert.equal(propertyKey('Café'), 'cafe');
  const props = [
    { id: 'p1', name: 'Tyre size', key: 'tyre_size', type: 'number', options: [], createdAt: '' },
    { id: 'p2', name: 'Brand', key: 'brand', type: 'options', options: ['Michelin', 'Pirelli'], createdAt: '' },
    { id: 'p3', name: 'Fleet', key: 'fleet', type: 'boolean', options: [], createdAt: '' },
    { id: 'p4', name: 'Next service', key: 'next_service', type: 'date', options: [], createdAt: '' },
    { id: 'p5', name: 'Booked at', key: 'booked_at', type: 'datetime', options: [], createdAt: '' },
    { id: 'p6', name: 'Notes', key: 'notes', type: 'multiline', options: [], createdAt: '' },
  ];
  const rows = customRows({ customValues: [{ propertyId: 'p2', value: 'Pirelli' }, { propertyId: 'p3', value: 'true' }, { propertyId: 'p5', value: '2026-10-16T14:30' }] }, props);
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.inputType ?? null, displayValue(r)]), [
    ['custom:tyre_size', 'text', 'number', '–'],
    ['custom:brand', 'select', null, 'Pirelli'],
    ['custom:fleet', 'select', null, 'Yes'],
    ['custom:next_service', 'text', 'date', '–'],
    ['custom:booked_at', 'text', 'datetime-local', '2026-10-16 14:30'],
    ['custom:notes', 'text', 'multiline', '–'],
  ]);
  const types = [{ value: 'number', label: 'Number' }];
  assert.equal(propertyTypeLabel(rows[0], types), 'Number');
  assert.equal(propertyTypeLabel(rows[3], types), 'date'); // unknown to the list: the raw type
  const std = propertyRows(base, null, null);
  const renamed = withLabels(std, [{ key: 'companyName', name: 'Garage name' }]);
  const company = renamed.find((r) => r.key === 'companyName')!;
  assert.deepEqual([company.label, company.originalLabel], ['Garage name', 'Company name']);
  assert.equal(withLabels(std, []), std);
});
