import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Template, EMPTY_SPEC, cleanSpec, fillPieces, missingValues, nextVariable, specOf, templateName, variablesOf } from './templates';

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
