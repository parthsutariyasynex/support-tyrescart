// Run: npm test --workspace=client
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDeleteChat, deleteChatText, NO_DELETE, withoutChat, type DeleteChatState } from './deleteChat';

function setup(remove: (id: string) => Promise<unknown> = async () => true) {
  const calls: string[] = [];
  const deleted: string[] = [];
  const states: DeleteChatState[] = [];
  const flow = createDeleteChat({
    remove: (id) => {
      calls.push(id);
      return remove(id);
    },
    onDeleted: (id) => deleted.push(id),
    onChange: (s) => states.push(s),
  });
  return { flow, calls, deleted, states };
}

describe('Delete chat asks first', () => {
  test('choosing Delete chat only opens the confirmation; nothing is sent', () => {
    const { flow, calls, deleted } = setup();
    flow.ask('c1');
    assert.deepEqual(flow.state, { conversationId: 'c1', busy: false, error: '' });
    assert.deepEqual(calls, []);
    assert.deepEqual(deleted, []);
  });

  test('Cancel does nothing: no request, the chat stays, the dialog closes', async () => {
    const { flow, calls, deleted } = setup();
    flow.ask('c1');
    flow.cancel();
    assert.deepEqual(flow.state, NO_DELETE);
    assert.equal(await flow.confirm(), false, 'a later Delete without asking again does nothing');
    assert.deepEqual(calls, []);
    assert.deepEqual(deleted, []);
  });

  test('Delete after confirming: one request, then the chat leaves the list', async () => {
    const { flow, calls, deleted, states } = setup();
    flow.ask('c1');
    assert.equal(await flow.confirm(), true);
    assert.deepEqual(calls, ['c1']);
    assert.deepEqual(deleted, ['c1']);
    assert.deepEqual(flow.state, NO_DELETE);
    assert.ok(states.some((s) => s.busy), 'shows it is working meanwhile');
  });

  test('pressing Delete twice deletes once; Cancel is ignored while it is deleting', async () => {
    let finish!: () => void;
    const { flow, calls, deleted } = setup(() => new Promise<void>((r) => (finish = r)));
    flow.ask('c1');
    const first = flow.confirm();
    assert.equal(await flow.confirm(), false);
    flow.cancel();
    assert.equal(flow.state.busy, true);
    finish();
    assert.equal(await first, true);
    assert.deepEqual(calls, ['c1']);
    assert.deepEqual(deleted, ['c1']);
  });

  test("a failure keeps the chat and the dialog open, with the reason; it can be retried or cancelled", async () => {
    let fail = true;
    const { flow, calls, deleted } = setup(async () => {
      if (fail) throw new Error('Conversation not found');
    });
    flow.ask('c1');
    assert.equal(await flow.confirm(), false);
    assert.deepEqual(flow.state, { conversationId: 'c1', busy: false, error: 'Conversation not found' });
    assert.deepEqual(deleted, []);
    fail = false;
    assert.equal(await flow.confirm(), true);
    assert.deepEqual(calls, ['c1', 'c1']);
    assert.deepEqual(deleted, ['c1']);
  });

  test('without a chat chosen, Delete does nothing', async () => {
    const { flow, calls } = setup();
    assert.equal(await flow.confirm(), false);
    assert.deepEqual(calls, []);
  });
});

test('the deleted chat leaves the list; the others stay in order', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(withoutChat(list, 'b'), [{ id: 'a' }, { id: 'c' }]);
  assert.deepEqual(withoutChat(list, 'x'), list);
});

test('the confirmation says it is only for you and nothing is lost', () => {
  const t = deleteChatText('Asha');
  assert.equal(t.title, 'Delete chat with Asha?');
  assert.match(t.body, /your chat list only/);
  assert.match(t.body, /teammates still see/);
});
