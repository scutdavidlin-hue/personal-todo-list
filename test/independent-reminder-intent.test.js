import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTaskIntent } from '../supabase/functions/_shared/task-resolution-engine.js';
const old = {id:'oct',title:'赴香港 Apple Store 购买 iPhone Duo',due:'2026-10-15',status:'open'};
const incoming = raw_text => ({title:'赴香港 Apple Store 购买 iPhone Duo',raw_text,due:'2026-11-15'});
test('creation with a comma-separated protection does not authorize mutation', () => {
  for (const raw of [
    '十一月中旬左右提醒我去香港Apple Store购买iPhone Duo，十月份日程不要修改',
    '11月中旬左右提醒我去香港Apple Store购买iPhone Duo，十月份日程不修改。这是独立的11月购买任务，不是10月15日香港行任务。',
    '新增一个待办：十一月赴香港购买iPhone Duo，十月日程不调整',
  ]) {
    const r=resolveTaskIntent(incoming(raw),{tasks:[old,{...old,id:'closed',status:'completed'}]});
    assert.equal(r.should_create,true,raw);
    assert.notEqual(r.requires_clarification,true,raw);
    assert.equal(r.update,null,raw);
  }
});
test('independent new request still reuses an identical existing action on the same date', () => {
  const r=resolveTaskIntent(incoming('新增一个任务：赴香港 Apple Store 购买 iPhone Duo'),{tasks:[{...old,id:'nov',due:'2026-11-15'}]});
  assert.equal(r.decision,'DUPLICATE');
  assert.equal(r.existing_task_id,'nov');
});
test('commas cannot reset mutation negation and quotes cannot authorize creation',()=>{
  for(const raw of ['不要改旧任务，把日期改到11月15日','不要提醒我去香港，十月任务不修改','仅记录：提醒我去香港，十月任务不修改',"他说'提醒我去香港，十月任务不修改"]){
    const r=resolveTaskIntent(incoming(raw),{tasks:[old]});
    assert.equal(r.requires_clarification,true,raw);
    assert.equal(r.should_create,false,raw);
  }
});
