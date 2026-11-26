import assert from 'node:assert/strict';
import test from 'node:test';
import { servicesDraftFromCall } from '../src/review/services-draft-from-call.mjs';
import { saveLateFeedback, readLateFeedback, isAdditionalDecline } from '../src/review/review-feedback.mjs';

const chat = { id:'chat-1', turns:[{who:'You', text:'Please check the Services page title.'}] };

test('the staff handoff reopens the saved call proposal when retried', async () => {
  const record = {id:'proposal', preview:{field:'title', url:'https://kestrel-garage.example/services/'}};
  let saved = null;
  const turns = [];
  const options = {
    transcript:{...chat, kind:'call'}, staffUserId:'manager', clientId:'kestrel', agentId:'iris',
    dashboard:{conversationApproval: async () => saved},
    conversations:{getByName: () => ({turn: async request => {
      turns.push(request);
      saved = JSON.stringify(record);
      return new Response('done').body;
    }})},
  };
  await assert.rejects(servicesDraftFromCall({...options, staffUserId:undefined}), /signed-in/);
  assert.deepEqual(await servicesDraftFromCall(options), record);
  assert.deepEqual(await servicesDraftFromCall(options), record);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userId, 'manager');
  assert.equal(turns[0].source, 'app');
  assert.equal(turns[0].conversationId, 'services-editorial/chat-1');
  assert.equal(turns[0].input.id, 'chat-1');
  assert.equal(turns[0].request.singleProposal, true);
  assert.deepEqual(turns[0].request.allowedTools, ['review_site_page', 'submit_seo_copy']);
});

test('replaying late feedback once preserves separate reviewers and draft boundaries', async () => {
  const notes = new Map();
  const storage = {
    transaction: fn => fn({get:key => notes.get(key), put:(key, value) => notes.set(key, value)}),
    list: ({prefix}) => new Map([...notes].filter(([key]) => key.startsWith(prefix))),
  };
  for (const user of ['desktop', 'desktop', 'other']) await saveLateFeedback(storage, 'revision', user, 'Keep the town name.');
  await saveLateFeedback(storage, 'another', 'desktop', 'Different title.');
  assert.deepEqual((await readLateFeedback(storage, 'revision')).map(n => n.text), ['Keep the town name.', 'Keep the town name.']);
  assert.deepEqual((await readLateFeedback(storage, 'another')).map(n => n.text), ['Different title.']);
});

test("a second reviewer's feedback is extra history, while an exact retry is not", () => {
  const feedback = 'Lead with brake repairs.';
  const decision = {status:'declined', decidedBy:'staff-one', reason:feedback};
  assert.equal(isAdditionalDecline(decision, 'staff-one', feedback), false);
  assert.equal(isAdditionalDecline(decision, 'staff-two', feedback), true);
  assert.equal(isAdditionalDecline(decision, 'staff-one', 'Keep the garage name.'), true);
});
