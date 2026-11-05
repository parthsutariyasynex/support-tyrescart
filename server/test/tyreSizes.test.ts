// Pure, DB-free tests for the tyre size format (services/tyreSizes.ts). Run with `npx tsx --test test/tyreSizes.test.ts`.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizeTyreSize, sortTyreSizes, validateTyreSize } from '../src/services/tyreSizes.js';

describe('tyre sizes are saved with a space before the R, as the Tyrescart CSV writes them', () => {
  test('metric, no-aspect, truck and flotation sizes', () => {
    assert.equal(validateTyreSize('175/70R13'), '175/70 R13');
    assert.equal(validateTyreSize('175/70 r13'), '175/70 R13');
    assert.equal(validateTyreSize(' 155 / 70  R 12 '), '155/70 R12');
    assert.equal(validateTyreSize('225/45ZR17'), '225/45 ZR17');
    assert.equal(validateTyreSize('245/40RF18'), '245/40 RF18');
    assert.equal(validateTyreSize('LT265/75R16'), 'LT265/75 R16');
    assert.equal(validateTyreSize('195R15C'), '195 R15C');
    assert.equal(validateTyreSize('10R22.5'), '10 R22.5');
    assert.equal(validateTyreSize('31X10.50R15'), '31X10.50 R15');
  });

  test('a size with a dash and no letter keeps its form', () => {
    assert.equal(validateTyreSize('205/55-16'), '205/55-16');
  });

  test('saving is idempotent', () => {
    for (const s of ['175/70 R13', '225/45 ZR17', '31X10.50 R15', '1000 R22.5']) assert.equal(normalizeTyreSize(s), s);
  });

  test('not a tyre size is still refused', () => {
    assert.throws(() => validateTyreSize('hello'), /doesn’t look like a tyre size/);
    assert.throws(() => validateTyreSize(''), /Enter a tyre size/);
  });

  test('sorting reads the spaced form: rim, then width, then aspect', () => {
    assert.deepEqual(sortTyreSizes(['185/70 R13', '155/70 R12', '165/65 R13', '175/70 R13', '165/70 R13']), [
      '155/70 R12',
      '165/65 R13',
      '165/70 R13',
      '175/70 R13',
      '185/70 R13',
    ]);
  });
});
