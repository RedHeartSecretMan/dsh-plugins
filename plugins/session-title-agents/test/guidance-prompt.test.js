import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildSystemPrompt} from '../lib/title.js';
import {resolveConfig} from '../lib/config.js';
const base=()=>({...resolveConfig(),dateLabel:'1025',typeLabel:'修复',topicLabel:'主题',isRefining:true});
test('no naming excerpt leaves the ordinary prompt free of extra title context',()=>{
 const text=buildSystemPrompt({...base(),currentTitle:{title:'existing',canonical:true}});
 assert.ok(!text.includes('AGENTS.md'));assert.ok(!text.includes('existing'));
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
});
