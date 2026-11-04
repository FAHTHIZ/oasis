// Renders site/assets/oasis-social-preview.png from the SVG, using the site fonts.
// Most link previews (X, Facebook, LinkedIn, Slack, Discord, WhatsApp) do not show SVG.
//   npm i --no-save playwright && npx playwright install chromium
//   node scripts/render-social-preview.mjs
import {chromium} from 'playwright';import fs from 'fs';
import path from 'node:path';import { fileURLToPath } from 'node:url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','site','assets')+'/';
const svg=fs.readFileSync(R+'oasis-social-preview.svg','utf8');
const f=n=>'data:font/woff2;base64,'+fs.readFileSync(R+'fonts/'+n).toString('base64');
const html=`<style>@font-face{font-family:"Space Grotesk";src:url(${f('bricolage.woff2')})}@font-face{font-family:"Inter";src:url(${f('geist.woff2')});font-weight:100 900}html,body{margin:0}svg{display:block}</style>${svg}`;
const b=await chromium.launch();const p=await b.newPage({viewport:{width:1200,height:630}});
await p.setContent(html);await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(300);
await p.screenshot({path:R+'oasis-social-preview.png'});await b.close();
