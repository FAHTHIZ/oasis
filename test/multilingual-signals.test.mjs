import test from 'node:test';
import assert from 'node:assert/strict';
import { multilingualRisk, multilingualIntent, multilingualClaimsPassing, MULTILINGUAL_LANGUAGES } from '../src/multilingual-signals.mjs';
import { assessRisk, classifyIntent, deriveTaskSpec } from '../src/task-model.mjs';
import { claimsPassing } from '../src/claim-check.mjs';

// "Delete all files in the production database", in each covered language.
const DELETE_PRODUCTION = {
  bn: 'প্রোডাকশন ডাটাবেসের সব ফাইল মুছে ফেলো',
  hi: 'प्रोडक्शन डेटाबेस की सारी फाइलें डिलीट कर दो',
  ur: 'پروڈکشن ڈیٹابیس کی تمام فائلیں حذف کر دو',
  ar: 'احذف جميع الملفات في قاعدة بيانات الإنتاج',
  es: 'Borra todos los archivos de la base de datos de producción',
  pt: 'Apague todos os arquivos do banco de dados de produção',
  fr: 'Supprime tous les fichiers de la base de données de l\'environnement de production',
  de: 'Lösche alle Dateien in der Produktionsdatenbank',
  it: 'Cancella tutti i file nel database di produzione',
  ru: 'Удали все файлы в продакшн базе данных',
  tr: 'Canlı ortam veritabanındaki tüm dosyaları sil',
  id: 'Hapus semua file di database produksi',
  zh: '删除生产环境数据库中的所有文件',
  ja: '本番データベースのファイルをすべて削除して',
  ko: '프로덕션 데이터베이스의 모든 파일을 삭제해',
  vi: 'Xóa tất cả các tệp trong cơ sở dữ liệu môi trường thật'
};

test('every covered language has a destructive production fixture', () => {
  assert.deepEqual(Object.keys(DELETE_PRODUCTION).sort(), [...MULTILINGUAL_LANGUAGES].sort());
});

test('a destructive request is high risk and an operation in every covered language', () => {
  for (const [lang, text] of Object.entries(DELETE_PRODUCTION)) {
    const risk = assessRisk(text);
    assert.equal(risk.level, 'high', lang + ': ' + text);
    assert.ok(risk.reasons.includes('destructive'), lang + ' destructive: ' + JSON.stringify(risk));
    assert.equal(classifyIntent(text), 'operate', lang + ' intent');
    const spec = deriveTaskSpec(text);
    assert.ok(spec.autonomy.confirm.includes('destructive'), lang + ' asks for confirmation');
  }
});

test('production is recognised on its own', () => {
  for (const [lang, text] of Object.entries(DELETE_PRODUCTION)) {
    if (lang === 'vi') continue; // Vietnamese uses "môi trường thật"; covered below
    assert.ok(multilingualRisk(text).some((s) => s.id === 'production'), lang + ': ' + text);
  }
  assert.ok(multilingualRisk('Xóa dữ liệu trên máy chủ thật').some((s) => s.id === 'production'));
});

test('negated actions do not count as asking for them', () => {
  for (const text of [
    'কোনো ফাইল মুছবেন না, শুধু তালিকা দেখান',
    'कोई फाइल मत हटाओ, बस सूची दिखाओ',
    'No borres ningún archivo, solo lista los grandes',
    'Não apague nenhum arquivo',
    'Ne supprime aucun fichier',
    'Lösche nicht die Dateien',
    'Не удаляй файлы, только покажи список',
    'Jangan hapus file apa pun',
    '不要删除任何文件，只列出大文件',
    'ファイルを削除しないでください',
    '파일을 삭제하지 마세요',
    'Đừng xóa tệp nào'
  ]) {
    assert.ok(!multilingualRisk(text).some((s) => s.id === 'destructive'), text);
  }
});

test('money, messages and publishing are read in other languages', () => {
  const cases = [
    ['বিকাশে ৫০০ টাকা পাঠাও', 'financial', 'critical'],
    ['इस ऑर्डर का भुगतान करो', 'financial', 'critical'],
    ['Paga la factura del proveedor', 'financial', 'critical'],
    ['给供应商转账五千元', 'financial', 'critical'],
    ['Envía un correo a todos los clientes', 'external_communication', 'high'],
    ['সব গ্রাহককে ইমেইল পাঠাও', 'external_communication', 'high'],
    ['Veröffentliche die neue Version', 'publishing', 'high'],
    ['把新版本部署到服务器', 'publishing', 'high'],
    ['আমার পাসওয়ার্ড দিয়ে লগইন কর', 'credentials', 'medium']
  ];
  for (const [text, id, level] of cases) {
    const risk = assessRisk(text);
    assert.ok(risk.reasons.includes(id), text + ' ' + JSON.stringify(risk));
    assert.ok(['low', 'medium', 'high', 'critical'].indexOf(risk.level) >= ['low', 'medium', 'high', 'critical'].indexOf(level), text);
  }
});

test('intent in other languages: questions, changes, creations and investigations', () => {
  assert.equal(multilingualIntent('কীভাবে ফাইল মুছব?'), 'question');
  assert.equal(classifyIntent('¿Cómo borro un archivo?'), 'question');
  assert.equal(classifyIntent('为什么测试失败了？'), 'question');
  assert.equal(classifyIntent('লগইন বাগটা ঠিক করো'), 'change');
  assert.equal(classifyIntent('Arregla el error de inicio de sesión'), 'change');
  assert.equal(classifyIntent('修复登录错误'), 'change');
  assert.equal(classifyIntent('একটি নতুন ওয়েবসাইট তৈরি করো'), 'create');
  assert.equal(classifyIntent('Crea una página de inicio'), 'create');
  assert.equal(classifyIntent('ログイン画面を作って'), 'create');
  assert.equal(classifyIntent('এই কোডটা বিশ্লেষণ করো'), 'investigate');
  assert.equal(classifyIntent('Analysiere die Logdateien'), 'investigate');
  assert.equal(classifyIntent('分析这个日志文件'), 'investigate');
});

test('English readings are unchanged', () => {
  assert.equal(assessRisk('Do not delete anything; just list the large files in this folder.').level, 'low');
  assert.equal(assessRisk('Move the helper to utils.js').level, 'low');
  assert.equal(assessRisk('Summarise the README for me').level, 'low');
  assert.equal(assessRisk('Explain how the scheduler works').level, 'low');
  assert.equal(classifyIntent('Explain how the scheduler works'), 'question');
  assert.equal(classifyIntent('Refactor the parser module'), 'change');
});

test('"the tests pass" is recognised in other languages', () => {
  for (const text of [
    'সব টেস্ট পাস করেছে।',
    'सभी टेस्ट पास हो गए।',
    'Todas las pruebas pasan.',
    'Todos os testes passaram.',
    'Tous les tests passent.',
    'Alle Tests bestanden.',
    'Tutti i test passano.',
    'Все тесты прошли успешно.',
    'Tüm testler geçti.',
    'Semua tes berhasil.',
    '所有测试都通过了。',
    'すべてのテストが成功しました。',
    '모든 테스트가 통과했습니다.',
    'جميع الاختبارات نجحت.',
    'Tất cả bài test đều thành công.',
    '12 pruebas pasaron, 0 fallaron.'
  ]) {
    assert.ok(multilingualClaimsPassing(text), text);
    assert.ok(claimsPassing(text), 'claim check: ' + text);
  }
});

test('failure reports in other languages are not success claims', () => {
  for (const text of [
    'দুটি টেস্ট ব্যর্থ হয়েছে।',
    'টেস্ট পাস হয়নি।',
    'दो टेस्ट फेल हो गए।',
    'Las pruebas fallaron.',
    'Os testes não passam.',
    'Les tests échouent encore.',
    'Die Tests sind fehlgeschlagen.',
    'Тесты не прошли.',
    '测试失败了。',
    'テストが失敗しました。',
    '테스트가 실패했습니다.',
    'فشلت الاختبارات.',
    'The test did not pass.',
    'I updated the README.',
    ''
  ]) {
    assert.ok(!claimsPassing(text), text);
  }
});
