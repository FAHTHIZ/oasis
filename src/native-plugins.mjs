import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, lstat, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { pluginHome, readInstalledPlugins } from './claude-plugins.mjs';
import { userSettingsPath } from './settings.mjs';

const CAPABILITIES = new Set(['commands','skills','agents','subagents','hooks','mcp']);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPONENT_BYTES = 256 * 1024;
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function safeRelative(input, label) {
  if (typeof input !== 'string' || !input || input.includes('\\') || path.posix.isAbsolute(input)) throw new Error(label + ' must be a relative POSIX path.');
  const parts=input.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'))throw new Error(label+' contains an unsafe path segment.');
  return parts.join('/');
}
function within(root,target) {
  const relative=path.relative(root,target);
  return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));
}
async function readJsonSafe(file, fallback=null) {
  let info;
  try{info=await lstat(file);}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_MANIFEST_BYTES)throw new Error('Refusing unsafe or oversized JSON file: '+file);
  try{return JSON.parse(await readFile(file,'utf8'));}catch(error){throw new Error('Invalid JSON in '+file+': '+error.message);}
}
async function atomicWrite(file,text) {
  await mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,text,{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temp,file);}
  finally{await unlink(temp).catch(()=>{});}
}
async function readPackageFile(root, relative, label) {
  const rel=safeRelative(relative,label);
  const file=path.resolve(root,...rel.split('/'));
  if(!within(root,file))throw new Error(label+' escapes the package root.');
  let cursor=root;
  for(const part of rel.split('/')) {
    cursor=path.join(cursor,part);
    const partInfo=await lstat(cursor);
    if(partInfo.isSymbolicLink())throw new Error(label+' path must not contain symbolic links.');
  }
  const real=await realpath(file);
  if(!within(root,real))throw new Error(label+' resolves outside the package root.');
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink())throw new Error(label+' must be a regular, non-symlink file.');
  if(info.size>MAX_COMPONENT_BYTES)throw new Error(label+' exceeds the 256 KiB component size limit.');
  const text=await readFile(file,'utf8');
  if(text.includes('\0'))throw new Error(label+' contains a NUL byte.');
  return {relative:rel,text};
}
async function validatePackage(source) {
  const requestedRoot=path.resolve(source);
  const sourceInfo=await lstat(requestedRoot);
  if(!sourceInfo.isDirectory()||sourceInfo.isSymbolicLink())throw new Error('Plugin package source must be a real local directory, not a symlink.');
  const root=await realpath(requestedRoot);
  const info=await lstat(root);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Plugin package source must be a real local directory.');
  const manifestFile=path.join(root,'plugin.json');
  const manifestInfo=await lstat(manifestFile).catch(error=>{if(error.code==='ENOENT')throw new Error('Plugin package is missing root plugin.json.');throw error;});
  if(!manifestInfo.isFile()||manifestInfo.isSymbolicLink()||manifestInfo.size>MAX_MANIFEST_BYTES)throw new Error('plugin.json must be a regular JSON file no larger than 1 MiB.');
  let manifest;
  try{manifest=JSON.parse(await readFile(manifestFile,'utf8'));}catch(error){throw new Error('Invalid plugin.json: '+error.message);}
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)||manifest.schemaVersion!==1)throw new Error('plugin.json needs schemaVersion: 1.');
  if(typeof manifest.name!=='string'||!PLUGIN_NAME.test(manifest.name))throw new Error('Plugin name must be lowercase kebab-case (max 63 characters).');
  if(typeof manifest.version!=='string'||!validVersion(manifest.version))throw new Error('Plugin version must be semantic MAJOR.MINOR.PATCH.');
  if(typeof manifest.description!=='string'||!manifest.description.trim()||manifest.description.length>500)throw new Error('Plugin description is required and limited to 500 characters.');
  if(typeof manifest.author!=='string'||!manifest.author.trim()||manifest.author.trim().length>200)throw new Error('Plugin author is required and limited to 200 characters.');
  if(typeof manifest.license!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.+() -]{0,79}$/.test(manifest.license.trim()))throw new Error('Plugin license is required and must be a short SPDX identifier or expression.');
  if(typeof manifest.minimumOasisVersion!=='string'||!validVersion(manifest.minimumOasisVersion))throw new Error('minimumOasisVersion must be a semantic MAJOR.MINOR.PATCH version.');
  const runtimePackage=JSON.parse(await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),'..','package.json'),'utf8'));
  if(compareVersion(manifest.minimumOasisVersion,runtimePackage.version)>0)throw new Error('This plugin requires Oasis '+manifest.minimumOasisVersion+' or newer; this installation is '+runtimePackage.version+'.');
  if(!Array.isArray(manifest.permissions)||manifest.permissions.some(p=>!CAPABILITIES.has(p))||new Set(manifest.permissions.map(p=>p==='subagents'?'agents':p)).size!==manifest.permissions.length)throw new Error('permissions must be a unique array of commands, skills, agents/subagents, hooks, and/or mcp.');
  if(manifest.agents!==undefined&&manifest.subagents!==undefined)throw new Error('Use either agents or subagents, not both.');
  const files=new Map();
  const components={commands:[],skills:[],agents:[],hooks:null,hookFiles:[],mcp:null,mcpFiles:[]};
  const addFile=async(rel,label,prefixes)=>{
    const value=safeRelative(rel,label);
    if(!prefixes.some(prefix=>value.startsWith(prefix)))throw new Error(label+' must be inside '+prefixes.join(' or ')+'.');
    const file=await readPackageFile(root,value,label);
    files.set(file.relative,file.text);
    return file;
  };
  if(manifest.commands!==undefined){
    if(!manifest.commands||typeof manifest.commands!=='object'||Array.isArray(manifest.commands))throw new Error('commands must be an object keyed by command name.');
    for(const [name,spec] of Object.entries(manifest.commands)){
      if(!COMMAND_NAME.test(name)||!spec||typeof spec!=='object'||typeof spec.source!=='string')throw new Error('Each command needs a safe kebab-case name and source path.');
      const file=await addFile(spec.source,'Command '+name,['commands/']);
      if(!file.relative.toLowerCase().endsWith('.md'))throw new Error('Command files must be Markdown.');
      components.commands.push({name,source:file.relative,description:String(spec.description||'').slice(0,200),argumentHint:String(spec.argumentHint||'').slice(0,120)});
    }
  }
  if(manifest.skills!==undefined){
    if(!Array.isArray(manifest.skills))throw new Error('skills must be an array of skill directories.');
    for(const dir of manifest.skills){
      const rel=safeRelative(dir,'Skill directory');
      if(!rel.startsWith('skills/'))throw new Error('Skill directories must be under skills/.');
      const file=await addFile(rel+'/SKILL.md','Skill '+rel,['skills/']);
      components.skills.push(rel);
    }
  }
  if(manifest.agents!==undefined||manifest.subagents!==undefined){
    const field=manifest.subagents!==undefined?'subagents':'agents';
    const prefix=field==='subagents'?'subagents/':'agents/';
    const entries=manifest[field];
    if(!Array.isArray(entries))throw new Error(field+' must be an array of Markdown file paths.');
    for(const rel of entries){
      const file=await addFile(rel,'Agent definition',[prefix]);
      if(!file.relative.toLowerCase().endsWith('.md'))throw new Error('Agent definitions must be Markdown.');
      components.agents.push(file.relative);
    }
  }
  if(manifest.hooks!==undefined){
    const file=await addFile(manifest.hooks,'Hook configuration',['hooks/']);
    let data;try{data=JSON.parse(file.text);}catch{throw new Error('Hook configuration must be valid JSON.');}
    if(!data||typeof data!=='object'||Array.isArray(data)||!data.hooks||typeof data.hooks!=='object'||Array.isArray(data.hooks))throw new Error('Hook configuration must have a hooks object.');
    components.hooks=file.relative;
  }
  if(manifest.hookFiles!==undefined){
    if(!Array.isArray(manifest.hookFiles))throw new Error('hookFiles must be an array of files under hooks/.');
    for(const rel of manifest.hookFiles)components.hookFiles.push((await addFile(rel,'Hook support file',['hooks/'])).relative);
  }
  if(manifest.mcpServers!==undefined){
    const rel=safeRelative(manifest.mcpServers,'MCP server manifest');
    if(!['.mcp.json','mcp.json'].includes(rel))throw new Error('MCP server manifest must be .mcp.json or mcp.json.');
    const file=await readPackageFile(root,rel,'MCP server manifest');
    let data;try{data=JSON.parse(file.text);}catch{throw new Error('MCP server manifest must be valid JSON.');}
    const servers=data&&data.mcpServers&&typeof data.mcpServers==='object'?data.mcpServers:data;
    if(!servers||typeof servers!=='object'||Array.isArray(servers))throw new Error('MCP server manifest must contain a server map.');
    for(const [name,spec] of Object.entries(servers))if(!/^[a-zA-Z0-9_-]{1,64}$/.test(name)||!spec||typeof spec!=='object')throw new Error('MCP server manifest contains an invalid server entry.');
    files.set(rel,file.text);
    components.mcp=rel;
  }
  if(manifest.mcpFiles!==undefined){
    if(!Array.isArray(manifest.mcpFiles))throw new Error('mcpFiles must be an array of bundled server files under mcp/.');
    for(const rel of manifest.mcpFiles)components.mcpFiles.push((await addFile(rel,'MCP server support file',['mcp/'])).relative);
  }
  const declared={commands:components.commands.length>0,skills:components.skills.length>0,agents:components.agents.length>0,hooks:Boolean(components.hooks)||components.hookFiles.length>0,mcp:Boolean(components.mcp)||components.mcpFiles.length>0};
  for(const [capability,used] of Object.entries(declared))if(used&&!manifest.permissions.includes(capability)&&!(capability==='agents'&&manifest.permissions.includes('subagents')))throw new Error('plugin.json uses '+(capability==='agents'?'agents/subagents':capability)+' but does not request that permission.');
  return {root,manifest,files,components,declared};
}
function validVersion(version) {
  const match = VERSION.exec(version);
  if (!match) return false;
  const prerelease = match[4];
  return !prerelease || prerelease.split('.').every((identifier) =>
    !/^\d+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0')
  );
}
function parseVersion(version) {
  const [core, prerelease] = String(version).split('-', 2);
  return {
    core: core.split('.').map(Number),
    prerelease: prerelease === undefined ? null : prerelease.split('.')
  };
}
function comparePrereleaseIdentifier(a, b) {
  if (a === b) return 0;
  const aNumeric = /^\d+$/.test(a), bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const left = BigInt(a), right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : 1;
}
function compareVersion(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] > right.core[i]) return 1;
    if (left.core[i] < right.core[i]) return -1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const count = Math.min(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < count; i++) {
    const compared = comparePrereleaseIdentifier(left.prerelease[i], right.prerelease[i]);
    if (compared !== 0) return compared;
  }
  return left.prerelease.length < right.prerelease.length ? -1 : left.prerelease.length > right.prerelease.length ? 1 : 0;
}
function registryPath(env){return path.join(pluginHome(env),'installed_plugins.json');}
function nativeRoot(env){return path.join(getConfigDirectory(env),'native-plugins');}
async function readRegistry(env){const plugins=await readInstalledPlugins(env);return {...plugins};}
async function writeRegistry(env,plugins){await atomicWrite(registryPath(env),JSON.stringify({version:1,plugins},null,2)+'\n');}
async function updateUserEnablement(env,id,enable){
  const file=userSettingsPath(env);
  const data=await readJsonSafe(file,{});
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('User settings must be a JSON object to enable native plugins safely.');
  data.enabledPlugins=data.enabledPlugins&&typeof data.enabledPlugins==='object'&&!Array.isArray(data.enabledPlugins)?data.enabledPlugins:{};
  if(enable)data.enabledPlugins[id]=true;else delete data.enabledPlugins[id];
  await atomicWrite(file,JSON.stringify(data,null,2)+'\n');
}
function compatibilityManifest(manifest,grants,components){
  const allowed=new Set(grants);
  const out={name:manifest.name,version:manifest.version,description:manifest.description,defaultEnabled:true};
  if(allowed.has('commands'))out.commands=Object.fromEntries(components.commands.map(command=>[command.name,{source:command.source,description:command.description,argumentHint:command.argumentHint}]));
  if(allowed.has('skills'))out.skills=components.skills;
  if(allowed.has('agents')||allowed.has('subagents'))out.agents=components.agents;
  if(allowed.has('hooks')&&components.hooks)out.hooks=components.hooks;
  if(allowed.has('mcp')&&components.mcp)out.mcpServers=components.mcp;
  return out;
}
function filesForGrants(validated,grants){
  const allowed=new Set(grants),result=new Map([['plugin.json',JSON.stringify(validated.manifest,null,2)+'\n']]);
  for(const component of validated.components.commands)if(allowed.has('commands'))result.set(component.source,validated.files.get(component.source));
  for(const dir of validated.components.skills)if(allowed.has('skills'))result.set(dir+'/SKILL.md',validated.files.get(dir+'/SKILL.md'));
  for(const rel of validated.components.agents)if(allowed.has('agents')||allowed.has('subagents'))result.set(rel,validated.files.get(rel));
  if(allowed.has('hooks')){if(validated.components.hooks)result.set(validated.components.hooks,validated.files.get(validated.components.hooks));for(const rel of validated.components.hookFiles)result.set(rel,validated.files.get(rel));}
  if(allowed.has('mcp')){if(validated.components.mcp)result.set(validated.components.mcp,validated.files.get(validated.components.mcp));for(const rel of validated.components.mcpFiles)result.set(rel,validated.files.get(rel));}
  return result;
}
async function buildStage(validated,target,grants,env){
  const stage=target+'.staging-'+randomUUID();
  await mkdir(stage,{recursive:true,mode:0o700});
  try{
    const files=filesForGrants(validated,grants);
    for(const [rel,content] of files){
      const dest=path.resolve(stage,...safeRelative(rel,'Plugin file').split('/'));
      if(!within(stage,dest))throw new Error('Plugin component escapes staging directory.');
      await mkdir(path.dirname(dest),{recursive:true,mode:0o700});
      await writeFile(dest,content,{encoding:'utf8',mode:0o600,flag:'wx'});
    }
    const compat=path.join(stage,'.claude-plugin','plugin.json');
    await mkdir(path.dirname(compat),{recursive:true,mode:0o700});
    await writeFile(compat,JSON.stringify(compatibilityManifest(validated.manifest,grants,validated.components),null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    const meta={schemaVersion:1,name:validated.manifest.name,version:validated.manifest.version,description:validated.manifest.description,author:validated.manifest.author,license:validated.manifest.license,minimumOasisVersion:validated.manifest.minimumOasisVersion,requestedPermissions:validated.manifest.permissions,grantedPermissions:grants,metadata:validated.manifest.metadata&&typeof validated.manifest.metadata==='object'?validated.manifest.metadata:{}};
    await writeFile(path.join(stage,'.oasis-native-installed.json'),JSON.stringify(meta,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
    return stage;
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
async function replaceDirectory(stage,target,updating){
  let backup=null;
  if(updating){
    const info=await lstat(target);
    if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Refusing to replace a non-directory or symlink plugin target.');
    backup=target+'.backup-'+randomUUID();
    await rename(target,backup);
  }else{
    try{await lstat(target);throw new Error('Plugin destination already exists. Refusing to overwrite an unregistered directory.');}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  try{await rename(stage,target);return backup;}
  catch(error){if(backup)await rename(backup,target).catch(()=>{});throw error;}
}
export async function validateNativePluginPackage(source){
  const pkg=await validatePackage(source);
  return {name:pkg.manifest.name,version:pkg.manifest.version,description:pkg.manifest.description,author:pkg.manifest.author,license:pkg.manifest.license,minimumOasisVersion:pkg.manifest.minimumOasisVersion,requestedPermissions:pkg.manifest.permissions,components:{commands:pkg.components.commands.map(x=>x.name),skills:pkg.components.skills,agents:pkg.components.agents,hooks:pkg.components.hooks?1:0,hookFiles:pkg.components.hookFiles,mcpServers:pkg.components.mcp?Object.keys(JSON.parse(pkg.files.get(pkg.components.mcp)).mcpServers||{}):[],mcpFiles:pkg.components.mcpFiles},metadata:pkg.manifest.metadata||{}};
}
export async function installNativePlugin(source,options={}){
  const env=options.env||process.env;
  if(!Array.isArray(options.grantedPermissions))throw new Error('Explicit permissions are required. Pass grantedPermissions as the user-approved capability list.');
  const grants=[...new Set(options.grantedPermissions)];
  if(grants.some(p=>!CAPABILITIES.has(p)))throw new Error('Unknown permission requested. Allowed capabilities: '+[...CAPABILITIES].join(', ')+'.');
  const validated=await validatePackage(source);
  for(const grant of grants)if(!validated.manifest.permissions.includes(grant))throw new Error('Plugin did not request the '+grant+' permission; refusing an implicit grant.');
  const id=validated.manifest.name+'@oasis-native';
  const registry=await readRegistry(env);
  const sameName=Object.entries(registry).filter(([key])=>key.split('@')[0]===validated.manifest.name);
  const current=registry[id];
  if(sameName.some(([key])=>key!==id))throw new Error('Plugin namespace conflict: '+sameName.map(([key])=>key).join(', ')+'. Uninstall or rename the conflicting plugin first.');
  const update=options.update===true;
  if(current&&!update)throw new Error('Plugin '+validated.manifest.name+' is already installed. Use update to replace it.');
  if(!current&&update)throw new Error('Plugin '+validated.manifest.name+' is not installed; use install first.');
  const target=path.join(nativeRoot(env),validated.manifest.name);
  let previousMeta=null;
  if(current){
    previousMeta=await readJsonSafe(path.join(current.installPath,'.oasis-native-installed.json'),null);
    if(!previousMeta||previousMeta.name!==validated.manifest.name)throw new Error('Installed native plugin metadata is missing or invalid.');
    if(compareVersion(validated.manifest.version,previousMeta.version)<=0)throw new Error('An update must increase the plugin version beyond '+previousMeta.version+'.');
    const previous=new Set(previousMeta.grantedPermissions||[]);
    const next=new Set(grants);
    const oldRequested=new Set(previousMeta.requestedPermissions||[]);
    const requested=new Set(validated.manifest.permissions);
    const diff={
      added:[...next].filter(p=>!previous.has(p)).sort(),
      removed:[...previous].filter(p=>!next.has(p)).sort(),
      requestedAdded:[...requested].filter(p=>!oldRequested.has(p)).sort(),
      requestedRemoved:[...oldRequested].filter(p=>!requested.has(p)).sort()
    };
    const changed=Object.values(diff).some(items=>items.length);
    if(changed&&options.acceptPermissionDiff!==true)return {installed:false,needsApproval:true,id,fromVersion:previousMeta.version,toVersion:validated.manifest.version,permissionDiff:diff,grants};
  }
  for(const recordPath of validated.files.keys())if(recordPath==='plugin.json')continue;
  const nativeDir=nativeRoot(env);
  await mkdir(nativeDir,{recursive:true,mode:0o700});
  const nativeInfo=await lstat(nativeDir);
  if(!nativeInfo.isDirectory()||nativeInfo.isSymbolicLink())throw new Error('Refusing to install through an unsafe native plugin directory.');
  const stage=await buildStage(validated,target,grants,env);
  const oldRegistry={...registry};
  let backup=null,swapped=false;
  try{
    backup=await replaceDirectory(stage,target,Boolean(current));swapped=true;
    registry[id]={...(current||{}),installPath:target,version:validated.manifest.version,source:'oasis-native',grantedPermissions:grants};
    await writeRegistry(env,registry);
    await updateUserEnablement(env,id,true);
    if(backup)await rm(backup,{recursive:true,force:true});
  }catch(error){
    if(swapped){await rm(target,{recursive:true,force:true}).catch(()=>{});if(backup)await rename(backup,target).catch(()=>{});}
    await writeRegistry(env,oldRegistry).catch(()=>{});
    await rm(stage,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
  return {installed:true,id,name:validated.manifest.name,version:validated.manifest.version,author:validated.manifest.author,license:validated.manifest.license,minimumOasisVersion:validated.manifest.minimumOasisVersion,installPath:target,grantedPermissions:grants,requestedPermissions:validated.manifest.permissions,components:{commands:grants.includes('commands')?validated.components.commands.map(x=>validated.manifest.name+':'+x.name):[],skills:grants.includes('skills')?validated.components.skills:[],agents:grants.includes('agents')?validated.components.agents:[],hooks:grants.includes('hooks')?validated.components.hooks:null,hookFiles:grants.includes('hooks')?validated.components.hookFiles:[],mcpServers:grants.includes('mcp')?validated.components.mcp:null,mcpFiles:grants.includes('mcp')?validated.components.mcpFiles:[]}};
}
export async function uninstallNativePlugin(name,options={}){
  const env=options.env||process.env;
  const slug=String(name||'').toLowerCase().replace(/@oasis-native$/,'');
  if(!PLUGIN_NAME.test(slug))throw new Error('Invalid native plugin name.');
  const id=slug+'@oasis-native';
  const registry=await readRegistry(env);
  const entry=registry[id];
  if(!entry||entry.source!=='oasis-native')throw new Error('Native plugin '+slug+' is not installed.');
  const root=await realpath(nativeRoot(env)).catch(()=>path.resolve(nativeRoot(env)));
  const target=path.resolve(entry.installPath);
  if(!within(root,target)||target===root)throw new Error('Refusing to remove a plugin outside the native plugin directory.');
  const info=await lstat(target);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Refusing to remove an unsafe plugin directory.');
  await rm(target,{recursive:true,force:true});
  delete registry[id];
  await writeRegistry(env,registry);
  await updateUserEnablement(env,id,false);
  return {name:slug,id};
}
export async function listNativePlugins(options={}){
  const env=options.env||process.env;
  const registry=await readRegistry(env);
  const out=[];
  for(const [id,record] of Object.entries(registry)){
    if(record.source!=='oasis-native')continue;
    const meta=await readJsonSafe(path.join(record.installPath,'.oasis-native-installed.json'),null).catch(()=>null);
    if(meta)out.push({id,name:meta.name,version:meta.version,grantedPermissions:meta.grantedPermissions,requestedPermissions:meta.requestedPermissions});
  }
  return out.sort((a,b)=>a.name.localeCompare(b.name));
}
export function parseNativePluginPackageArguments(argument,root){
  const tokens=String(argument||'').trim().split(/\s+/).filter(Boolean);
  const action=(tokens.shift()||'list').toLowerCase();
  const positionals=[],grantedPermissions=[];
  let acceptPermissionDiff=false;
  for(let i=0;i<tokens.length;i++){
    const token=tokens[i];
    if(token==='--accept-permission-diff')acceptPermissionDiff=true;
    else if(token==='--grant'||token==='--permissions'){
      const value=tokens[++i];if(!value)throw new Error(token+' needs a comma-separated permission list.');
      grantedPermissions.push(...value.split(',').map(x=>x.trim()).filter(Boolean));
    }else if(token.startsWith('--grant='))grantedPermissions.push(...token.slice(8).split(',').map(x=>x.trim()).filter(Boolean));
    else positionals.push(token);
  }
  if(['install','update','validate'].includes(action)){
    if(!positionals[0])throw new Error('Usage: /plugin-package '+action+' LOCAL-PATH'+(action==='install'?' --grant commands,skills,hooks,agents,mcp':' --grant ...'));
    positionals[0]=path.resolve(root,positionals[0]);
  }
  return {action,positionals,grantedPermissions:[...new Set(grantedPermissions)],acceptPermissionDiff};
}
