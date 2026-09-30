const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const section = (a,b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
const stamp = '2026-09-30T16:18:36+03:00';
const change = (field, from, to, time=stamp) => ({field,value:{from,to},createdDate:time});
function setup(history) {
 const state = {task:{accomplices:['820']},patches:[]};
 const c = vm.createContext({
  parseFormUrlEncoded:x=>x,getTaskIdFromOutgoingWebhook:()=> '1',WEBHOOK_TOKEN:'secret',
  normalizeHistoryField:x=>String(x||'').replace(/_/g,'').toUpperCase(),
  normalizeId:x=>x==null?null:String(x),normalizeIds:x=>x||[],normalizeTaskPayload:x=>x,unwrapData:x=>x,
  TASK_RESULT_FIELD_CODE:'UF_TASK_SUMMARY',isTaskSummaryFieldChange:x=>x.field==='UF_TASK_TITLE',
  isTagsChange:x=>x?.field==='TAGS',isDoneStageChange:()=>false,isRecentAiTagUpdate:()=>true,
  queueTaskSummaryTags:()=>({queued:true}),saveDebug(){},
  queueClosedTaskProcessing:()=>{throw Error('unexpected close');},
  coworkRequest:async(method,url,body)=>{
   if(url.includes('/history'))return history;
   if(method==='PATCH'){state.patches.push(body);Object.assign(state.task,body);}
   return state.task;
  },
 });
 vm.runInContext(section('async function addAccomplice','function isInsufficientInfoComment')+
   section('async function handleWebhook','function sendJson'),c);
 return {c,state,run:(ts=Date.parse(stamp)/1000)=>c.handleWebhook({auth:{application_token:'secret'},event:'ONTASKUPDATE',ts})};
}
test('AUDITORS before RESPONSIBLE_ID at same timestamp adds 716 and preserves 820',async()=>{
 const {state,run}=setup([change('AUDITORS','38,204','38,204,716'),change('RESPONSIBLE_ID','716','650')]);
 const result=await run();assert.equal(result.data.actions[0].userId,'716');
 assert.deepEqual(JSON.parse(JSON.stringify(state.task.accomplices)),['820','716']);
 await run();assert.equal(state.patches.length,1);
});
test('reverse order and responsible-only events are handled',async()=>{
 for(const history of [[change('RESPONSIBLE_ID','716','650'),change('AUDITORS','38','38,716')],[change('RESPONSIBLE_ID','716','650')]]){
  const {state,run}=setup(history);await run();assert.equal(state.patches.length,1);
 }
});
test('same-second SUMMARY, TITLE or AI tag changes do not hide reassignment',async()=>{
 for(const field of ['UF_TASK_SUMMARY','UF_TASK_TITLE','TAGS']){
  const {state,run}=setup([change(field,'old','new'),change('RESPONSIBLE_ID','716','650')]);
  await run();assert.equal(state.patches.length,1,field);
 }
});
test('only exact latest timestamp is grouped, with and without webhook timestamp',async()=>{
 const {c,state,run}=setup([change('AUDITORS','38','38,716'),change('RESPONSIBLE_ID','716','650','2026-09-30T16:18:35+03:00')]);
 await run();await run(null);assert.equal(state.patches.length,0);
 const batch=(await c.getLatestUpdateContext('1',null)).batch;assert.equal(batch.length,1);
 assert.equal(batch[0].field,'AUDITORS');
});
test('out-of-window webhook does not replay older responsible history',async()=>{
 const {state,run}=setup([change('RESPONSIBLE_ID','716','650')]);
 await run(Date.parse(stamp)/1000+60);assert.equal(state.patches.length,0);
});
