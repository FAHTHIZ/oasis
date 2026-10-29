import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createArtifact, recordArtifactEvent, readArtifact, listArtifacts, deleteArtifact, redactArtifactText, recordArtifactToolEvent } from '../src/artifacts.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function fixture(t) {
  const home=await mkdtemp(path.join(os.tmpdir(),'oasis-artifact-home-'));
  const root=path.join(home,'project'); await mkdir(root,{recursive:true});
  const env={...process.env,HOME:home,OASIS_CONFIG_DIR:path.join(home,'.config','oasis')};
  t.after(()=>rm(home,{recursive:true,force:true}));
  return {home,root,env};
}

test('artifact creation writes a local investigation page and structured state',async t=>{
  const {home,root,env}=await fixture(t);
  const result=await createArtifact(root,'API investigation',{env,goal:'Find why API calls time out'});
  assert.equal(result.artifact.slug,'api-investigation');
  assert.equal(result.artifact.goal,'Find why API calls time out');
  assert.ok(result.htmlPath.startsWith(path.join(home,'.config','oasis','artifacts')));
  assert.ok(result.fileUrl.startsWith('file:'));
  assert.match(await readFile(result.htmlPath,'utf8'),/API investigation/);
  assert.match(await readFile(result.htmlPath,'utf8'),/refresh" content="5"/);
  assert.equal((await stat(result.dataPath)).mode&0o777,0o600);
});

test('artifact updates capture every investigation section',async t=>{
  const {root,env}=await fixture(t); await createArtifact(root,'audit',{env});
  for(const type of ['timeline','command','file','test','error','hypothesis','rollback'])await recordArtifactEvent(root,'audit',type,type+' entry',{env});
  const {artifact}=await readArtifact(root,'audit',{env});
  assert.ok(artifact.timeline.some(x=>/created/.test(x.text)));
  for(const [key,type] of [['commands','command'],['changedFiles','file'],['tests','test'],['errors','error'],['hypotheses','hypothesis'],['rollbackPoints','rollback']])assert.ok(artifact[key].some(x=>x.text===type+' entry'),key);
});

test('artifact redacts credentials from persisted JSON, HTML, and displayed details',async t=>{
  const {root,env}=await fixture(t);
  const result=await createArtifact(root,'secret-check',{env,goal:'Use api_key=sk-supersecretvalue123456789012'});
  await recordArtifactEvent(root,'secret-check','command','curl https://example.test/?token=abcdef123456789',{env});
  const raw=await readFile(result.dataPath,'utf8'); const html=await readFile(result.htmlPath,'utf8');
  assert.doesNotMatch(raw,/sk-supersecretvalue123456789012|abcdef123456789/);
  assert.doesNotMatch(html,/sk-supersecretvalue123456789012|abcdef123456789/);
  assert.match(raw,/REDACTED/); assert.match(redactArtifactText('Authorization: Bearer abcdefghijklmnop'),/REDACTED/);
});

test('artifact tool events collect commands, changed files, tests, and errors',async t=>{
  const {root,env}=await fixture(t); await createArtifact(root,'auto',{env});
  await recordArtifactToolEvent(root,'auto','run_command',{command:'npm test'},{exitCode:1,output:'AssertionError'},{env});
  await recordArtifactToolEvent(root,'auto','write_file',{path:'src/index.mjs'},{success:true},{env});
  const {artifact}=await readArtifact(root,'auto',{env});
  assert.match(artifact.commands[0].text,/npm test/);
  assert.match(artifact.tests[0].text,/FAILED/);
  assert.match(artifact.errors[0].text,/AssertionError/);
  assert.match(artifact.changedFiles[0].text,/src\/index.mjs/);
});

test('artifact list and cleanup are workspace-scoped',async t=>{
  const {root,env}=await fixture(t); await createArtifact(root,'keep',{env}); await createArtifact(root,'remove',{env});
  assert.deepEqual((await listArtifacts(root,{env})).map(x=>x.slug).sort(),['keep','remove']);
  await deleteArtifact(root,'remove',{env});
  assert.equal(await readArtifact(root,'remove',{env}),null);
  assert.deepEqual((await listArtifacts(root,{env})).map(x=>x.slug),['keep']);
});

test('/artifact creates, records, lists, and deletes through the slash interface',async t=>{
  const {root,env}=await fixture(t); const session={root,messages:[{role:'system',content:'Project rules stay here.'}]}; const sessionOptions={};
  const created=await runBuiltinCommand('artifact','review-api Inspect API timeout behavior',{root,env,session,sessionOptions});
  assert.match(created.output,/file:/); assert.equal(session.activeArtifact,'review-api');
  await runBuiltinCommand('artifact','add review-api hypothesis Retry exhaustion may be the cause',{root,env,session,sessionOptions});
  const listed=await runBuiltinCommand('artifact','list',{root,env,session,sessionOptions});
  assert.match(listed.output,/review-api/);
  const removed=await runBuiltinCommand('artifact','delete review-api',{root,env,session,sessionOptions});
  assert.match(removed.output,/deleted/); assert.equal(session.activeArtifact,null);
});
