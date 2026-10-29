import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfigDirectory } from './config.mjs';

const MAX_BYTES = 512 * 1024;
const MAX_EVENTS = 250;
const MAX_TEXT = 3000;
const EVENT_KEYS = { timeline: 'timeline', command: 'commands', file: 'changedFiles', test: 'tests', error: 'errors', hypothesis: 'hypotheses', rollback: 'rollbackPoints' };
const EVENT_TYPES = new Set([...Object.keys(EVENT_KEYS), 'goal']);
const SECRET_PATTERNS = [
  [/\b(authorization\s*[:=]\s*)Bearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, '$1[REDACTED]'],
  [/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret|private[_-]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi, 'Bearer [REDACTED]'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED_TOKEN]'],
  [/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/([?&](?:token|key|secret|password|api_key)=)[^&#\s]+/gi, '$1[REDACTED]']
];

export function redactArtifactText(value) {
  let text = String(value ?? '').slice(0, MAX_TEXT * 4);
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text.slice(0, MAX_TEXT);
}
export function artifactSlug(value) {
  const slug = String(value || '').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 64);
  if (!slug || slug === '.' || slug === '..') throw new Error('Artifact name must contain letters or numbers.');
  return slug;
}
function directoryFor(root, env) {
  const workspaceKey = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
  return path.join(getConfigDirectory(env), 'artifacts', workspaceKey);
}
function pathsFor(root, name, env) {
  const slug = artifactSlug(name);
  const dir = directoryFor(root, env);
  return { slug, dir, data: path.join(dir, slug + '.json'), html: path.join(dir, slug + '.html') };
}
async function ensureDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Refusing an unsafe artifact directory.');
}
async function atomicWrite(file, content) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
async function readState(file) {
  let info;
  try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Refusing an unsafe or oversized artifact file.');
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1) throw new Error('Artifact data is invalid.');
  return data;
}
function esc(value) { return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function renderItems(items) {
  return (items || []).map(item => '<li><time>' + esc(item.at) + '</time><pre>' + esc(item.text) + '</pre></li>').join('');
}
function renderHtml(state) {
  const sections = [['Timeline','timeline'],['Commands','commands'],['Changed files','changedFiles'],['Tests','tests'],['Errors','errors'],['Hypotheses','hypotheses'],['Rollback points','rollbackPoints']];
  const cards = sections.map(([label,key]) => '<section><h2>' + label + ' <small>' + state[key].length + '</small></h2>' + (state[key].length ? '<ol>' + renderItems(state[key]) + '</ol>' : '<p class="muted">Nothing recorded yet.</p>') + '</section>').join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>OASIS Artifact — ${esc(state.name)}</title>
<style>:root{color-scheme:dark;--bg:#0b100d;--panel:#141c16;--line:#304032;--text:#edf5e9;--muted:#a4b3a2;--accent:#a7f46a}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1200px;margin:auto;padding:24px}header{border-bottom:1px solid var(--line);padding:20px 0;margin-bottom:22px}.tag{font-size:11px;color:var(--accent);letter-spacing:.1em;text-transform:uppercase}h1{font-size:clamp(26px,4vw,42px);margin:6px 0}h2{font-size:17px;margin:0 0 12px}small,.muted,time{color:var(--muted);font-size:12px}.goal{white-space:pre-wrap;border:1px solid var(--line);background:var(--panel);padding:14px;border-radius:12px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}section{min-width:0;border:1px solid var(--line);background:var(--panel);padding:16px;border-radius:12px}ol{padding-left:22px;margin:0}li{margin:0 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;margin:4px 0 0}footer{padding:22px 0;color:var(--muted);font-size:11px}@media(max-width:700px){.wrap{padding:15px}.grid{grid-template-columns:1fr}}</style></head>
<body><main class="wrap"><header><div class="tag">OASIS · Local investigation artifact</div><h1>${esc(state.name)}</h1><div class="muted">Created ${esc(state.createdAt)} · Updated ${esc(state.updatedAt)} · Refreshes every 5 seconds</div></header><h2>Task goal</h2><div class="goal">${esc(state.goal || 'Goal not set. Use /artifact goal ' + state.slug + ' YOUR GOAL.')}</div><div class="grid">${cards}</div><footer>Stored on this device under the Oasis user configuration directory. No remote scripts, fonts, images or network endpoints are loaded. Secrets are redacted before storage.</footer></main></body></html>`;
}
async function persist(state, p) {
  state.updatedAt = new Date().toISOString();
  state.timeline = state.timeline.slice(-MAX_EVENTS);
  for (const key of Object.values(EVENT_KEYS)) state[key] = state[key].slice(-MAX_EVENTS);
  const serialized = JSON.stringify(state,null,2) + '\n';
  if (Buffer.byteLength(serialized,'utf8') > MAX_BYTES) throw new Error('Artifact exceeds the 512 KiB safety limit.');
  await ensureDirectory(p.dir);
  await atomicWrite(p.data,serialized);
  await atomicWrite(p.html,renderHtml(state));
  return { artifact: state, dataPath:p.data, htmlPath:p.html, fileUrl:pathToFileURL(p.html).href };
}
export async function createArtifact(root, name, options = {}) {
  if (!root) throw new Error('A workspace root is required.');
  const env = options.env || process.env;
  const p = pathsFor(root,name,env);
  await ensureDirectory(p.dir);
  let state = await readState(p.data);
  const now = new Date().toISOString();
  if (!state) {
    state = { schemaVersion:1, slug:p.slug, name:String(name).trim().slice(0,100), workspaceRoot:path.resolve(root), createdAt:now, updatedAt:now, goal:'', timeline:[], commands:[], changedFiles:[], tests:[], errors:[], hypotheses:[], rollbackPoints:[] };
    if (options.goal) state.goal = redactArtifactText(options.goal);
    state.timeline.push({at:now,text:'Investigation artifact created.'});
  } else {
    state.timeline.push({at:now,text:'Artifact opened or resumed.'});
    if (options.goal) { state.goal = redactArtifactText(options.goal); state.timeline.push({at:now,text:'Task goal updated.'}); }
  }
  return persist(state,p);
}
export async function recordArtifactEvent(root,name,type,details,options={}) {
  if (!EVENT_TYPES.has(type)) throw new Error('Unsupported artifact event type: ' + type);
  const p=pathsFor(root,name,options.env||process.env);
  const state=await readState(p.data);
  if (!state) throw new Error('Artifact not found. Create it first with /artifact NAME.');
  const item={at:new Date().toISOString(),text:redactArtifactText(details)};
  if(type==='goal'){state.goal=item.text;state.timeline.push({...item,text:'Task goal updated.'});}
  else {
    const key=EVENT_KEYS[type];
    if(type==='file'&&state.changedFiles.some(e=>e.text===item.text)){state.timeline.push({...item,text:'Repeated file change observed: '+item.text});}
    else state[key].push(item);
    if(type!=='timeline') state.timeline.push({...item,text:type+': '+item.text.slice(0,500)});
  }
  return persist(state,p);
}
export async function readArtifact(root,name,options={}) {
  const p=pathsFor(root,name,options.env||process.env);
  const artifact=await readState(p.data);
  return artifact?{artifact,dataPath:p.data,htmlPath:p.html,fileUrl:pathToFileURL(p.html).href}:null;
}
export async function listArtifacts(root,options={}) {
  const dir=directoryFor(root,options.env||process.env);
  let names=[];try{names=(await readdir(dir,{withFileTypes:true})).filter(e=>e.isFile()&&e.name.endsWith('.json'));}catch{return [];}
  const rows=[];
  for(const entry of names)try{const item=await readState(path.join(dir,entry.name));if(item)rows.push({slug:item.slug,name:item.name,goal:item.goal,updatedAt:item.updatedAt});}catch{}
  return rows.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export async function deleteArtifact(root,name,options={}) {
  const p=pathsFor(root,name,options.env||process.env);
  for(const file of [p.data,p.html])try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw new Error('Refusing to delete an unsafe artifact file.');await unlink(file);}catch(error){if(error.code!=='ENOENT')throw error;}
}
export async function recordArtifactToolEvent(root,name,toolName,args,result,options={}) {
  if(!name)return;
  const env=options.env||process.env;
  const failed=Boolean(result&&(result.error||result.success===false));
  if(['run_command','run_shell','powershell'].includes(toolName)){
    const command=[args&&args.command,...(Array.isArray(args&&args.args)?args.args:[])].filter(Boolean).join(' ');
    const exitCode=Number.isInteger(result&&result.exitCode)?result.exitCode:Number.isInteger(result&&result.code)?result.code:(failed?1:0);
    const output=result&&(result.output||result.stdout||result.error);
    await recordArtifactEvent(root,name,'command',command+'\nExit code: '+exitCode+(output?'\n'+String(output).slice(-1200):''),{env});
    if(/\b(test|check|lint|typecheck|vitest|jest|pytest)\b|npm\s+run\s+(check|test|typecheck)/i.test(command))await recordArtifactEvent(root,name,'test',(exitCode===0?'PASSED — ':'FAILED — ')+command+' (exit code '+exitCode+')',{env});
    if(failed||exitCode!==0)await recordArtifactEvent(root,name,'error','Command failed: '+command+(output?'\n'+String(output).slice(-1200):''),{env});
  }
  if(['write_file','edit_file','multi_edit','delete_file','notebook_edit','apply_patch'].includes(toolName)&&!failed){
    const files=[args&&(args.path||args.file_path||args.notebook_path),...(Array.isArray(args&&args.paths)?args.paths:[])].filter(Boolean);
    for(const file of files.slice(0,20))await recordArtifactEvent(root,name,'file',String(file),{env});
  }
  if(failed&&!['run_command','run_shell','powershell'].includes(toolName))await recordArtifactEvent(root,name,'error',toolName+': '+String(result.error||'tool failed'),{env});
}
