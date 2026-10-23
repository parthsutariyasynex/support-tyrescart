// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WHATSAPP_TEXT_MAX, overLimit, tooLongText } from './textLimits';

test("only WhatsApp's / the database's limits; over one is reported, never cut", () => {
  assert.equal(WHATSAPP_TEXT_MAX, 4096);
  assert.equal(overLimit('x'.repeat(4096), WHATSAPP_TEXT_MAX), false);
  assert.equal(overLimit('x'.repeat(4097), WHATSAPP_TEXT_MAX), true);
  assert.equal(overLimit('x'.repeat(99_999), null), false); // limit not known yet: nothing blocked
  assert.equal(tooLongText('x'.repeat(4200), 4096), '4,200 / 4,096 characters: WhatsApp allows up to 4,096. Shorten it or send it in parts.');
});
