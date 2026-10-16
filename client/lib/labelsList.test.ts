import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colorName, filterLabels, pageOf, usedColors } from './labels';

const labels = [
  { name: 'VIP', color: '#34b7f1' },
  { name: 'paid', color: '#5e5ce6' },
  { name: 'Issue', color: '#FF3B30' },
  { name: 'New order', color: '#ffcc00' },
  { name: 'Order 10', color: '#ffcc00' },
  { name: 'Order 9', color: '#123abc' },
];

test('labels list: search, colour filter, sort by name', () => {
  assert.deepEqual(filterLabels(labels, '', '', 'asc').map((l) => l.name), ['Issue', 'New order', 'Order 9', 'Order 10', 'paid', 'VIP']);
  assert.deepEqual(filterLabels(labels, '', '', 'desc').map((l) => l.name), ['VIP', 'paid', 'Order 10', 'Order 9', 'New order', 'Issue']);
  assert.deepEqual(filterLabels(labels, 'ORDER', '', 'asc').map((l) => l.name), ['New order', 'Order 9', 'Order 10']);
  assert.deepEqual(filterLabels(labels, '', '#ffcc00', 'asc').map((l) => l.name), ['New order', 'Order 10']);
  assert.deepEqual(filterLabels(labels, '', '#ff3b30', 'asc').map((l) => l.name), ['Issue']);
});

test('labels list: pages, colours in use and their names', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(pageOf(items, 3, 20), { items: [40, 41, 42, 43, 44], page: 3, pages: 3 });
  assert.equal(pageOf(items, 9, 20).page, 3);
  assert.deepEqual(pageOf([], 1, 20), { items: [], page: 1, pages: 1 });
  assert.deepEqual(usedColors(labels), ['#34b7f1', '#5e5ce6', '#ff3b30', '#ffcc00', '#123abc']);
  assert.equal(colorName('#FF3B30'), 'Red');
  assert.equal(colorName('#123ABC'), 'Custom (#123abc)');
});
