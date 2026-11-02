import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberCountry } from './countryFlag';

test('numberCountry: the flag of a WhatsApp number, by its own country', () => {
  assert.deepEqual(numberCountry('971552647373'), { code: 'AE', flag: '🇦🇪', name: 'United Arab Emirates' });
  assert.equal(numberCountry('+96555746764')?.code, 'KW');
  assert.equal(numberCountry('919274834118')?.flag, '🇮🇳');
  // Shared calling codes resolve by the number
  assert.equal(numberCountry('12025550123')?.code, 'US');
  assert.equal(numberCountry('14165550123')?.code, 'CA');
  assert.equal(numberCountry('77012345678')?.code, 'KZ');
  assert.equal(numberCountry('74951234567')?.code, 'RU');
  assert.equal(numberCountry('447400123456')?.code, 'GB');
  assert.equal(numberCountry('447781123456')?.code, 'GG');
});

test('numberCountry: no flag for invalid or non-country numbers', () => {
  assert.equal(numberCountry(''), null);
  assert.equal(numberCountry(null), null);
  assert.equal(numberCountry('0'), null);
  assert.equal(numberCountry('97155'), null);
  assert.equal(numberCountry('80012345678'), null);
});
