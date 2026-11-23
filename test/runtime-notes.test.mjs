import test from 'node:test';
import assert from 'node:assert/strict';
import { replyLanguage, NOTE_LANGUAGES, notePhrase, noteLabel, noteEnd, hasNote } from '../src/runtime-notes.mjs';
import { appendUnverifiedNotice, appendFailedEditNotice, newClaimState, recordCheck } from '../src/claim-check.mjs';
import { gateNotice } from '../src/task-model.mjs';

// "Fixed the login, all tests pass", as a model would answer in each language.
const REPLIES = {
  bn: 'লগইন ঠিক করেছি। সব টেস্ট পাস করেছে।',
  hi: 'लॉगिन ठीक किया, सारे टेस्ट पास हुए।',
  ur: 'لاگ ان ٹھیک کر دیا، سب ٹیسٹ پاس ہو گئے۔',
  ar: 'أصلحت تسجيل الدخول ونجحت كل الاختبارات.',
  es: 'Arreglé el login y todas las pruebas pasan ahora.',
  pt: 'Corrigi o login e todos os testes passam agora, não há erros.',
  fr: 'J’ai corrigé la connexion et tous les tests passent maintenant, pas d’erreur.',
  de: 'Ich habe den Login repariert und alle Tests sind jetzt grün.',
  it: 'Ho corretto il login e tutti i test sono ora verdi, non ci sono errori.',
  ru: 'Исправил вход, все тесты проходят.',
  tr: 'Girişi düzelttim ve tüm testler şimdi geçiyor, bir sorun yok.',
  id: 'Saya sudah memperbaiki login dan semua tes lulus dengan baik.',
  zh: '修复了登录问题，所有测试都通过了。',
  ja: 'ログインを修正しました。すべてのテストが通りました。',
  ko: '로그인을 고쳤고 모든 테스트가 통과했습니다.',
  vi: 'Đã sửa lỗi đăng nhập và tất cả kiểm thử đều đạt.'
};

const ISSUE = ['no relevant test, check, lint, build, or type-check command has passed after the latest code edit'];

test('replyLanguage names the language of each covered reply', () => {
  for (const [lang, reply] of Object.entries(REPLIES)) assert.equal(replyLanguage(reply), lang, reply);
  assert.equal(NOTE_LANGUAGES.length, 17);
});

test('English, code and paths stay English', () => {
  for (const text of [
    'Fixed the login. All tests pass now.',
    'Updated `src/il/che/per.mjs` and ran `npm test -- --grep una`.',
    '```js\nconst file = await readFile(file, "utf8"); if (file) return file;\n```\nDone.',
    'async function read(file) { const info = await stat(file); return info; }',
    '| License | Packages |\n| --- | --- |\n| MIT | 141 |',
    '',
    'ok'
  ]) assert.equal(replyLanguage(text), 'en', text);
});

test('every language has every phrase, and placeholders are filled', () => {
  for (const lang of NOTE_LANGUAGES) {
    for (const key of ['failed', 'stale', 'denied', 'noCheck', 'saidPassed', 'notObserved', 'run', 'notApplied']) {
      const phrase = notePhrase(lang, key, { c: 'npm test', n: 1, f: 'a.mjs', e: 'no match' });
      assert.ok(phrase && !/\{[cnfe]\}/.test(phrase), lang + ' ' + key);
    }
    assert.ok(noteLabel(lang, 'verified') && noteLabel(lang, 'done') && noteEnd(lang), lang);
  }
  assert.ok(notePhrase('bn', 'failed', { c: 'npm test', n: 2 }).includes('`npm test`'));
  assert.equal(notePhrase('xx', 'noCheck'), notePhrase('en', 'noCheck'), 'unknown languages fall back to English');
});

test('a Bengali answer gets its warning in Bengali', () => {
  const failed = newClaimState();
  recordCheck(failed, { command: 'npm test', exitCode: 1 });
  const out = appendUnverifiedNotice(REPLIES.bn, ISSUE, {}, failed);
  assert.ok(out.endsWith('যাচাই হয়নি: শেষ পরীক্ষা (`npm test`) এক্সিট কোড 1 দিয়ে ব্যর্থ হয়েছে। উপরের উত্তরে বলা হয়েছে এটি পাস করেছে; OASIS দেখেছে এটি ব্যর্থ হয়েছে।'), out);
  assert.ok(!out.includes('Not verified'));
  assert.equal(appendUnverifiedNotice(out, ISSUE, {}, failed), out, 'never added twice');
});

test('Chinese notes join without spaces; denied checks name the command', () => {
  const out = appendUnverifiedNotice(REPLIES.zh, ISSUE, { deniedCheck: 'npm test' }, newClaimState());
  assert.ok(out.endsWith('未验证：`npm test` 未获批准，因此没有运行任何检查。OASIS 没有观察到上面描述的任何测试通过结果。运行 `npm test` 进行确认。'), out);
});

test('English notes are unchanged', () => {
  const failed = newClaimState();
  recordCheck(failed, { command: 'npm test', exitCode: 1 });
  assert.equal(appendUnverifiedNotice('Fixed.', ISSUE, {}, failed), 'Fixed.\n\nNot verified: the last check (`npm test`) failed with exit code 1.');
  assert.equal(gateNotice([{ detail: 'tests not run' }]), 'Not verified: tests not run.');
  assert.equal(gateNotice([{ detail: 'tests not run' }], 'hi'), 'सत्यापित नहीं: tests not run।');
});

test('a claimed edit that did not apply is reported in the reply language', () => {
  const state = newClaimState();
  state.failedEdits = new Map([['/repo/add.mjs', 'old_string not found']]);
  const es = appendFailedEditNotice('Arreglé la suma en add.mjs, ya está lista y todas las pruebas pasan para el carrito.', state);
  assert.match(es, /Sin hacer: el cambio en \/repo\/add\.mjs no se aplicó \(old_string not found\)\.$/);
  assert.equal(appendFailedEditNotice(es, state), es);
  assert.ok(hasNote(es, 'done') && !hasNote(es, 'verified'));
  const en = appendFailedEditNotice('I fixed the bug in add.mjs.', state);
  assert.match(en, /Not done: the change to \/repo\/add\.mjs did not apply \(old_string not found\)\.$/);
});
