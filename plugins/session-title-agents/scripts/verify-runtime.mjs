// Installed-Harness contract check. The LLM adapter is stubbed; instruction IO is real.
// For ASAR installs use ELECTRON_RUN_AS_NODE=1 and an Electron Node carrier:
// <carrier> --expose-internals scripts/verify-runtime.mjs <absolute runtime root>
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const runtime=process.argv[2];
if(!runtime) throw new Error('Pass the installed DSH runtime root as the first argument');
const resource=pkg=>pathToFileURL(join(resolve(runtime),'node_modules','@deepseek-ai',pkg,'lib','index.js')).href;
const load=pkg=>import(resource(pkg));
const [{Context},{default:Sessions},{default:Projections},{default:Titles},{default:SystemPrompt},{default:WorkingDirectory},plugin]=await Promise.all([
 load('cordis'),load('dsh-session'),load('dsh-session-projection'),load('dsh-session-title'),load('dsh-system-prompt'),load('dsh-working-directory'),import('../index.js'),
]);
// A checkout is outside the profile's resolver. Map this one in-box peer to the
// selected installation, as profile boot does for installed bundle peer imports.
const hook=registerHooks({resolve(specifier,context,next){return next(specifier==='@deepseek-ai/dsh-agent-instructions'?resource('dsh-agent-instructions'):specifier,context);}});
const home=await mkdtemp(join(tmpdir(),'session-title-agents-runtime-'));
const previous=Object.fromEntries(['DSH_PROFILE_DIR','DSH_HOME','DSH_AGENTS_HOME'].map(key=>[key,process.env[key]]));
process.env.DSH_PROFILE_DIR=join(home,'profile');
process.env.DSH_HOME=join(home,'harness');
process.env.DSH_AGENTS_HOME=join(home,'shared');
const cwd=join(home,'project','sub');
const original=join(home,'original');
const ctx=new Context();
let calls=0;
try{
 for(const directory of [process.env.DSH_HOME,process.env.DSH_AGENTS_HOME,join(home,'project','.git'),cwd,original]) await mkdir(directory,{recursive:true});
 await writeFile(join(process.env.DSH_HOME,'AGENTS.md'),'# 会话命名规则\nGlobalNamingMarker。\n# 工程实践\nGLOBAL_ENGINEERING_MUST_NOT_APPEAR');
 await writeFile(join(process.env.DSH_AGENTS_HOME,'AGENTS.md'),'# Session titles\nSharedNamingMarker.\n# Engineering\nSHARED_ENGINEERING_MUST_NOT_APPEAR');
 await writeFile(join(home,'project','AGENTS.md'),'# Session naming\nProjectNamingMarker.\n## Wording\nUse API nouns.\n# Engineering\nPROJECT_ENGINEERING_MUST_NOT_APPEAR');
 await writeFile(join(cwd,'AGENTS.local.md'),'# Conversation titles\nLocalNamingMarker.');
 await writeFile(join(original,'AGENTS.md'),'# Session naming\nWRONG_DIRECTORY_MUST_NOT_APPEAR');
 await ctx.plugin(Sessions);await ctx.plugin(Projections);await ctx.plugin(SystemPrompt,{});
 // The getter/projection is real. No filesystem operation is requested of this
 // unused provider; discovery below uses the SDK's host-visible helper.
 ctx.provide('fs',{});
 await ctx.plugin(WorkingDirectory,{defaultDirectory:original});
 ctx.provide('llm',{async prepareCall(config){return{config,async *stream(options){
  calls++;
  for(const marker of ['GlobalNamingMarker','SharedNamingMarker','ProjectNamingMarker','LocalNamingMarker']) assert.ok(options.system.includes(marker),marker);
  assert.ok(options.system.indexOf('GlobalNamingMarker')<options.system.indexOf('ProjectNamingMarker'));
  assert.ok(options.system.indexOf('ProjectNamingMarker')<options.system.indexOf('LocalNamingMarker'));
  assert.ok(!options.system.includes('ENGINEERING_MUST_NOT_APPEAR'));
  assert.ok(!options.system.includes('WRONG_DIRECTORY_MUST_NOT_APPEAR'));
  yield{type:'text-delta',index:0,text:'[0101][修复] 排查登录失败'};yield{type:'finish',reason:{kind:'stop'}};
 }};}});
 await ctx.plugin(Titles,{fallbackMaxWords:8,fallbackMaxBytes:96,maxTitleBytes:120});
 const installed=ctx.plugin(plugin,{provider:'fixture',model:'fixture'});await installed;
 const owner='session-title-agents:coordination';
 assert.ok((await ctx.systemPrompt.assemble()).sections.some(section=>section.name===owner));
 const session=ctx.sessions.create('contract-fixture',{meta:{createdAt:Date.UTC(2026,9,24,17,30),cwd:original}});
 session.append('working-directory/change',{cwd});
 assert.equal(ctx.workingDirectory.get(session),cwd);
 session.append('user/message',{content:[{type:'text',text:'修复登录失败'}],source:{kind:'user'}},{surfaceOp:'append'});
 const result=await ctx.sessionTitle.refresh(session);
 assert.equal(result.title,'[1025][修复] 排查登录失败');assert.equal(result.source.provider,plugin.name);assert.equal(calls,1);
 const auxiliary=session.snapshotEvents().find(event=>event.type==='session/title-llm-request');
 assert.ok(auxiliary);assert.equal(auxiliary.data.titleProvider,plugin.name);assert.equal(auxiliary.data.messages[0].source.kind,plugin.name);
 const unchanged=await ctx.sessionTitle.refresh(session);assert.equal(unchanged.title,result.title);assert.equal(calls,1);
 ctx.sessionTitle.rename(session,'manual title');
 session.append('user/message',{content:[{type:'text',text:'继续'}],source:{kind:'user'}},{surfaceOp:'append'});
 assert.equal(ctx.sessionTitle.get(session).title,'manual title');assert.equal(calls,1);
 await installed.dispose();
 assert.ok(!(await ctx.systemPrompt.assemble()).sections.some(section=>section.name===owner));
 console.log('Installed Harness contract: PASS (real instruction discovery, working directory, SystemPrompt, SessionStore, title service and disposal; LLM adapter stubbed)');
}finally{
 await ctx.fiber.dispose();hook.deregister();
 for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 await rm(home,{recursive:true,force:true});
}
