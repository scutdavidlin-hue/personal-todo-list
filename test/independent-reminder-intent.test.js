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

const ledgerInputs = [
 {title:'赴香港 Apple Store 购买 iPhone Duo',raw_text:'十一月中旬左右提醒我去香港Apple Store购买iPhone Duo，十月份日程不要修改',notes:'十一月中旬安排赴香港购买，提前确认香港 Apple Store 库存与预约取货；十月行程保持不变。'},
 {title:'11月中旬赴香港 Apple Store 购买 iPhone Duo',raw_text:'11月中旬左右提醒我去香港Apple Store购买iPhone Duo，十月份日程不修改。这是独立的11月购买任务，不是10月15日香港行任务。',notes:'独立的11月购买计划；提前查询香港 Apple Store 库存和预约取货。保留10月15日至16日原行程，不修改。'}
].map(i=>({...i,notes:i.notes+'\n\n原始请求：'+i.raw_text,due:'2026-11-15'}));
test('both complete original ledger inputs reuse the existing November action',()=>{
 for(const i of ledgerInputs){const r=resolveTaskIntent(i,{tasks:[old,{...old,id:'nov',due:'2026-11-15'}]});assert.equal(r.decision,'DUPLICATE');assert.equal(r.existing_task_id,'nov');assert.equal(r.should_create,false);}
});
test('only date-consistent leading calendar qualifiers are removed',()=>{
 for(const prefix of ['11月中旬','十一月中旬左右','2026年11月15日','11月15号','11月']) {
  const r=resolveTaskIntent({...ledgerInputs[1],title:prefix+old.title},{tasks:[{...old,id:'nov',due:'2026-11-15'}]});assert.equal(r.decision,'DUPLICATE',prefix);
 }
 for(const prefix of ['10月中旬','2027年11月15日','11月上旬','11月下旬','11月16日']) {
  const r=resolveTaskIntent({...ledgerInputs[1],title:prefix+old.title},{tasks:[{...old,id:'nov',due:'2026-11-15'}]});assert.notEqual(r.decision,'DUPLICATE',prefix);
 }
});
test('qualifier dedupe preserves cross-month, distinct action, completed and multi-candidate protection',()=>{
 const i=ledgerInputs[1];
 for(const task of [old,{...old,title:'赴香港 Apple Store 维修 iPhone Duo',due:'2026-11-15'},{...old,title:'赴香港 Apple Store 购买 iPhone Pro',due:'2026-11-15'},{...old,due:'2026-11-15',status:'completed'}]){
  const r=resolveTaskIntent(i,{tasks:[task]});assert.notEqual(r.decision,'DUPLICATE');assert.equal(r.update,null);assert.equal(r.should_create,true);
 }
 const r=resolveTaskIntent(i,{tasks:[{...old,id:'n1',due:'2026-11-15'},{...old,id:'n2',title:'十一月中旬'+old.title,due:'2026-11-15'}]});assert.equal(r.requires_clarification,true);assert.equal(r.should_create,false);
});
