import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
const source=await readFile(new URL('../supabase/functions/personal-os-mcp/index.ts',import.meta.url),'utf8');
const actual=stripTypeScriptTypes(source.slice(source.indexOf('async function updateTaskReminder('),source.indexOf('async function taskResolutionService(')));
test('actual MCP gateway refuses accepted but unverified or uncleared reminder results',async()=>{
 for(const [result,expected] of [
  [{success:true,schedule:{reminder_policy:'custom',reminder_at:'2099-01-01T12:00',reminders:[{}],sync_required:false}},false],
  [{success:true,verified:true,schedule:{reminder_policy:'custom',reminder_at:'2099-01-01T12:00',reminders:[{}],sync_required:false}},false],
  [{success:true,verified:true,schedule:{reminder_policy:'none',reminder_at:null,reminder_offset_minutes:null,reminders:[],sync_required:true}},false],
  [{success:true,verified:true,schedule:{reminder_policy:'none',reminder_at:null,reminder_offset_minutes:null,reminders:[],sync_required:false}},true],
 ]){
  const fn=new Function('fetch','SUPABASE_URL','WRITE_TOKEN',actual+';return updateTaskReminder;')(async()=>new Response(JSON.stringify(result)),'https://isolated.test','isolated-token');
  const out=await fn({task_id:'isolated-task',reminder_policy:'none',reminder_at:null,reminder_offset_minutes:null,reminders:[]});
  assert.equal(out.isError,!expected);assert.equal(out.structuredContent.success,expected);
 }
});
