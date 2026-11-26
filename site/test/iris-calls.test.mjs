import assert from 'node:assert/strict';
import test from 'node:test';
import { pilotCalls } from '../src/iris-calls.mjs';

// Synthetic voice line: 01632 numbers are reserved for drama and examples.
const line = { agent:'agent_fixture', branch:'branch_fixture', number:'+441632960001', handset:'+441632960002' };
const phone = { direction:'inbound', agent_number:line.number, external_number:line.handset };
const summary = id => ({conversation_id:'conv_'+id, agent_id:line.agent, branch_id:line.branch, status:'done', direction:'inbound'});
const detail = id => ({...summary(id), metadata:{phone_call:phone,start_time_unix_secs:1700000000},transcript:[{role:'user',message:'Review Services.'}]});

test('a removed recording and duplicate listing leave the other transcript accessible once', async () => {
  const calls = [];
  const load = async (url, options) => {
    assert.equal(options.headers['xi-api-key'],'fixture');
    calls.push(url);
    if (url.includes('?')) {
      assert.equal(new URL(url).searchParams.get('cursor'),'page+2');
      return Response.json({conversations:[summary('removed'),summary('valid'),summary('valid')],has_more:true,next_cursor:'page3'});
    }
    if (url.endsWith('conv_removed')) return new Response(null,{status:404});
    return Response.json(detail('valid'));
  };
  const page = await pilotCalls('fixture','page+2',load,line);
  assert.equal(calls.length,3);
  assert.equal(page.cursor,'page3');
  assert.deepEqual(page.records.map(r=>r.turns),[[{who:'You',text:'Review Services.'}]]);
});

test('a listing alone never authorises displaying transcript text', async () => {
  for(const override of [{agent_id:'other'}, {branch_id:'other'}, {status:'processing'}, {conversation_id:'conv_other'},
      ...[{direction:'outbound'},{external_number:'+441632960099'},{agent_number:'+441632960098'}].map(change=>({metadata:{phone_call:{...phone,...change}}}))]) {
    const read=async url=>Response.json(url.includes('?')?{conversations:[summary('private')]}:{...detail('private'),...override});
    assert.deepEqual((await pilotCalls('fixture',null,read,line)).records,[]);
  }
});

test('rate limits stay distinguishable from empty history', async () => {
  await assert.rejects(()=>pilotCalls('fixture',null,async()=>new Response(null,{status:429}),line),/unavailable/);
});

test('history refuses to run without a configured voice line', async () => {
  await assert.rejects(()=>pilotCalls('fixture',null,async()=>{ throw new Error('should not fetch'); },{...line,handset:''}),/not configured/);
});
