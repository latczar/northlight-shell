import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readServicesProposal} from '../src/review/phone-services-proposal.mjs';

const expected = {id:'call', agent:'iris', branch:'pilot', from:'dev', to:'sandbox', url:'https://kestrel-garage.example/services/'};
const proposal = {draftId:'draft', proposed:'Brake repair', published:false, status:'pending'};
const result = (name, data) => ({tool_name:name, result_value:JSON.stringify(data), is_error:false});
function fixture() {
  return {conversation_id:'call',agent_id:'iris',branch_id:'pilot',status:'done',
    metadata:{phone_call:{direction:'inbound',external_number:'dev',agent_number:'sandbox'}},
    transcript:[{role:'user',message:'Please check Services.'},{role:'agent',tool_results:[
      result('review_services',{url:expected.url,currentTitle:'Services',heading:'Brakes'}),
      result('queue_services_title',proposal)]}]};
}
test('returns the recorded proposal and tolerates an identical tool retry', () => {
  const call = fixture();
  call.transcript[1].tool_results.push(result('queue_services_title',proposal));
  assert.deepEqual(readServicesProposal(call,expected),{draftId:'draft',title:'Brake repair',turns:[{role:'user',text:'Please check Services.'}]});
});
for (const key of ['id','agent','branch','from','to','url']) {
  test('rejects a different '+key, () => assert.equal(readServicesProposal(fixture(),{...expected,[key]:'other'}),null));
}
for (const [label, change] of [
  ['unfinished call', c => c.status='processing'],
  ['outbound call', c => c.metadata.phone_call.direction='outbound'],
  ['agent-only request', c => c.transcript[0].role='agent'],
  ['invalid tool list', c => c.transcript[1].tool_results={}],
  ['failed audit', c => c.transcript[1].tool_results[0].is_error=true],
  ['invalid JSON', c => c.transcript[1].tool_results[1].result_value='{'],
  ['missing proposal', c => c.transcript[1].tool_results.pop()],
  ['published proposal', c => c.transcript[1].tool_results[1]=result('queue_services_title',{...proposal,published:true})],
  ['conflicting proposal', c => c.transcript[1].tool_results.push(result('queue_services_title',{...proposal,proposed:'Other title'}))]
]) {
  test('rejects '+label, () => {const call=fixture();change(call);assert.equal(readServicesProposal(call,expected),null)});
}

test('a repeat call handoff keeps its original proposal identity', async () => {
  const {rememberCallSource} = await import('../src/review/phone-services-proposal.mjs');
  const rows = new Map();
  const tx = {get:key => rows.get(key), put:(key,value) => rows.set(key,value)};
  const store = {transaction:fn => fn(tx)};
  assert.equal(await rememberCallSource(store,'first','Title','d1'),true);
  assert.equal(await rememberCallSource(store,'first','Title','d1'),true);
  assert.equal(await rememberCallSource(store,'first','Different','d2'),false);
  assert.equal(await rememberCallSource(store,'second','Different','d2'),true);
  assert.deepEqual(rows.get('services-source:first'),{title:'Title',draftId:'d1'});
});

test('checks the recorded field, page and exact wording before any review', async () => {
  const {matchesRecordedTitle} = await import('../src/review/phone-services-proposal.mjs');
  const source = {title:'Title',draftId:'d1'};
  const preview = {field:'title',url:expected.url,proposed:'Title'};
  assert.ok(matchesRecordedTitle({preview},source,expected.url));
  for (const changed of [{field:'description'},{url:expected.url+'other'},{proposed:'Other title'}]) {
    assert.equal(matchesRecordedTitle({preview:{...preview,...changed}},source,expected.url),false);
  }
  assert.equal(matchesRecordedTitle({preview},null,expected.url),false);
});
