import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterCountries, filterTimeZones, flagOf, joinPhone, phoneCountries, splitPhone, timeZoneLabel, timeZoneOptions } from './profileOptions';

test('country picker: flags, dial codes and names from the platform', () => {
  assert.equal(flagOf('AE'), '🇦🇪');
  const uae = phoneCountries().find((c) => c.code === 'AE');
  assert.deepEqual(uae && { dial: uae.dial, name: uae.name }, { dial: '971', name: 'United Arab Emirates' });
  assert.ok(phoneCountries().length > 200);
});

test('phone number: split a saved number and join it back', () => {
  assert.deepEqual(splitPhone('+971501234567'), { country: 'AE', national: '501234567' });
  assert.deepEqual(splitPhone('+919876543210'), { country: 'IN', national: '9876543210' });
  assert.deepEqual(splitPhone(null), { country: 'AE', national: '' });
  assert.equal(joinPhone('AE', '050 123 4567'), '+971501234567');
  assert.equal(joinPhone('IN', '98765-43210'), '+919876543210');
  assert.equal(joinPhone('AE', '  '), '');
  assert.equal(joinPhone('AE', '+44 20 7946 0958'), '+442079460958');
});

test('time zones: SleekFlow-style labels, sorted west to east', () => {
  const at = new Date('2026-01-15T12:00:00Z');
  assert.equal(timeZoneLabel('Asia/Dubai', at), '(UTC+04:00) Gulf Standard Time (Dubai)');
  assert.equal(timeZoneLabel('Asia/Kolkata', at), '(UTC+05:30) India Standard Time (Kolkata)');
  assert.match(timeZoneLabel('UTC', at), /^\(UTC\+00:00\) /);
  const list = timeZoneOptions(at);
  assert.ok(list.some((z) => z.value === 'Asia/Dubai'));
  assert.ok(list.every((z, i) => i === 0 || list[i - 1].offsetMinutes <= z.offsetMinutes));
});

test('time zone search: by city, name, offset or id', () => {
  const list = timeZoneOptions(new Date('2026-01-15T12:00:00Z'));
  const values = (q: string) => filterTimeZones(list, q).map((z) => z.value);
  assert.deepEqual(values('dubai'), ['Asia/Dubai']);
  assert.ok(values('gulf standard').includes('Asia/Dubai'));
  assert.ok(values('UTC+04:00').includes('Asia/Dubai'));
  assert.deepEqual(values('new york'), ['America/New_York']);
  assert.deepEqual(values('America/New_York'), ['America/New_York']);
  assert.equal(values('').length, list.length);
  assert.deepEqual(values('nowhere-at-all'), []);
});

test('country search: best matches first, dial codes and ISO codes', () => {
  const list = phoneCountries().map((c) => ({ value: c.code, label: `${c.flag} ${c.name} (+${c.dial})` }));
  assert.equal(filterCountries(list, 'india')[0].value, 'IN');
  assert.equal(filterCountries(list, 'united arab')[0].value, 'AE');
  assert.equal(filterCountries(list, 'ae')[0].value, 'AE');
  assert.ok(filterCountries(list, '+91').some((c) => c.value === 'IN'));
  assert.equal(filterCountries(list, 'zzzz').length, 0);
});
