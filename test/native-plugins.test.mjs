import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { installNativePlugin, validateNativePluginPackage, listNativePlugins, uninstallNativePlugin } from '../src/native-plugins.mjs';
import { loadEnabledPlugins, pluginCommands, pluginSkills, pluginAgents, pluginHooks, pluginMcpServers } from '../src/claude-plugins.mjs';

async function setup(t) {
  const home=await mkdtemp(path.join(os.tmpdir(),'oasis-native-plugin-home-'));
  const root=path.join(home,'workspace'), pkg=path.join(home,'plugin-source');
  await mkdir(root,{recursive:true}); await mkdir(pkg,{recursive:true});
  const env={...process.env,HOME:home,OASIS_CONFIG_DIR:path.join(home,'.config','oasis')};
  t.after(()=>rm(home,{recursive:true,force:true}));
  return {home,root,pkg,env};
}
async function writePackage(pkg,{version='1.0.0',permissions=['commands','skills','agents','hooks','mcp'],subagents=false,minimumOasisVersion='0.3.0'}={}) {
  const entries={};
  const manifest={schemaVersion:1,name:'review-helper',version,description:'A local review helper plugin.',author:'Oasis Test Suite',license:'MIT',minimumOasisVersion,permissions,metadata:{owner:'test'}};
  if(permissions.includes('commands')) {
    entries['commands/review.md']='Review the changes; preserve all project rules.\n';
    manifest.commands={review:{source:'commands/review.md',description:'Review a diff'}};
  }
  if(permissions.includes('skills')) {
    entries['skills/review/SKILL.md']='---\nname: review\ndescription: review changes\n---\nUse evidence and tests.\n';
    manifest.skills=['skills/review'];
  }
  if(permissions.includes('agents')||permissions.includes('subagents')) {
    const directory=subagents?'subagents':'agents';
    entries[directory+'/reviewer.md']='Review source code safely.\n';
    manifest[subagents?'subagents':'agents']=[directory+'/reviewer.md'];
  }
  if(permissions.includes('hooks')) {
    entries['hooks/hooks.json']=JSON.stringify({hooks:{PreToolUse:[]}});
    manifest.hooks='hooks/hooks.json';
  }
  if(permissions.includes('mcp')) {
    entries['.mcp.json']=JSON.stringify({mcpServers:{example:{command:'node',args:['${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs']}}});
    entries['mcp/server.mjs']='// local bundled MCP server source; activated only with the explicit mcp permission\n';
    manifest.mcpServers='.mcp.json';
    manifest.mcpFiles=['mcp/server.mjs'];
  }
  for(const file of Object.keys(entries)){await mkdir(path.dirname(path.join(pkg,file)),{recursive:true});await writeFile(path.join(pkg,file),entries[file]);}
  await writeFile(path.join(pkg,'plugin.json'),JSON.stringify(manifest,null,2));
}
test('native plugin validates and installs only explicitly granted capabilities',async t=>{
  const {root,pkg,env}=await setup(t);await writePackage(pkg);
  const validated=await validateNativePluginPackage(pkg);assert.equal(validated.name,'review-helper');assert.equal(validated.components.commands[0],'review');
  const installed=await installNativePlugin(pkg,{env,grantedPermissions:['commands','skills']});
  assert.equal(installed.installed,true);assert.deepEqual(installed.grantedPermissions,['commands','skills']);
  assert.ok(await readFile(path.join(installed.installPath,'commands/review.md'),'utf8'));
  await assert.rejects(readFile(path.join(installed.installPath,'agents/reviewer.md'),'utf8'),/ENOENT/);
  await assert.rejects(readFile(path.join(installed.installPath,'hooks/hooks.json'),'utf8'),/ENOENT/);
  await assert.rejects(readFile(path.join(installed.installPath,'.mcp.json'),'utf8'),/ENOENT/);
  await assert.rejects(readFile(path.join(installed.installPath,'mcp/server.mjs'),'utf8'),/ENOENT/);
  const enabled=await loadEnabledPlugins(root,{env});const plugin=enabled.find(item=>item.id==='review-helper@oasis-native');
  assert.ok(plugin);assert.deepEqual((await pluginCommands([plugin],{env,root})).map(item=>item.name),['review-helper:review']);
  assert.equal((await pluginSkills([plugin])).length,1);assert.equal((await pluginAgents([plugin])).length,0);
  assert.equal((await pluginHooks([plugin],{env,root})).length,0);assert.equal((await pluginMcpServers([plugin],{env,root})).length,0);
  assert.equal((await listNativePlugins({env})).length,1);
});

test('native plugin manifest requires author, license, and a compatible minimum Oasis version',async t=>{
  const {pkg}=await setup(t);await writePackage(pkg,{permissions:['commands']});
  const manifestPath=path.join(pkg,'plugin.json');
  const valid=JSON.parse(await readFile(manifestPath,'utf8'));
  delete valid.author;await writeFile(manifestPath,JSON.stringify(valid));
  await assert.rejects(validateNativePluginPackage(pkg),/author is required/i);
  valid.author='Oasis Test Suite';delete valid.license;await writeFile(manifestPath,JSON.stringify(valid));
  await assert.rejects(validateNativePluginPackage(pkg),/license is required/i);
  valid.license='MIT';valid.minimumOasisVersion='999.0.0';await writeFile(manifestPath,JSON.stringify(valid));
  await assert.rejects(validateNativePluginPackage(pkg),/requires Oasis 999.0.0 or newer/i);
  valid.minimumOasisVersion='0.3.0';await writeFile(manifestPath,JSON.stringify(valid));
  const checked=await validateNativePluginPackage(pkg);
  assert.equal(checked.author,'Oasis Test Suite');
  assert.equal(checked.license,'MIT');
  assert.equal(checked.minimumOasisVersion,'0.3.0');
});

test('native plugin accepts subagents manifest paths and requires the explicit subagents grant',async t=>{
  const {root,pkg,env}=await setup(t);await writePackage(pkg,{permissions:['subagents'],subagents:true});
  const checked=await validateNativePluginPackage(pkg);
  assert.deepEqual(checked.components.agents,['subagents/reviewer.md']);
  const installed=await installNativePlugin(pkg,{env,grantedPermissions:['subagents']});
  const plugins=await loadEnabledPlugins(root,{env});
  const plugin=plugins.find(item=>item.id==='review-helper@oasis-native');
  assert.ok(plugin);
  assert.equal((await pluginAgents([plugin])).length,1);
  assert.ok(await readFile(path.join(installed.installPath,'subagents/reviewer.md'),'utf8'));
});

test('native plugin install requires explicit grants, rejects conflicts and unknown permissions',async t=>{
  const {pkg,env}=await setup(t);await writePackage(pkg);
  await assert.rejects(installNativePlugin(pkg,{env}),/Explicit permissions are required/);
  await assert.rejects(installNativePlugin(pkg,{env,grantedPermissions:['network-root'] }),/Unknown permission/);
  await installNativePlugin(pkg,{env,grantedPermissions:['commands']});
  await assert.rejects(installNativePlugin(pkg,{env,grantedPermissions:['commands']}),/already installed/);
});

test('native plugin updates show permission diffs before writes and require explicit confirmation',async t=>{
  const {pkg,env}=await setup(t);await writePackage(pkg,{version:'1.0.0',permissions:['commands','skills']});
  const first=await installNativePlugin(pkg,{env,grantedPermissions:['commands']});assert.equal(first.installed,true);
  await writePackage(pkg,{version:'1.1.0',permissions:['commands','skills','agents']});
  const preview=await installNativePlugin(pkg,{env,update:true,grantedPermissions:['commands','agents']});
  assert.equal(preview.needsApproval,true);assert.deepEqual(preview.permissionDiff.added,['agents']);assert.deepEqual(preview.permissionDiff.removed,['skills']);
  assert.deepEqual(preview.permissionDiff.requestedAdded,['agents']);
  const still=await listNativePlugins({env});assert.equal(still[0].version,'1.0.0');
  const updated=await installNativePlugin(pkg,{env,update:true,grantedPermissions:['commands','agents'],acceptPermissionDiff:true});
  assert.equal(updated.version,'1.1.0');assert.deepEqual(updated.grantedPermissions,['commands','agents']);
});

test('native plugin rejects unsafe component paths and unrequested grants',async t=>{
  const {pkg,env}=await setup(t);await writePackage(pkg);
  const manifest=JSON.parse(await readFile(path.join(pkg,'plugin.json'),'utf8'));
  manifest.commands.review.source='../escape.md';await writeFile(path.join(pkg,'plugin.json'),JSON.stringify(manifest));
  await assert.rejects(validateNativePluginPackage(pkg),/unsafe path segment|relative POSIX path/);
  await writePackage(pkg,{permissions:['commands','skills','agents','hooks']});
  await assert.rejects(installNativePlugin(pkg,{env,grantedPermissions:['commands','mcp']}),/did not request the mcp permission/);
});

test('native plugin exposes granted agent definitions to the loader only when granted',async t=>{
  const {root,pkg,env}=await setup(t);await writePackage(pkg);
  await installNativePlugin(pkg,{env,grantedPermissions:['agents']});
  const plugins=await loadEnabledPlugins(root,{env});const plugin=plugins.find(item=>item.id==='review-helper@oasis-native');
  assert.ok(plugin);
  assert.deepEqual((await pluginAgents([plugin],{env,root})).map(agent=>agent.name),['review-helper:reviewer']);
  assert.equal((await pluginCommands([plugin],{env,root})).length,0);
  assert.equal((await pluginSkills([plugin])).length,0);
});

test('native plugin updates compare prerelease identifiers using semantic version ordering',async t=>{
  const {pkg,env}=await setup(t);
  await writePackage(pkg,{version:'1.0.0-beta.2',permissions:['commands']});
  await installNativePlugin(pkg,{env,grantedPermissions:['commands']});
  await writePackage(pkg,{version:'1.0.0-beta.10',permissions:['commands']});
  const prerelease=await installNativePlugin(pkg,{env,update:true,grantedPermissions:['commands']});
  assert.equal(prerelease.installed,true);
  assert.equal(prerelease.version,'1.0.0-beta.10');
  await writePackage(pkg,{version:'1.0.0',permissions:['commands']});
  const stable=await installNativePlugin(pkg,{env,update:true,grantedPermissions:['commands']});
  assert.equal(stable.installed,true);
  assert.equal(stable.version,'1.0.0');
  await writePackage(pkg,{version:'1.0.0-beta.99',permissions:['commands']});
  await assert.rejects(installNativePlugin(pkg,{env,update:true,grantedPermissions:['commands']}),/must increase the plugin version/);
  await writePackage(pkg,{version:'1.0.0-01',permissions:['commands']});
  await assert.rejects(validateNativePluginPackage(pkg),/semantic MAJOR\.MINOR\.PATCH/);
});

test('native plugin uninstall removes registry entry and local package',async t=>{
  const {pkg,env}=await setup(t);await writePackage(pkg);
  const result=await installNativePlugin(pkg,{env,grantedPermissions:['commands']});
  await uninstallNativePlugin('review-helper',{env});
  await assert.rejects(readFile(path.join(result.installPath,'plugin.json'),'utf8'),/ENOENT/);
  assert.deepEqual(await listNativePlugins({env}),[]);
});

test('granting MCP explicitly bundles server code and resolves its local path',async t=>{
  const {root,pkg,env}=await setup(t);await writePackage(pkg);
  const installed=await installNativePlugin(pkg,{env,grantedPermissions:['mcp']});
  assert.ok((await readFile(path.join(installed.installPath,'mcp/server.mjs'),'utf8')).includes('local bundled MCP server'));
  const plugins=await loadEnabledPlugins(root,{env});const plugin=plugins.find(item=>item.id==='review-helper@oasis-native');
  const [server]=await pluginMcpServers([plugin],{env,root});
  assert.match(server.mcpServers.example.args[0],/native-plugins[\\/]review-helper[\\/]mcp[\\/]server.mjs/);
  assert.equal((await pluginCommands([plugin],{env,root})).length,0);
});
