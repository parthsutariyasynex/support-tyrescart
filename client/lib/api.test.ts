// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { GqlError, api, gql, isNetworkError } from './api';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('gql/api: telling "can\'t reach the server" apart from a real answer', () => {
  test('gql(): fetch itself rejecting (refused/reset connection) is a NetworkError', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(gql('{ __typename }'), (err: unknown) => {
      assert.ok(isNetworkError(err));
      return true;
    });
  });

  test('gql(): a non-JSON error body (nginx/Next proxy failure while the backend restarts) is a NetworkError', async () => {
    globalThis.fetch = (async () => new Response('Internal Server Error', { status: 500 })) as typeof fetch;
    await assert.rejects(gql('{ __typename }'), (err: unknown) => {
      assert.ok(isNetworkError(err));
      return true;
    });
  });

  test('gql(): a well-formed GraphQL error response is a GqlError, not a NetworkError', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Invalid email or password', extensions: { code: 'INVALID_CREDENTIALS' } }] }), {
        status: 200,
      })) as typeof fetch;
    await assert.rejects(gql('mutation { login { token } }'), (err: unknown) => {
      assert.ok(err instanceof GqlError);
      assert.equal(isNetworkError(err), false);
      assert.equal((err as GqlError).code, 'INVALID_CREDENTIALS');
      return true;
    });
  });

  test('api(): fetch itself rejecting is a NetworkError', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await assert.rejects(api('/some/path'), (err: unknown) => {
      assert.ok(isNetworkError(err));
      return true;
    });
  });

  test('api(): a non-JSON error body is a NetworkError', async () => {
    globalThis.fetch = (async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as typeof fetch;
    await assert.rejects(api('/some/path'), (err: unknown) => {
      assert.ok(isNetworkError(err));
      return true;
    });
  });

  test('api(): a well-formed JSON error response is a plain Error, not a NetworkError', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })) as typeof fetch;
    await assert.rejects(api('/some/path'), (err: unknown) => {
      assert.equal(isNetworkError(err), false);
      assert.equal((err as Error).message, 'Not found');
      return true;
    });
  });
});
