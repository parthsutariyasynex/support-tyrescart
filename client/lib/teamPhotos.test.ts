import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onTeamPhotos, teamPhotoChanged, teamPhotoVersion } from './teamPhotos';

test("a teammate's picture: unknown until loaded, then follows each change live, and listeners hear about it", () => {
  assert.equal(teamPhotoVersion('u-ana'), undefined);
  let heard = 0;
  const stop = onTeamPhotos(() => heard++);
  teamPhotoChanged('u-ana', '2026-10-29T10:00:00.000Z');
  assert.equal(teamPhotoVersion('u-ana'), '2026-10-29T10:00:00.000Z');
  teamPhotoChanged('u-ana', null); // removed: initials again
  assert.equal(teamPhotoVersion('u-ana'), null);
  assert.equal(teamPhotoVersion('u-ben'), undefined, 'other people are untouched');
  assert.equal(heard, 2);
  stop();
  teamPhotoChanged('u-ana', '2026-10-29T11:00:00.000Z');
  assert.equal(heard, 2, 'no longer listening');
});
