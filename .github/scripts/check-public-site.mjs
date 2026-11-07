import { readFile, stat } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const size = async (path) => (await stat(new URL(path, import.meta.url))).size;
const [html, css, js, robots, sitemap, icon, mark, socialCard, packageText, readme, licenseText, buildScript, demoGif, demoMp4, demoCast] = await Promise.all([
 read('../../site/index.html'), read('../../site/assets/site.css'), read('../../site/assets/site.js'),
 read('../../site/robots.txt'), read('../../site/sitemap.xml'), read('../../site/assets/oasis-icon.svg'),
 read('../../site/assets/oasis-mark.svg'), read('../../site/assets/social-card.svg'), read('../../package.json'), read('../../README.md'),
 read('../../LICENSE'), read('../../scripts/build-app.mjs'),
 size('../../assets/demo/oasis-real-model-demo.gif'), size('../../assets/demo/oasis-real-model-demo.mp4'),
 size('../../assets/demo/oasis-real-model-demo.cast')
]);
const siteUrl='https://fahthiz.github.io/oasis/';
assert.ok(html.includes('<!doctype html>')&&html.includes('<html lang="en">'));
assert.ok(html.includes('<title>OASIS — Open-source coding-agent runtime</title>'));
assert.ok(html.includes('<meta name="robots" content="index,follow">'));
assert.ok(html.includes('<link rel="canonical" href="'+siteUrl+'">'));
assert.ok(html.includes('property="og:image"')&&html.includes('assets/social-card.svg'));
assert.ok(socialCard.startsWith('<svg')&&socialCard.includes('width="1200"')&&socialCard.includes('height="630"'));
assert.ok(html.includes('name="twitter:card" content="summary_large_image"')&&html.includes('application/ld+json'));
assert.ok(html.includes('href="./app/"')&&html.includes('https://github.com/FAHTHIZ/oasis'));
assert.ok(html.includes('id="main"')&&html.includes('class="skip-link"'));
assert.ok(html.includes('<nav class="site-nav"')&&html.includes('aria-label="Main navigation"'));
assert.ok(html.includes('id="runtime"')&&html.includes('id="interfaces"')&&html.includes('id="evidence"'));
assert.ok(html.includes('oasis-real-model-demo.gif')&&html.includes('oasis-real-model-demo.mp4'));
assert.ok(html.includes('qualitative product example, not a controlled benchmark'));
assert.ok(html.includes('No published desktop installer assets are currently available'));
assert.ok(html.includes('<!--OASIS:DOWNLOADS-->')&&html.includes('<!--/OASIS:DOWNLOADS-->'));
assert.ok(html.includes('<!--OASIS:BUILD-->')&&html.includes('<!--/OASIS:BUILD-->'));
assert.ok(html.includes('<!--OASIS:CHANGES-->')&&html.includes('<!--/OASIS:CHANGES-->'));
assert.ok(!/http-equiv="refresh"|location\.replace/.test(html));
assert.ok(html.includes('./assets/site.css')&&html.includes('./assets/site.js'));
assert.ok(css.includes('@font-face')&&css.includes('--accent:#9BFF55')&&css.includes(':focus-visible'));
assert.ok(css.includes('prefers-reduced-motion')&&css.includes('@media(max-width:520px)')&&css.includes('html.js .site-nav.is-open')&&css.includes('html:not(.js) .site-nav'));
assert.ok(js.includes('document.documentElement.classList.add(\'js\')')&&js.includes('aria-expanded')&&js.includes('navigator.clipboard')&&js.includes('data-copy'));
assert.ok(!/https?:\/\//.test(js));
assert.ok(icon.startsWith('<svg')&&icon.includes('</svg>')&&mark.startsWith('<svg')&&mark.includes('</svg>'));
assert.ok(buildScript.includes('oasis-real-model-demo.gif')&&buildScript.includes("site', 'assets', 'demo'"));
assert.ok(demoGif>10000&&demoMp4>10000&&demoCast>1000);
assert.ok(robots.includes('User-agent: *')&&robots.includes('Allow: /')&&robots.includes(siteUrl+'sitemap.xml'));
assert.ok(sitemap.includes('<loc>'+siteUrl+'</loc>')&&sitemap.includes('<loc>'+siteUrl+'app/</loc>'));
const pkg=JSON.parse(packageText);
assert.equal(pkg.license,'Apache-2.0');
assert.equal(pkg.repository?.url,'https://github.com/FAHTHIZ/oasis.git');
assert.equal(pkg.engines?.node,'>=22.15');
assert.ok(readme.includes('https://fahthiz.github.io/oasis/')&&readme.includes('https://fahthiz.github.io/oasis/app/'));
assert.ok(readme.includes('does not guarantee that every model will solve every task'));
assert.ok(readme.includes('SHA256SUMS')&&readme.includes('MOBILE.md')&&readme.includes('SECURITY.md'));
assert.ok(!/beats Claude Code|100% success|security certified/.test(readme));
assert.ok(licenseText.includes('Apache License')&&licenseText.includes('Version 2.0, January 2004'));
assert.ok(licenseText.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
assert.ok(licenseText.includes('APPENDIX: How to apply the Apache License'));
console.log('OASIS public-site checks passed: landing page, app boundary, real demo assets, accessibility hooks, release truth and license metadata.');
