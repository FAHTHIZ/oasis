import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { groundFinding } from '../src/knowledge-board.mjs';
import { checkQuotes, clearPageStore, findQuote, pageText, quotedClaims, quoteWords, rememberPage } from '../src/page-store.mjs';
import { runResearchTool, RESEARCH_TOOL_NAMES } from '../src/research-tools.mjs';
import { SESSION_READ_ONLY_TOOLS, SESSION_TOOL_NAMES } from '../src/session-tools.mjs';
import { checkReport, citedUrls } from '../src/verification-contracts.mjs';

const URL_A = 'https://example.com/report';
const PAGE = 'Annual report 2025.\nThe company said revenue grew 12% to $4.1 billion, driven by cloud services.\nIt expects “moderate growth” next year — but warned that supply costs remain high.';

function fetched(url = URL_A) {
  const ledger = createEvidenceLedger();
  recordEvidence(ledger, { kind: 'fetch', tool: 'fetch_url', url, numbers: [] });
  return ledger.events;
}

test('matching ignores case, spacing, quote styles and dashes; ellipses split a quote', () => {
  assert.deepEqual(quoteWords('It “Expects”  moderate—growth, well-known: 4.1.'), ['it', 'expects', 'moderate', 'growth', 'well', 'known', '4.1']);
  assert.equal(findQuote('revenue grew 12% to $4.1 billion', PAGE).status, 'exact');
  assert.equal(findQuote('REVENUE  grew 12%   to $4.1 Billion, driven by cloud services', PAGE).status, 'exact');
  assert.equal(findQuote('revenue grew 12% ... driven by cloud services', PAGE).status, 'exact');
  assert.equal(findQuote('driven by cloud services … revenue grew 12%', PAGE).status, 'missing', 'pieces must appear in order');
  assert.equal(findQuote('expects "moderate growth" next year - but warned that supply costs remain high', PAGE).status, 'exact');
});

test('a changed word is near; invented words are missing, with the closest passage', () => {
  const near = findQuote('revenue grew 12% to $4.1 billion, driven by cloud products', PAGE);
  assert.equal(near.status, 'near');
  assert.match(near.context, /driven by cloud services/);
  const missing = findQuote('revenue tripled thanks to an aggressive acquisition strategy', PAGE);
  assert.equal(missing.status, 'missing');
  assert.ok(missing.similarity < 0.85);
});

test('quotes are paired with the URLs cited in the same paragraph or list item', () => {
  const report = [
    'Revenue rose: the filing says "revenue grew 12% to $4.1 billion, driven by cloud services" ([report](' + URL_A + ')).',
    '',
    '- A "short quote" is ignored, and so is `"code that looks quoted here and is long enough"` ([x](https://example.com/x)).',
    '- "this quoted sentence has no citation in its own list item at all"',
    '',
    '> It expects moderate growth next year but warned that supply costs remain high.',
    '',
    '— [Annual report](' + URL_A + ')'
  ].join('\n');
  const claims = quotedClaims(report, citedUrls);
  assert.equal(claims.length, 2, JSON.stringify(claims, null, 1));
  assert.deepEqual(claims[0].urls, [URL_A]);
  assert.match(claims[1].quote, /^It expects moderate growth/);
  assert.deepEqual(claims[1].urls, [URL_A]);
});

test('a report that misquotes a fetched page is rejected; a faithful one passes', () => {
  clearPageStore();
  rememberPage(URL_A, PAGE);
  const events = fetched();
  const good = checkReport('The company reported that "revenue grew 12% to $4.1 billion, driven by cloud services" ([report](' + URL_A + ')).', events);
  assert.deepEqual(good, []);
  const bad = checkReport('The company admitted that "revenue fell sharply because customers left for competitors" ([report](' + URL_A + ')).', events);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].domain, 'research');
  assert.match(bad[0].reason, /does not contain/);
  assert.match(bad[0].reason, /closest text there/);
  assert.equal(bad[0].misquotes.length, 1);
});

test('pages with no stored text (fetched before a restart) are skipped, not failed', () => {
  clearPageStore();
  const issues = checkReport('It said "revenue fell sharply because customers left for competitors" (' + URL_A + ').', fetched());
  assert.deepEqual(issues, []);
});

test('knowledge-board posts are held to the same rule', () => {
  clearPageStore();
  rememberPage(URL_A, PAGE);
  const refused = groundFinding('The report says "supply costs are no longer a concern for the company" (' + URL_A + ').', [URL_A], fetched());
  assert.equal(refused.issues.length, 1);
  assert.match(refused.issues[0].reason, /does not contain/);
});

test('repeated fetches of one page add up, and the final URL of a redirect is stored too', () => {
  clearPageStore();
  rememberPage(URL_A, 'first part of the page', { finalUrl: 'https://example.com/report/2025' });
  rememberPage(URL_A, 'second part of the page');
  assert.match(pageText(URL_A), /first part[\s\S]*second part/);
  assert.equal(pageText('https://example.com/report/2025'), 'first part of the page');
  const { checked, misquotes } = checkQuotes('"first part of the page and more words" — ' + URL_A, citedUrls);
  assert.equal(checked, 1);
  assert.equal(misquotes.length, 1);
});

test('verify_quote is a read-only session tool that reports exact, near, missing and not fetched', () => {
  assert.ok(SESSION_TOOL_NAMES.has('verify_quote'));
  assert.ok(SESSION_READ_ONLY_TOOLS.includes('verify_quote'));
  assert.ok(RESEARCH_TOOL_NAMES.has('verify_quote'));
  clearPageStore();
  rememberPage(URL_A, PAGE);
  const result = runResearchTool({}, 'verify_quote', { checks: [
    { url: URL_A, quote: 'revenue grew 12% to $4.1 billion' },
    { url: URL_A, quote: 'revenue grew 12% to $4.1 billion, driven by cloud products' },
    { url: URL_A, quote: 'the board approved a stock buyback of ten billion dollars' },
    { url: 'https://example.com/never', quote: 'anything at all here to check' },
    { url: 'ftp://x', quote: 'x' }
  ] });
  assert.deepEqual(result.results.map((item) => item.status), ['exact', 'near', 'missing', 'not_fetched', 'invalid']);
  assert.match(result.results[2].message, /Do not attribute/);
  assert.deepEqual(result.counts, { exact: 1, near: 1, missing: 1, not_fetched: 1, invalid: 1 });
});

test('a 1.8 MB page stays fast', () => {
  clearPageStore();
  const filler = Array.from({ length: 100000 }, (_, index) => 'word' + (index % 5000)).join(' ');
  rememberPage(URL_A, filler + ' the needle sentence that we are looking for today ' + filler);
  const started = Date.now();
  assert.equal(findQuote('the needle sentence that we are looking for today', pageText(URL_A)).status, 'exact');
  assert.equal(findQuote('the needle sentence that we were looking for yesterday', pageText(URL_A)).status, 'missing');
  assert.ok(Date.now() - started < 3000, 'took ' + (Date.now() - started) + ' ms');
});

test('in JSON reports only quote fields are quotations, paired with the URLs of their object', () => {
  const report = JSON.stringify({ claims: [
    { claim: 'The company grew its revenue in the cloud segment substantially last year', sources: ['https://example.com/report'], quote: 'revenue grew 12% to $4.1 billion' },
    { claim: 'An analyst wrote "cloud margins will collapse within two quarters" (https://example.com/analyst)' }
  ] });
  const claims = quotedClaims(report, citedUrls);
  assert.deepEqual(claims.map((item) => item.quote), ['revenue grew 12% to $4.1 billion', 'cloud margins will collapse within two quarters']);
  assert.deepEqual(claims[0].urls, [URL_A]);
  assert.deepEqual(claims[1].urls, ['https://example.com/analyst']);
  assert.equal(quotedClaims('```json\n' + report + '\n```', citedUrls).length, 2, 'fenced JSON too');
  assert.deepEqual(quotedClaims('Broken JSON {"claim": "a claim that is long enough to be a quote", "url": "' + URL_A + '"', citedUrls), [], 'key/value pairs are never quotes');

  clearPageStore();
  rememberPage(URL_A, PAGE);
  assert.deepEqual(checkReport(JSON.stringify({ claim: 'Revenue went up a lot thanks to the cloud business overall', url: URL_A, quote: 'revenue grew 12% to $4.1 billion' }), fetched()), []);
  assert.equal(checkReport(JSON.stringify({ claim: 'Revenue went up', url: URL_A, quote: 'revenue tripled thanks to a major acquisition' }), fetched()).length, 1);
});
