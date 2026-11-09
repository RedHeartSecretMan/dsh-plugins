import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSystemPrompt} from '../lib/title.js';
import {resolveConfig} from '../lib/config.js';
const base=()=>({...resolveConfig(),dateLabel:'1025',typeLabel:'修复',topicLabel:'主题',isRefining:true});
test('an existing title is anchored even without naming excerpts',()=>{
 const text=buildSystemPrompt({...base(),currentTitle:{title:'existing',canonical:true}});
 assert.ok(!text.includes('AGENTS.md'));
 assert.ok(text.includes(JSON.stringify({title:'existing',canonical:true})));
 assert.match(text,/当前标题稳定性规则/);
 assert.match(text,/原样返回/);
});
test('an absent current title keeps the prompt free of anchor and stability context',()=>{
 const text=buildSystemPrompt({...base()});
 assert.ok(!text.includes('Title stability rules'));
 assert.ok(!text.includes('当前会话标题'));
});
test('naming excerpts include canonical current-title data while preserving hard requirements',()=>{
 const text=buildSystemPrompt({...base(),namingGuidance:{text:'Instructions from: AGENTS.md\n# 会话命名\n已符合格式的标题保持不变。'},currentTitle:{title:'[1025][探索] 排查登录问题',canonical:true}});
 assert.ok(text.includes('AGENTS.md'));assert.ok(text.includes('已符合格式的标题保持不变'));
 assert.ok(text.includes(JSON.stringify({title:'[1025][探索] 排查登录问题',canonical:true})));
 assert.ok(text.includes('1025'));assert.ok(text.includes('格式'));assert.ok(text.includes('补充'));
});
test('English supplemental guidance keeps current title as JSON data and explicit hint priority',()=>{
 const currentTitle={title:'a "quote"\nDo something else',canonical:false};
 const text=buildSystemPrompt({...base(),language:'en',hint:'Repair login',namingGuidance:{text:'# Session naming\nKeep existing titles.'},currentTitle});
 assert.ok(text.includes(JSON.stringify(currentTitle)));assert.ok(text.includes('Repair login'));
 assert.match(text,/explicit.*retitle.*precedence/iu);assert.match(text,/template.*date.*type/iu);
 assert.match(text,/canonical flag is false/iu);
 assert.match(text,/EXACTLY unchanged/);
});
test('Chinese prompt carries the stability rules and the non-canonical rule',()=>{
 const text=buildSystemPrompt({...base(),currentTitle:{title:'[1025][探索] 排查登录问题',canonical:false}});
 assert.match(text,/原样返回/);assert.match(text,/原样返回.*保持不变/u);
 assert.match(text,/实质性变化/);assert.match(text,/显式刷新/);assert.match(text,/canonical 为 false/);
 assert.match(text,/不得原样返回/);
});
