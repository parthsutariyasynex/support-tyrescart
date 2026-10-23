import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Template, EMPTY_SPEC, NO_NAME, chatTemplates, autoFillValues, readableMessage, cleanSpec, customerNames, fillPieces, missingValues, nameFor, nextVariable, specOf, templateName, variablesOf } from './templates';

const order: Template = {
  id: 't1', name: 'order_ready', language: 'en', category: 'UTILITY', status: 'APPROVED', rejectedReason: null, parameterFormat: 'POSITIONAL',
  header: { format: 'IMAGE', text: '', variables: [] },
  body: 'Hi {{1}}, your order {{2}} is ready.', bodyVariables: ['1', '2'], footer: 'TyresCart',
  buttons: [{ type: 'URL', text: 'Track', url: 'https://tyrescart.ae/o/{{1}}', variables: ['1'] }, { type: 'QUICK_REPLY', text: 'Thanks', variables: [] }],
  needsParameters: true, sendable: true, unsupportedReason: null,
};

test('preview pieces and what is still missing', () => {
  assert.deepEqual(fillPieces('Hi {{1}}, order {{2}}', { '1': 'Amir' }), [
    { text: 'Hi ' }, { text: 'Amir', variable: '1', filled: true }, { text: ', order ' }, { text: '{{2}}', variable: '2', filled: false },
  ]);
  const empty = { header: {}, body: {}, buttons: {} };
  assert.deepEqual(missingValues(order, empty), ['header image', '{{1}}', '{{2}}', 'link for “Track”']);
  const file = new File(['x'], 'tyre.jpg', { type: 'image/jpeg' });
  assert.deepEqual(missingValues(order, { header: {}, body: { '1': 'Amir', '2': 'TC-1' }, buttons: { '0': 'TC-1' } }, file), []);
});

test('editor helpers: names, next variable, existing templates, what is sent', () => {
  assert.equal(templateName('Order Ready! 2'), 'order_ready_2');
  assert.equal(nextVariable('Hi {{1}} and {{2}}'), '{{3}}');
  assert.equal(nextVariable(''), '{{1}}');
  assert.deepEqual(variablesOf('{{1}} {{name}} {{1}}'), ['1', 'name']);
  const spec = specOf(order);
  assert.deepEqual([spec.name, spec.header?.format, spec.bodyExamples.length, spec.buttons.map((b) => b.type)], ['order_ready', 'IMAGE', 2, ['URL', 'QUICK_REPLY']]);
  assert.deepEqual(Object.keys(cleanSpec({ ...EMPTY_SPEC, category: 'AUTHENTICATION', name: 'otp', codeExpirationMinutes: 10 })).sort(), ['category', 'codeExpirationMinutes', 'language', 'name', 'securityRecommendation']);
  assert.equal(cleanSpec({ ...EMPTY_SPEC, name: 'x', body: 'Hi {{1}}', bodyExamples: ['a', 'stale'], footer: '  ' }).footer, null);
  assert.deepEqual(cleanSpec({ ...EMPTY_SPEC, name: 'x', body: 'Hi {{1}}', bodyExamples: ['a', 'stale'] }).bodyExamples, ['a']);
});

test('template names: saved first/last name, else the WhatsApp name; unknown stays empty (never guessed)', () => {
  assert.deepEqual(customerNames({ firstName: 'Alice', lastName: 'Patel', name: 'Ali P' }), { first: 'Alice', last: 'Patel' });
  assert.deepEqual(customerNames({ name: '  Alice   Mary Patel ' }), { first: 'Alice', last: 'Mary Patel' });
  assert.deepEqual(customerNames({ firstName: ' ', lastName: null, name: 'Alice Patel' }), { first: 'Alice', last: 'Patel' });
  assert.deepEqual(customerNames({ name: 'Alice' }), { first: 'Alice', last: '' });
  assert.deepEqual(customerNames({ name: null }), { first: '', last: '' });
});

test('template variables: {{1}} first name, {{2}} last name (named: first_name / last_name); others by hand', () => {
  assert.equal(nameFor('1'), 'first');
  assert.equal(nameFor('2'), 'last');
  assert.equal(nameFor('first_name'), 'first');
  assert.equal(nameFor('LastName'), 'last');
  assert.equal(nameFor('3'), null);
  assert.equal(nameFor('order_id'), null);
  const t = { bodyVariables: ['1', '2', '3'] };
  assert.deepEqual(autoFillValues(t, { first: 'Alice', last: 'Patel' }), { header: {}, body: { 1: 'Alice', 2: 'Patel' }, buttons: {} });
  // a missing last name gets the invisible no-name value (nothing made up); {{3}} is still for the agent
  const partial = autoFillValues(t, { first: 'Alice', last: '' });
  assert.deepEqual(partial.body, { 1: 'Alice', 2: NO_NAME });
  assert.deepEqual(missingValues({ header: null, bodyVariables: ['1', '2', '3'], buttons: [] } as unknown as Template, partial), ['{{3}}']);
});

test('the message as the agent reads it: names filled in; no name → left out, never {{1}} or a made-up name', () => {
  const body = 'Hello {{1}} 👋, I just wanted to follow up regarding your earlier inquiry.';
  assert.equal(readableMessage(body, { 1: 'Parth patel' }), 'Hello Parth patel 👋, I just wanted to follow up regarding your earlier inquiry.');
  assert.equal(readableMessage(body, {}), 'Hello 👋, I just wanted to follow up regarding your earlier inquiry.');
  assert.equal(readableMessage('Hi {{1}}, thanks!', {}), 'Hi, thanks!');
  assert.equal(readableMessage('Dear {{1}} {{2}},\nYour tyres are ready.', { 1: 'Alice' }), 'Dear Alice,\nYour tyres are ready.');
  assert.ok(!readableMessage(body, {}).includes('{{'));
});

test('a customer without a name: the template still goes, with an invisible value instead of a name', () => {
  const t = { bodyVariables: ['1'] };
  const none = autoFillValues(t, customerNames({ name: null })); // number only
  assert.deepEqual(none.body, { 1: NO_NAME });
  assert.equal(missingValues({ header: null, bodyVariables: ['1'], buttons: [] } as unknown as Template, none).length, 0); // nothing blocks sending
  assert.equal(readableMessage('Hello {{1}} 👋, I just wanted to follow up regarding your earlier inquiry.', none.body), 'Hello 👋, I just wanted to follow up regarding your earlier inquiry.');
  assert.deepEqual(autoFillValues(t, customerNames({ name: 'Parth patel' })).body, { 1: 'Parth' });
  assert.deepEqual(autoFillValues({ bodyVariables: ['1', '2', '3'] }, { first: 'Zara', last: '' }).body, { 1: 'Zara', 2: NO_NAME });
  assert.equal(NO_NAME.trim(), NO_NAME, 'not removed by trim(): WhatsApp gets a value, never an empty one');
});

test("the chat's template list: approved templates only, never Meta's hello_world sample", () => {
  const list = ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL'].map((status) => ({ name: `t_${status.toLowerCase()}`, status }));
  assert.deepEqual(chatTemplates([...list, { name: 'hello_world', status: 'APPROVED' }, { name: 'follow_up_inquiry', status: 'APPROVED' }]).map((t) => t.name), ['t_approved', 'follow_up_inquiry']);
});
