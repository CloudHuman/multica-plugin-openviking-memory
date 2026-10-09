import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFacts, assessPrivateIsolation, CASES } from '../e2e/real-agent/benchmark.mjs';
import { recoverDeliveredComment } from '../e2e/real-agent/delivery-recovery.mjs';
import { citesUri, sameUri } from '../e2e/real-agent/answer-checks.mjs';
import DeliveryFault from '../e2e/real-agent/after-delivery-fault.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('benchmark rejects stale budgets, wrong durations and ungrounded sources separately', () => {
  const c = CASES[0], uri = 'viking://user/u/memories/entities/project.md';
  const record = facts => ({ comments: [{ content: JSON.stringify(facts) }], recalls: [{ run: { bound: true }, entries: [{ scope: 'shared:w', uri }] }] });
  const facts = { queue: c.queue, budget_yuan: c.budget, double_write_days: c.days, source: uri };
  assert.equal(evaluateFacts(record(facts), c, 'shared:w').correct, true);
  assert.equal(evaluateFacts(record({ ...facts, budget_yuan: c.previous }), c, 'shared:w').budget, false);
  assert.equal(evaluateFacts(record({ ...facts, double_write_days: 99 }), c, 'shared:w').days, false);
  assert.equal(evaluateFacts(record({ ...facts, source: 'viking://invented' }), c, 'shared:w').provenance, false);
});

test('a source cited percent-encoded is the same shared file; another file is not', () => {
  // 10-09 benchmark: B cited …/entities/%E9%A1%B9%E7%9B%AE/%E7%99%BD%E9%B9%AD.md for …/entities/项目/白鹭.md.
  const c = CASES[2], uri = 'viking://user/mcs-shared/memories/entities/项目/白鹭.md';
  const record = source => ({ comments: [{ content: JSON.stringify({ queue: c.queue, budget_yuan: c.budget, double_write_days: c.days, source }) }], recalls: [{ run: { bound: true }, entries: [{ scope: 'shared:w', uri }] }] });
  assert.equal(evaluateFacts(record(encodeURI(uri)), c, 'shared:w').provenance, true);
  assert.equal(evaluateFacts(record(uri), c, 'shared:w').provenance, true);
  assert.equal(evaluateFacts(record(encodeURI(uri.replace('白鹭', '海燕'))), c, 'shared:w').provenance, false);
  assert.equal(citesUri(`来源：${encodeURI(uri)}，预算增加 5%。`, uri), true, 'a stray percent sign does not break the decoding');
  assert.equal(citesUri('来源：%E9%A1 未写完', uri), false);
  assert.equal(sameUri('', ''), false);
});

test('receipt recovery requires the explicitly selected comment and uses its exact content digest', async () => {
  const task = { id: 'task', agent_id: 'agent', status: 'failed', error: 'Missing Authentication header' };
  const comment = { id: 'comment', author_id: 'agent', author_type: 'agent', source_task_id: 'task', content: 'confirmed final answer' };
  let calls = 0;
  await recoverDeliveredComment({ task, comment, call: async (path, body) => { calls++; assert.equal(path, '/api/tasks/task/recover-delivery'); assert.match(body.comment_sha256, /^[a-f0-9]{64}$/); } });
  await assert.rejects(recoverDeliveredComment({ task, comment: { ...comment, source_task_id: 'other' }, call: async () => calls++ }));
  await assert.rejects(recoverDeliveredComment({ task: { ...task, error: 'runtime crash' }, comment, call: async () => calls++ }));
  assert.equal(calls, 1);
});

test('private isolation distinguishes an unexercised model failure from an actual authorized recall', () => {
  const empty = {taskId:'task',status:'failed',response:'',recalls:[]};
  assert.equal(assessPrivateIsolation(empty,'dm:allowed').recallObserved,false);
  const exercised = {...empty,status:'completed',recalls:[{run:{bound:true},entries:[]}]};
  assert.equal(assessPrivateIsolation(exercised,'dm:allowed').recallObserved,true);
  assert.equal(assessPrivateIsolation({...exercised,recalls:[{run:{bound:true},entries:[{scope:'dm:another'}]}]},'dm:allowed').unauthorizedScopeReturned,true);
  assert.equal(assessPrivateIsolation({...exercised,recalls:[{run:{bound:true},entries:[],scopesSearched:[{scope:'dm:another',hits:0}]}]},'dm:allowed').unauthorizedScopeSearched,true);
});

test('delivery fault waits for the actual CLI comment acknowledgement and injects only one main-model failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'delivery-fault-test-'));
  const path = join(directory,'plan.json'), access = join(directory,'access.json');
  const before = { gate: process.env.OVMEM_E2E_DELIVERY_AUTHORIZED, path: process.env.OVMEM_E2E_DELIVERY_FAULT, fetch: globalThis.fetch };
  try {
    process.env.OVMEM_E2E_DELIVERY_AUTHORIZED = '1'; process.env.OVMEM_E2E_DELIVERY_FAULT = path;
    writeFileSync(access,JSON.stringify({token:'private-member-token',workspaceId:'workspace'}));
    writeFileSync(path,JSON.stringify({issueId:'issue',model:'openai/main',base:'https://multica.example',accessFile:access,injected:false}));
    globalThis.fetch = async () => Response.json([{id:'final-comment-uuid',author_type:'agent',source_task_id:'task',content:'{"budget_yuan":8100,"source":"confirmed"}'}]);
    const plugin = await DeliveryFault(); let forwarded = 0;
    const config = {provider:{openrouter:{options:{fetch:async()=>{forwarded++;return new Response('normal');}}}}};
    await plugin.config(config);
    const send = model => config.provider.openrouter.options.fetch('https://openrouter.ai/api/v1/chat/completions',{body:JSON.stringify({model})});
    await plugin['tool.execute.after']({tool:'bash'},{output:'Unrelated command after an older persisted comment'});
    assert.equal((await send('openai/main')).status,200);
    await plugin['tool.execute.after']({tool:'bash'},{output:'Comment added to issue issue.\n'});
    assert.equal((await send('openai/auxiliary')).status,200);
    assert.equal((await send('openai/main')).status,401);
    assert.equal((await send('openai/main')).status,200);
    const plan = JSON.parse(readFileSync(path)); assert.equal(plan.taskId,'task');assert.equal(plan.source,'controlled-e2e-fault');assert.equal(forwarded,3);
  } finally {
    globalThis.fetch=before.fetch;
    for(const [key,value] of [['OVMEM_E2E_DELIVERY_AUTHORIZED',before.gate],['OVMEM_E2E_DELIVERY_FAULT',before.path]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    rmSync(directory,{recursive:true,force:true});
  }
});
