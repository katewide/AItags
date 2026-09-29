const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const section = (a,b) => source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function setup() {
  const state = { task:{UF_TASK_SUMMARY:'Ready',tags:['manual']}, calls:[], queued:[], ai:0, error:false };
  const c = vm.createContext({
    TASK_SUMMARY_FIELD_CODE:'UF_TASK_TITLE', TASK_RESULT_FIELD_CODE:'UF_TASK_SUMMARY', TASK_TAG_FIELD_NAME:'tags', TASK_TAGGING_ENABLED:true,
    TASK_TAXONOMY:{types:['консультация'],products:['бп'],objects:['документ']},
    SUMMARY_MODEL_NAME:'test',OPEN_TASK_AI_REQUEST_TIMEOUT_MS:100,AI_PREVIEW_TIMEOUT_MS:200,
    normalizeTaskPayload:x=>x, log(){},saveDebug(){},truncateDebugText:x=>x,
    markRecentAiTagUpdate(){},recentAiTagUpdates:new Map(), Date,
    closedTaskProcessingTaskIds:new Set(),previewContext:{getStore:()=>null},
    setTimeout:fn=>state.queued.push(fn),runPreviewDeadline:fn=>fn(),
    fetchTaskWithComments:async()=>({task:state.task,comments:[{message:'Summary'}]}),
    getGroupNameFromTask:()=>'',getGroupIdFromTask:()=>1,isCollabGroupName:()=>false,isGemmaExcludedGroupId:()=>false,
    getTaskTextFields:()=>['Task'],getCommentMessage:x=>x.message,buildTaskTaggingInstructions:()=> 'tag instructions',normalizeAiContent:x=>x,
    coworkRequest:async(method,url,body)=>{
      state.calls.push({method,url,body});
      if(method==='GET')return state.task;
      if(url==='/chat/completions'){state.ai++;if(state.onAI)state.onAI();return {choices:[{message:{content:'[AI_TAGS]{"type":"консультация","products":["бп"]}[/AI_TAGS]'}}]};}
      if(state.error)throw Error('write failed');
      state.task.tags=body.tags;return {};
    }
  });
  vm.runInContext(section('function getTaskSummaryFieldValue','function normalizeTaskTag')+section('function normalizeTaskTag','function markRecentAiTagUpdate')+section('async function updateTaskTags','function getImageMetadata'),c);
  return {c,state};
}
test('blank summary skips AI and PATCH; uppercase and camelCase field supported',async()=>{
 const {c,state}=setup();state.task={ufTaskSummary:'  '};assert.equal((await c.processTaskSummaryTags('1')).reason,'task_summary_empty');assert.equal(state.calls.length,0);
 assert.equal(c.getTaskResultFieldValue({customFields:{ufTaskSummary:'Title'}}),'Title');
});
test('summary classification patches only tags and preserves manual tags; repeated summary deduplicated',async()=>{
 const {c,state}=setup();const result=await c.processTaskSummaryTags('1');assert(result.updated);assert.equal(state.ai,1);
 const patch=state.calls.find(x=>x.method==='PATCH');assert.equal(patch.url,'/tasks/1');assert.deepEqual(JSON.parse(JSON.stringify(patch.body)),{tags:['manual','type: консультация','product: БП']});
 assert.equal((await c.processTaskSummaryTags('1')).reason,'task_summary_already_tagged');assert.equal(state.ai,1);
});
test('summary changed during AI does not apply stale classification',async()=>{
 const {c,state}=setup();state.onAI=()=>{state.task={...state.task,UF_TASK_SUMMARY:'Changed',tags:['new manual']}};
 assert.equal((await c.processTaskSummaryTags('1')).reason,'task_summary_changed');assert(!state.calls.some(x=>x.method==='PATCH'));
});
test('failed writes can retry, successful close-handler result suppresses event duplicate',async()=>{
 const {c,state}=setup();state.error=true;assert.equal((await c.processTaskSummaryTags('1')).error,'write failed');state.error=false;
 assert((await c.processTaskSummaryTags('1')).updated);assert.equal(state.ai,2);
 const cls=c.extractTaskTagClassification('[AI_TAGS]{"products":["бп"]}[/AI_TAGS]');
 await c.applyTagsAfterTaskSummary('2',cls,'Ready');assert.equal((await c.processTaskSummaryTags('2')).reason,'task_summary_already_tagged');
});
test('queue returns immediately and merges simultaneous events',async()=>{
 const {c,state}=setup();assert(c.queueTaskSummaryTags('1').queued);assert.equal(state.ai,0);assert.equal(c.queueTaskSummaryTags('1').queued,false);assert.equal(state.queued.length,1);
 await state.queued.shift()();assert.equal(state.ai,1);
});
test('webhook sees summary change anywhere in batch, authenticates and ignores unrelated changes',async()=>{
 const {c}=setup();Object.assign(c,{parseFormUrlEncoded:x=>x,getTaskIdFromOutgoingWebhook:()=> '1',WEBHOOK_TOKEN:'secret',getWebhookTimestampMs:()=>1,normalizeHistoryField:x=>String(x||'').replace(/[^a-z0-9]/gi,'').toUpperCase(),getLatestUpdateContext:async()=>({batch:[{field:'TAGS'},{field:'ufTaskSummary'}]})});
 vm.runInContext(section('function isTaskSummaryFieldChange','function isStatusClosedChange'),c);
 const start=source.indexOf('async function handleWebhook');const end=source.indexOf('  const stageChange',start);
 vm.runInContext(source.slice(start,end)+'return {unrelated:true};}',c);
 assert.equal((await c.handleWebhook({auth:{application_token:'wrong'}})).statusCode,403);
 const result=await c.handleWebhook({auth:{application_token:'secret'},event:'ONTASKUPDATE'});assert(result.data.queued);
 c.getLatestUpdateContext=async()=>({batch:[{field:'TAGS'}]});assert((await c.handleWebhook({auth:{application_token:'secret'},event:'ONTASKUPDATE'})).unrelated);
});
test('SUMMARY extraction excludes TITLE and AI tags; missing summary does not fabricate text',()=>{
 const {c}=setup();assert.equal(c.extractSummaryFieldText('[b]✅ SUMMARY:[/b] Done\n[b]📝 TITLE:[/b] Title\n[AI_TAGS]{}[/AI_TAGS]'),'Done');assert.equal(c.extractSummaryFieldText('INSUFFICIENT_INFORMATION'),'');
});
test('SUMMARY is updated and verified; silent failed write returns an error',async()=>{
 const {c,state}=setup();c.coworkRequest=async(method,url,body)=>{if(method==='PATCH')state.task.UF_TASK_SUMMARY=body.UF_TASK_SUMMARY;return state.task;};
 assert((await c.updateTaskResultField('1','New summary',state.task)).updated);assert.equal(state.task.UF_TASK_SUMMARY,'New summary');
 c.coworkRequest=async()=>state.task;assert((await c.updateTaskResultField('1','Not saved',state.task)).error);
});
test('tags must be read back: silent failed write is not cached as success',async()=>{
 const {c,state}=setup();c.coworkRequest=async()=>state.task;
 const cls=c.extractTaskTagClassification('[AI_TAGS]{"products":["бп"]}[/AI_TAGS]');
 assert((await c.applyTagsAfterTaskSummary('1',cls,'Ready')).error);assert.equal(c.hasCompletedTaskSummaryTags('1','Ready'),false);
});
test('close flow saves TITLE then SUMMARY then tags; summary failure blocks tags; preview writes nothing',async()=>{
 const {c,state}=setup();const events=[];
 const start=source.indexOf('  const generatedTitle = extractTitleFromAiComment(aiComment);'),end=source.indexOf('\n  return {',start);
 vm.runInContext('async function finishClose(dryRun){const taskId="1",groupId="1",mainTask={tags:["manual"]},aiComment="[b]✅ SUMMARY:[/b] Done\\n[b]📝 TITLE:[/b] Ready",tagClassification={found:true,type:"консультация",products:["бп"],objects:[]};'+source.slice(start,end)+'return {taskTagsResult,taskTagsWouldBeUpdated};}',c);
 c.isSummaryOnlyGroup=()=>false;c.extractTitleFromAiComment=()=> 'Ready';c.updateTaskSummaryField=async()=>{events.push('title');return {updated:true}};
 c.updateTaskResultField=async(id,value)=>{events.push('summary');assert.equal(value,'Done');return {updated:true}};
 c.applyTagsAfterTaskSummary=async()=>{events.push('tags');return {updated:true}};
 await c.finishClose(false);assert.deepEqual(events,['title','summary','tags']);events.length=0;
 c.updateTaskResultField=async()=>{events.push('summary');return {error:'failed'}};assert.equal((await c.finishClose(false)).taskTagsResult.reason,'task_summary_save_failed');assert.deepEqual(events,['title','summary']);events.length=0;
 assert((await c.finishClose(true)).taskTagsWouldBeUpdated);assert.equal(events.length,0);
});

test('tag formatting and preview share casing and spacing; old formats require update',()=>{
 const {c}=setup();
 const classification={type:'консультация',products:['ка','зуп','ут','унф','бп','кэдо','эдо','1с-отчетность','erp','до','розница'],object_names:[{type:'роль',name:'РольOData'}]};
 const expected=['type: консультация','product: КА','product: ЗУП','product: УТ','product: УНФ','product: БП','product: КЭДО','product: ЭДО','product: 1С-отчетность','product: ERP','product: ДО','product: Розница','object: роль_РольOData'];
 assert.deepEqual(JSON.parse(JSON.stringify(c.buildManagedTaskTags(classification))),expected);
 assert.equal(c.taskTagListsEqual(['product: ка'],['product: КА']),false);
 assert.equal(c.taskTagListsEqual(['product:ка'],['product: КА']),false);
 let html;c.res={writeHead(){},end(x){html=x}};
 vm.runInContext(section('function sendAiTestPage','function getNextTaskTimeCheckDate'),c);vm.runInContext('sendAiTestPage(res)',c);
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 const browser=vm.createContext({document:{getElementById:()=>({addEventListener(){}})}});vm.runInContext(script,browser);
 assert.deepEqual(JSON.parse(JSON.stringify(browser.buildManagedTaskTags(classification))),expected);
});
