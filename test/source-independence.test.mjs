import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { createKnowledgeBoard, knowledgePromptSection, runKnowledgeTool, sanitizeKnowledgeBoard } from '../src/knowledge-board.mjs';
import { clearPageStore, rememberPage } from '../src/page-store.mjs';
import { runResearchTool } from '../src/research-tools.mjs';
import { SESSION_READ_ONLY_TOOLS, SESSION_TOOL_NAMES } from '../src/session-tools.mjs';
import { canonicalDocument, containment, describeIndependence, independentSources, shingles, siteOf, sourceKey } from '../src/source-independence.mjs';

const WIRE = 'GENEVA (Wire) — The World Meteorological Organization said on Tuesday that the past twelve months were the warmest on record, with average surface temperatures 1.5 degrees above pre-industrial levels. '
  + 'The agency said the El Nino weather pattern and long-term warming from greenhouse gases both contributed. Scientists warned that ocean heat content also reached a new high, threatening coral reefs and fisheries across the tropics. '
  + 'The report draws on data from five international datasets and was released ahead of the annual climate summit, where delegates are expected to discuss new emission targets.';
const OWN = 'Our analysis of satellite records from the past year found unusual warmth in the North Atlantic. Researchers at the university compared buoy data with model runs and concluded that weaker trade winds explain part of the anomaly, '
  + 'though they caution that a single year cannot establish a trend. The team plans to publish the full dataset next spring together with the code used to process it.';

test('sites group by registrable domain, with two-label suffixes and per-owner shared hosts', () => {
  assert.equal(siteOf('https://docs.python.org/3/library/'), 'python.org');
  assert.equal(siteOf('https://www.bbc.co.uk/news/1'), 'bbc.co.uk');
  assert.equal(siteOf('https://news.abc.net.au/x'), 'abc.net.au');
  assert.equal(siteOf('https://alice.github.io/post'), 'alice.github.io');
  assert.equal(sourceKey('https://github.com/nodejs/node/issues/1'), 'github.com/nodejs');
  assert.notEqual(sourceKey('https://github.com/nodejs/node'), sourceKey('https://github.com/denoland/deno'));
  assert.equal(sourceKey('https://medium.com/@bob/a-post'), 'medium.com/bob');
  assert.equal(canonicalDocument('https://www.example.com/story/amp?utm_source=x&id=4#top'), canonicalDocument('https://example.com/story?id=4'));
});

test('containment finds a copy that adds its own header and footer, and ignores unrelated text', () => {
  const copy = shingles('Breaking news from our partners. ' + WIRE + ' Subscribe to our newsletter for more stories like this one every morning.');
  assert.ok(containment(shingles(WIRE), copy) > 0.9);
  assert.ok(containment(shingles(WIRE), shingles(OWN)) < 0.05);
  assert.equal(containment(shingles('too short to compare'), shingles('too short to compare')), 0, 'tiny pages are never called copies');
});

test('syndicated copies and same-site pages count once; independent reporting counts', () => {
  clearPageStore();
  rememberPage('https://news-one.com/climate', 'News One | Climate\n' + WIRE + '\nRelated: more weather.');
  rememberPage('https://dailypaper.co.uk/world/heat', 'Daily Paper\n' + WIRE.replace('on Tuesday', 'on Tuesday,') + '\nComments (12)');
  rememberPage('https://news-one.com/climate/analysis', 'News One analysis: what the record means for farmers and cities.');
  rememberPage('https://uni.edu/research/atlantic', OWN);
  const result = independentSources(['https://news-one.com/climate', 'https://dailypaper.co.uk/world/heat', 'https://news-one.com/climate/analysis', 'https://uni.edu/research/atlantic', 'https://www.news-one.com/climate?utm_source=feed']);
  assert.equal(result.total, 4, 'the tracking-parameter variant is the same URL after normalizeUrl');
  assert.equal(result.independent, 2, JSON.stringify(result.groups, null, 1));
  const merged = result.groups.find((group) => group.urls.length > 1);
  assert.equal(merged.urls.length, 3);
  assert.ok(merged.reasons.some((reason) => /^copied text/.test(reason)));
  assert.ok(merged.reasons.includes('same site'));
  assert.match(describeIndependence(result), /^2 independent sources \(4 URLs; 3 from news-one\.com incl\. copies\)/);
});

test('pages without stored text group by site only and are marked unchecked', () => {
  clearPageStore();
  const result = independentSources(['https://a.com/1', 'https://b.org/2', 'https://a.com/3', 'not a url']);
  assert.equal(result.independent, 2);
  assert.equal(result.total, 3);
  assert.ok(result.groups.every((group) => group.unchecked));
});

test('source_independence is a read-only session tool', () => {
  assert.ok(SESSION_TOOL_NAMES.has('source_independence'));
  assert.ok(SESSION_READ_ONLY_TOOLS.includes('source_independence'));
  clearPageStore();
  rememberPage('https://one.com/a', WIRE);
  rememberPage('https://two.com/b', WIRE);
  const result = runResearchTool({}, 'source_independence', { urls: ['https://one.com/a', 'https://two.com/b', 'ftp://x'] });
  assert.equal(result.independent, 1);
  assert.match(result.summary, /^1 independent source \(2 URLs/);
  assert.match(result.ignored, /^1 entries/);
  assert.throws(() => runResearchTool({}, 'source_independence', { urls: [] }), /needs urls/);
});

function poster(id, board, urls) {
  const ledger = createEvidenceLedger();
  for (const url of urls) recordEvidence(ledger, { kind: 'fetch', tool: 'fetch_url', url, numbers: [] });
  return { agentId: id, agentType: 'Explore', evidenceLedger: ledger, knowledgeBoard: board };
}

test('on the knowledge board, a corroboration citing a syndicated copy adds no independent source', () => {
  clearPageStore();
  rememberPage('https://news-one.com/climate', WIRE);
  rememberPage('https://dailypaper.co.uk/world/heat', 'Daily Paper\n' + WIRE);
  rememberPage('https://uni.edu/research/atlantic', OWN + ' The past twelve months were the warmest on record.');
  const board = createKnowledgeBoard();
  const claim = 'The past twelve months were the warmest on record according to the WMO.';
  const first = runKnowledgeTool(poster('agent_1', board, ['https://news-one.com/climate']), 'knowledge_post', { claim, sources: ['https://news-one.com/climate'] });
  assert.equal(first.finding.independent_sources, 1);

  const echo = runKnowledgeTool(poster('agent_2', board, ['https://dailypaper.co.uk/world/heat']), 'knowledge_post', { claim, sources: ['https://dailypaper.co.uk/world/heat'] });
  assert.equal(echo.corroborated, first.posted);
  assert.match(echo.note, /add no independent evidence: https:\/\/news-one\.com\/climate and https:\/\/dailypaper\.co\.uk\/world\/heat are one source \(copied text/);
  assert.equal(echo.finding.independent_sources, 1);

  const own = runKnowledgeTool(poster('agent_3', board, ['https://uni.edu/research/atlantic']), 'knowledge_post', { claim, sources: ['https://uni.edu/research/atlantic'] });
  assert.match(own.note, /now rests on 2 independent sources/);
  assert.equal(own.finding.independent_sources, 2);
  assert.match(knowledgePromptSection({ knowledgeBoard: board }, 'warmest on record'), /2 independent sources\]/);

  const restored = sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(restored.entries[0].independent, 2);
  assert.match(restored.entries[0].independence, /^2 independent sources/);
});
