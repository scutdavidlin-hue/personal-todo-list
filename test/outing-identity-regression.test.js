import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveTaskIntent, buildResolutionMutationPlan} from '../supabase/functions/_shared/task-resolution-engine.js';
import {executeTaskResolution} from '../supabase/functions/_shared/task-resolution-executor.js';
const old={"id":"isolated-chongyang","title":"重阳节带小朋友去白云山登高【或者其他山】","notes":"2026年重阳节为10月18日（周日）。出发前核对景区重阳开放及交通安排、滑道是否开放和儿童乘坐条件；尚未确认2026年重阳滑道开放。用户未指定具体出发或提醒时刻。\n\n原始请求：重阳节那天带我们小朋友去白云山登高，然后还有带他去玩白云山的滑道。就提醒我。","originalIntent":"重阳节那天带我们小朋友去白云山登高，然后还有带他去玩白云山的滑道。就提醒我。","due":"2026-10-18","status":"open"};
const incoming={"title":"周二晚和老婆一起带女儿去长隆万圣节活动","raw_text":"提醒一下我今晚,因为现在已经过凌晨,就今晚周二晚,带我女儿去长隆的万圣节活动,跟我老婆一起带她去。","notes":"安排在2026年10月13日周二晚上。用户未指定具体时刻；出发前确认具体园区当晚活动安排及儿童入场、项目要求。\n\n原始请求：提醒一下我今晚,因为现在已经过凌晨,就今晚周二晚,带我女儿去长隆的万圣节活动,跟我老婆一起带她去。","due":"2026-10-13","requested_date":"2026-10-13"};
test('real outing regression creates a separate action without independent boilerplate',()=>{
 const before=JSON.stringify(old);
 for(const due of ['2026-10-13','2026-11-13','2026-10-18']){
  const r=resolveTaskIntent({...incoming,due,requested_date:due},{tasks:[old]});
  assert.notEqual(r.decision,'UPDATE');assert.notEqual(r.decision,'MERGE');assert.equal(r.should_create,true);
  assert.equal(buildResolutionMutationPlan(incoming,r).operations[0].type,'create');
 }
 assert.equal(JSON.stringify(old),before);
});
test('group together is not an analytical scope extension, even when notes mention checks',()=>{
 for(const raw_text of ['今晚和老婆一起带女儿去长隆万圣节活动','提醒我周二和老婆一并带女儿去长隆','提醒我明天以及老婆带孩子去另一处乐园']){
  const r=resolveTaskIntent({...incoming,raw_text},{tasks:[old]});assert.notEqual(r.decision,'UPDATE');assert.equal(r.should_create,true);
 }
});
test('real date changes retain exact authorized task identity',()=>{
 const r=resolveTaskIntent({...incoming,title:old.title,raw_text:'把重阳登高任务日期改到10月19日',existing_task_id:old.id,due:'2026-10-19'},{tasks:[old]});
 assert.equal(r.decision,'UPDATE');assert.equal(r.confidence,1);assert.equal(r.existing_task_id,old.id);
});
test('execution refuses low, missing and non-finite update confidence before any side effect',async()=>{
 for(const confidence of [.2547,.899,undefined,NaN,Infinity]){
  const events=[];const adapter=new Proxy({}, {get:()=>()=>events.push('effect')});
  await assert.rejects(()=>executeTaskResolution(incoming,{decision:'UPDATE',confidence,requires_clarification:false},adapter),e=>e.code==='TASK_TARGET_AMBIGUOUS');
  assert.deepEqual(events,[]);
 }
});

