import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { parse } from 'smol-toml';
import { findRuleSecrets, secretRuleCount, shannonEntropy } from '../src/secret-rules.mjs';
import { maskSecrets, redactSecretText, findSecretsInText } from '../src/secret-shield.mjs';
import { translateGoRegex, convertGitleaks } from '../scripts/update-secret-rules.mjs';

// Token-shaped values are generated at run time so no credential-looking
// strings are committed.
const hex = (n) => randomBytes(n).toString('hex').slice(0, n);
const pick = (alphabet, n) => Array.from(randomBytes(n), (byte) => alphabet[byte % alphabet.length]).join('');
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

test('Go RE2 inline flags, \\z, named groups and POSIX classes translate to ECMAScript', () => {
  assert.equal(translateGoRegex('p8e-(?i)[a-z0-9]{3}'), 'p8e-[A-Za-z0-9]{3}');
  assert.equal(translateGoRegex('(?i)ab(?-i:C)d'), '[aA][bB](?:C)[dD]');
  assert.equal(translateGoRegex('(?s:a.b)c.'), '(?:a[\\s\\S]b)c.');
  assert.equal(translateGoRegex('x\\z'), 'x(?![\\s\\S])');
  assert.equal(translateGoRegex('(?P<k>a)'), '(?<k>a)');
  assert.equal(translateGoRegex('[[:alnum:]]+'), '[a-zA-Z0-9]+');
  assert.equal(translateGoRegex('(?i)[a-z_-]'), '[A-Za-z_-]');
  const re = new RegExp(translateGoRegex('\\b(p8e-(?i)[a-z0-9]{4})\\b'));
  assert.ok(re.test('p8e-AbC1'));
  assert.ok(!re.test('P8E-abc1'));
});

test('the converter keeps keywords, entropy, secret groups, path scopes and allowlists', () => {
  const converted = convertGitleaks(parse(`
[allowlist]
stopwords = ["Example"]
regexes = ['''^\\$\\{''']
[[rules]]
id = "demo"
regex = '''(?i)\\b(demo_[a-z0-9]{8})\\b'''
entropy = 2.5
keywords = ["Demo_"]
[[rules.allowlists]]
regexTarget = "line"
regexes = ['''(?i)fixture''']
[[rules]]
id = "generic-api-key"
regex = '''key=(.+)'''
[[rules]]
id = "scoped"
regex = '''pw=(\\w+)'''
path = '''(?i)\\.tf$'''
`));
  assert.deepEqual(converted.rules.map((rule) => rule.id), ['demo', 'scoped']);
  assert.deepEqual(converted.rules[0].keywords, ['demo_']);
  assert.equal(converted.rules[0].entropy, 2.5);
  assert.deepEqual(converted.rules[0].allow, [{ regexes: ['[fF][iI][xX][tT][uU][rR][eE]'], target: 'line' }]);
  assert.equal(converted.rules[1].path, '\\.[tT][fF]$');
  assert.deepEqual(converted.allow.stopwords, ['example']);
});

test('the bundled Gitleaks snapshot compiles and recognises providers the old list missed', () => {
  assert.ok(secretRuleCount() >= 200, 'rules: ' + secretRuleCount());
  const samples = {
    'databricks-api-token': 'dapi' + hex(32),
    'pulumi-api-token': 'pul-' + hex(40),
    'age-secret-key': 'AGE-SECRET-KEY-1' + pick(BECH32.toUpperCase(), 58),
    'postman-api-token': 'PMAK-' + hex(24) + '-' + hex(34),
    'github-pat': 'ghp_' + pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 36)
  };
  for (const [rule, token] of Object.entries(samples)) {
    const text = 'export VALUE=' + token + '\nnext line';
    const hits = findRuleSecrets(text);
    assert.ok(hits.some((hit) => hit.rule === rule && hit.secret === token), rule + ': ' + JSON.stringify(hits));
    const masked = maskSecrets({}, 'output: ' + token + ' done');
    assert.equal(masked.count, 1, rule);
    assert.ok(!masked.text.includes(token), rule);
    assert.ok(!redactSecretText('log ' + token).includes(token), rule);
    assert.ok(findSecretsInText('+ ' + token).some((hit) => hit.rule === rule), rule);
  }
});

test('entropy thresholds, allowlists and path scopes keep non-secrets visible', () => {
  assert.equal(shannonEntropy('aaaa'), 0);
  assert.equal(shannonEntropy('abcd'), 2);
  // A Databricks-shaped value with no randomness fails the entropy check.
  assert.deepEqual(findRuleSecrets('token dapi' + 'a'.repeat(32) + ' x'), []);
  // Path-scoped rules (here HashiCorp Terraform passwords) need a matching path.
  const tf = 'administrator_login_password = "' + pick('ABCDEFGHJKLMNPQRSTabcdefghijkmnpqrst23456789', 20) + '"';
  assert.ok(!findRuleSecrets(tf).some((hit) => hit.rule === 'hashicorp-tf-password'));
  assert.ok(findRuleSecrets(tf, { path: 'infra/main.tf' }).some((hit) => hit.rule === 'hashicorp-tf-password'));
  // Ordinary code is untouched.
  const code = 'const apiKey = process.env.OPENAI_API_KEY;\nfunction tokenize(input) { return input.split(/\\s+/); }\n';
  assert.deepEqual(findRuleSecrets(code), []);
  assert.equal(maskSecrets({}, code).text, code);
});

test('no rule keeps the nested lazy prefix that backtracks quadratically in JavaScript', async () => {
  const { flattenNestedLazyPrefix } = await import('../scripts/update-secret-rules.mjs');
  const snapshot = JSON.parse(fs.readFileSync(new URL('../src/data/secret-rules.json', import.meta.url), 'utf8'));
  const nested = snapshot.rules.filter((rule) => rule.regex.includes('[\\w.-]{0,50}?(?:[\\w.-]{0,50}?')).map((rule) => rule.id);
  assert.deepEqual(nested, []);
  const original = '[\\w.-]{0,50}?(?:[\\w.-]{0,50}?(?:okta)(?:[ \\t\\w.-]{0,20})[\\s\'"]{0,3})(?:=|:)[\\x60\'"\\s=]{0,5}(00[\\w=\\-]{40})(?:[\\x60\'"\\s;]|$)';
  const flat = flattenNestedLazyPrefix(original);
  assert.notEqual(flat, original);
  const text = 'noise ' + 'a.b-c_'.repeat(30) + 'my_okta_token = 00' + 'Q'.repeat(40) + '\nshort okta: 00' + 'z'.repeat(40) + ';';
  const spans = (source) => [...text.matchAll(new RegExp(source, 'gd'))].map((match) => [match.index, match[0], match.indices[1]]);
  assert.deepEqual(spans(flat), spans(original));
  assert.equal(spans(flat).length, 2);
});
