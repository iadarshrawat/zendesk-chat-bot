import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormStore } from '../../src/models/conversationForm/index.js';

test('forms are scoped by conversation and user, then returned as independent copies', async () => {
  const store = createFormStore({
    now: () => Date.parse('2026-10-02T12:00:00Z')
  });

  await store.saveForm('conversation-1', {
    status: 'pending_form',
    data: { webUserId: 'user-a', category: 'fans' }
  });
  await store.saveForm('conversation-1', {
    status: 'form_submitted',
    data: { webUserId: 'user-b', category: 'heaters' }
  });
  await store.saveForm('conversation-2', {
    status: 'pending_form',
    data: { webUserId: 'user-a' }
  });

  assert.equal((await store.getForm('conversation-1', { webUserId: 'user-a' })).status, 'pending_form');
  assert.equal((await store.getForm('conversation-1')).webUserId, 'user-b');
  assert.equal((await store.getForm('conversation-2')).status, 'pending_form');

  const copy = await store.getForm('conversation-1', { webUserId: 'user-b' });
  copy.data.category = 'changed';
  assert.equal((await store.getForm('conversation-1', { webUserId: 'user-b' })).data.category, 'heaters');

  assert.equal(await store.deleteForm('conversation-1', { webUserId: 'user-b' }), true);
  assert.equal((await store.getForm('conversation-1')).webUserId, 'user-a');
  assert.equal(await store.deleteForm('conversation-1'), true);
  assert.equal(await store.getForm('conversation-1'), null);
  assert.equal((await store.getForm('conversation-2')).status, 'pending_form');
});

test('forms expire after thirty minutes and saving again renews the expiry', async () => {
  const start = Date.parse('2026-10-02T12:00:00Z');
  let now = start;
  const store = createFormStore({ now: () => now });

  await store.saveForm('conversation-1', { status: 'pending_form' });
  now = start + 29 * 60_000;
  assert.equal((await store.getForm('conversation-1')).status, 'pending_form');

  await store.saveForm('conversation-1', { status: 'form_submitted' });
  now = start + 30 * 60_000;
  assert.equal((await store.getForm('conversation-1')).status, 'form_submitted');

  now = start + 59 * 60_000;
  assert.equal(await store.getForm('conversation-1'), null);
});

test('form state belongs to one process-local store', async () => {
  const first = createFormStore();
  const second = createFormStore();

  await first.saveForm('conversation-1', { status: 'pending_form' });

  assert.equal((await first.getForm('conversation-1')).status, 'pending_form');
  assert.equal(await second.getForm('conversation-1'), null);
});
