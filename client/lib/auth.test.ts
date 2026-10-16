import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { joinName, splitName } from './auth';

describe('names in My profile', () => {
  test('first word is the first name, the rest the last name; joined back', () => {
    assert.deepEqual(splitName('Satya Kumar Rao'), { first: 'Satya', last: 'Kumar Rao' });
    assert.deepEqual(splitName('  Parth  '), { first: 'Parth', last: '' });
    assert.deepEqual(splitName(''), { first: '', last: '' });
    assert.equal(joinName(' Satya ', ' Kumar '), 'Satya Kumar');
    assert.equal(joinName('Parth', ''), 'Parth');
  });
});
