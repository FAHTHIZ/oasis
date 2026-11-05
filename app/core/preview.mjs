// Builds a self-contained page for the live preview from project files:
// local stylesheets, scripts and SVG images are inlined so the page runs in a
// sandboxed frame with no access to the app. Remote URLs (CDNs) are kept.

// Runs first inside the previewed page: in-memory storage for the opaque
// origin, and error reporting back to the app.
export const PREVIEW_PRELUDE = '<script>(function(){function m(){var d=Object.create(null);return{get length(){return Object.keys(d).length},key:function(i){return Object.keys(d)[i]||null},getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)}}}["localStorage","sessionStorage"].forEach(function(n){var ok=false;try{ok=!!window[n]}catch(e){}if(!ok){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(e){}}});function r(k,t){try{parent.postMessage({oasisPreview:k,text:String(t).slice(0,2000)},"*")}catch(e){}}window.addEventListener("error",function(e){r("error",(e.message||"Script error")+(e.lineno?" (line "+e.lineno+")":""))});window.addEventListener("unhandledrejection",function(e){r("error","Unhandled promise rejection: "+(e.reason&&e.reason.message||e.reason))});var l=console.log;console.log=function(){r("log",Array.prototype.map.call(arguments,String).join(" "));return l.apply(console,arguments)};window.addEventListener("load",function(){r("loaded","")})})();<\/script>';

function isRemote(url) {
  return /^(https?:)?\/\//i.test(url) || /^(data|blob|mailto|tel|javascript):/i.test(url) || url.startsWith('#');
}

/** Resolves `ref` relative to the file at `from` ("site/index.html" + "../a.css" -> "a.css"). */
export function resolvePath(from, ref) {
  const clean = String(ref).split(/[?#]/)[0];
  const parts = clean.startsWith('/') ? [] : String(from).split('/').slice(0, -1);
  for (const part of clean.replace(/^\/+/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

const escapeScript = (text) => String(text).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const escapeStyle = (text) => String(text).replace(/<\/style/gi, '<\\/style');

/**
 * @param {string} entry   path of the HTML file to preview
 * @param {(path: string) => string|null} read  returns file text or null
 * @returns {{ html: string, missing: string[], inlined: string[] }}
 */
export function buildPreview(entry, read) {
  const source = read(entry);
  if (source === null || source === undefined) throw new Error('No file ' + entry + ' to preview.');
  const missing = [];
  const inlined = [];
  const load = (ref) => {
    const path = resolvePath(entry, ref);
    const text = read(path);
    if (text === null || text === undefined) { missing.push(path); return null; }
    inlined.push(path);
    return text;
  };
  let html = String(source);
  html = html.replace(/<link\b([^>]*?)\bhref\s*=\s*["']([^"']+)["']([^>]*)>/gi, (tag, before, href, after) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(before + after) || isRemote(href)) return tag;
    const css = load(href);
    return css === null ? tag : '<style data-from="' + href.replace(/"/g, '') + '">' + escapeStyle(css) + '</style>';
  });
  html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, before, src, after) => {
    if (isRemote(src)) return tag;
    const js = load(src);
    if (js === null) return tag;
    const attrs = (before + after).replace(/\s(defer|async)(?=\s|$)/gi, '');
    return '<script' + attrs + ' data-from="' + src.replace(/"/g, '') + '">' + escapeScript(js) + '</script>';
  });
  html = html.replace(/(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+\.svg)(["'])/gi, (tag, start, src, end) => {
    if (isRemote(src)) return tag;
    const svg = load(src);
    return svg === null ? tag : start + 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + end;
  });
  const prelude = PREVIEW_PRELUDE;
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (head) => head + prelude);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (tag) => tag + '<head>' + prelude + '</head>');
  else html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' + prelude + '</head><body>' + html + '</body></html>';
  return { html, missing, inlined };
}
