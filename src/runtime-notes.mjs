// Runtime notes in the reader's language.
//
// When OASIS cannot confirm what an answer says ("Not verified: ...", "Not
// done: ..."), it adds a note of its own to the answer. A user who asked in
// Bengali and got a Bengali answer should not get that warning in English, so
// the note follows the answer's language: the fixed phrases are translated,
// and commands, file names and tool errors stay as they are.
//
// replyLanguage() is a cheap, deterministic guess from the script, and for
// Latin-script languages from common function words. Anything it is not sure
// of is English, which is also what every English answer gets.

const SCRIPTS = [
  ['bn', /[\u0980-\u09ff]/gu],
  ['hi', /[\u0900-\u097f]/gu],
  ['ko', /[\uac00-\ud7af\u1100-\u11ff]/gu],
  ['ja', /[\u3040-\u30ff]/gu],
  ['zh', /[\u4e00-\u9fff\u3400-\u4dbf]/gu],
  ['ru', /[\u0400-\u04ff]/gu],
  ['ar', /[\u0600-\u06ff\u0750-\u077f]/gu]
];
// Letters Urdu uses and Arabic does not.
const URDU = /[\u0679\u0688\u0691\u06ba\u06be\u06c1\u06d2\u06af\u067e\u0686\u06a9]/gu;
const VIETNAMESE = /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư]/giu;
const LATIN_WORDS = {
  en: ['the', 'and', 'is', 'to', 'of', 'it', 'in', 'that', 'was', 'with', 'for', 'this', 'are', 'not', 'all', 'now'],
  es: ['el', 'los', 'las', 'que', 'para', 'del', 'una', 'por', 'con', 'pero', 'está', 'pruebas', 'archivo', 'se', 'lo', 'ya'],
  pt: ['não', 'isso', 'que', 'para', 'uma', 'com', 'mas', 'está', 'testes', 'arquivo', 'foi', 'são', 'já', 'também', 'você', 'muito', 'há', 'agora'],
  fr: ['le', 'les', 'des', 'est', 'pas', 'une', 'pour', 'avec', 'mais', 'dans', 'sont', 'fichier', 'j’ai', "j'ai", 'tous', 'été'],
  de: ['der', 'die', 'das', 'und', 'nicht', 'ist', 'ich', 'mit', 'für', 'auf', 'wurde', 'sind', 'datei', 'habe', 'alle', 'jetzt'],
  it: ['il', 'che', 'non', 'della', 'sono', 'per', 'una', 'con', 'ma', 'gli', 'è', 'questo', 'ho', 'tutti', 'stato', 'anche'],
  tr: ['ve', 'bir', 'için', 'bu', 'ile', 'değil', 'olarak', 'dosya', 'tüm', 'testler', 'şimdi', 'daha', 'sonra', 'ama', 'çok', 'gibi'],
  id: ['yang', 'dan', 'tidak', 'untuk', 'ini', 'dengan', 'sudah', 'semua', 'bisa', 'berkas', 'saya', 'akan', 'dari', 'ada', 'itu', 'juga']
};

/** ISO 639-1 code of the language a reply is written in, or 'en'. */
export function replyLanguage(text) {
  // Code, links and code-like lines say nothing about the language of the prose.
  const value = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ')
    .split('\n').filter((line) => !/^(?: {4}|\t)|[{};]|=>|^\s*(?:\/\/|\/?\*|#|\|)/.test(line)).join('\n');
  const letters = (value.match(/\p{L}/gu) || []).length;
  if (!letters) return 'en';
  let best = null;
  for (const [code, pattern] of SCRIPTS) {
    const count = (value.match(pattern) || []).length;
    if (count && (!best || count > best.count)) best = { code, count };
  }
  if (best && best.count >= 4 && best.count >= letters * 0.2) {
    if (best.code === 'ar' && (value.match(URDU) || []).length >= 2) return 'ur';
    // Japanese mixes kanji with kana; Han alone is Chinese.
    if (best.code === 'zh' && (value.match(/[\u3040-\u30ff]/gu) || []).length >= 2) return 'ja';
    return best.code;
  }
  if ((value.match(VIETNAMESE) || []).length >= 3) return 'vi';
  const words = value.toLowerCase().match(/[\p{L}’']+/gu) || [];
  const scores = Object.fromEntries(Object.keys(LATIN_WORDS).map((code) => [code, 0]));
  const sets = Object.fromEntries(Object.entries(LATIN_WORDS).map(([code, list]) => [code, new Set(list)]));
  for (const word of words) for (const code of Object.keys(sets)) if (sets[code].has(word)) scores[code] += 1;
  const [top, topScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (top === 'en' || topScore < Math.max(3, words.length * 0.08) || topScore < scores.en * 1.5) return 'en';
  return top;
}

// {c} command, {n} exit code, {f} file, {e} tool error.
const NOTES = {
  en: { verified: 'Not verified', done: 'Not done', sep: ': ', end: '.', failed: 'the last check (`{c}`) failed with exit code {n}', stale: 'files changed after the last check (`{c}`) ran', denied: '`{c}` was not approved, so no check ran', noCheck: 'no test or check command ran after the last edit', saidPassed: 'The reply above says it passed; OASIS saw it fail.', notObserved: 'Any passing test results described above were not observed by OASIS.', run: 'Run `{c}` to confirm.', notApplied: 'the change to {f} did not apply ({e})' },
  bn: { verified: 'যাচাই হয়নি', done: 'করা হয়নি', sep: ': ', end: '।', failed: 'শেষ পরীক্ষা (`{c}`) এক্সিট কোড {n} দিয়ে ব্যর্থ হয়েছে', stale: 'শেষ পরীক্ষা (`{c}`) চালানোর পর ফাইল বদলেছে', denied: '`{c}` অনুমোদিত হয়নি, তাই কোনো পরীক্ষা চলেনি', noCheck: 'শেষ পরিবর্তনের পর কোনো টেস্ট বা চেক কমান্ড চলেনি', saidPassed: 'উপরের উত্তরে বলা হয়েছে এটি পাস করেছে; OASIS দেখেছে এটি ব্যর্থ হয়েছে।', notObserved: 'উপরে বলা পাস করা টেস্টের কোনো ফলাফল OASIS দেখেনি।', run: 'নিশ্চিত হতে `{c}` চালান।', notApplied: '{f} ফাইলের পরিবর্তন প্রয়োগ হয়নি ({e})' },
  hi: { verified: 'सत्यापित नहीं', done: 'नहीं हुआ', sep: ': ', end: '।', failed: 'आख़िरी जाँच (`{c}`) एग्ज़िट कोड {n} के साथ विफल रही', stale: 'आख़िरी जाँच (`{c}`) चलने के बाद फ़ाइलें बदलीं', denied: '`{c}` को अनुमति नहीं मिली, इसलिए कोई जाँच नहीं चली', noCheck: 'आख़िरी बदलाव के बाद कोई टेस्ट या जाँच कमांड नहीं चला', saidPassed: 'ऊपर के जवाब में कहा गया है कि यह पास हुआ; OASIS ने इसे विफल होते देखा।', notObserved: 'ऊपर बताए गए पास हुए टेस्ट के किसी भी नतीजे को OASIS ने नहीं देखा।', run: 'पुष्टि के लिए `{c}` चलाएँ।', notApplied: '{f} में बदलाव लागू नहीं हुआ ({e})' },
  ur: { verified: 'تصدیق نہیں ہوئی', done: 'نہیں ہوا', sep: ': ', end: '۔', failed: 'آخری جانچ (`{c}`) ایگزٹ کوڈ {n} کے ساتھ ناکام ہوئی', stale: 'آخری جانچ (`{c}`) کے بعد فائلیں بدل گئیں', denied: '`{c}` کی اجازت نہیں ملی، اس لیے کوئی جانچ نہیں چلی', noCheck: 'آخری تبدیلی کے بعد کوئی ٹیسٹ یا جانچ کمانڈ نہیں چلی', saidPassed: 'اوپر کے جواب میں کہا گیا ہے کہ یہ پاس ہوا؛ OASIS نے اسے ناکام ہوتے دیکھا۔', notObserved: 'اوپر بیان کیے گئے کسی پاس ٹیسٹ کے نتیجے کو OASIS نے نہیں دیکھا۔', run: 'تصدیق کے لیے `{c}` چلائیں۔', notApplied: '{f} میں تبدیلی لاگو نہیں ہوئی ({e})' },
  ar: { verified: 'لم يتم التحقق', done: 'لم يتم', sep: ': ', end: '.', failed: 'فشل آخر فحص (`{c}`) برمز الخروج {n}', stale: 'تغيّرت الملفات بعد تشغيل آخر فحص (`{c}`)', denied: 'لم تتم الموافقة على `{c}`، لذلك لم يُشغَّل أي فحص', noCheck: 'لم يُشغَّل أي أمر اختبار أو فحص بعد آخر تعديل', saidPassed: 'يقول الرد أعلاه إنه نجح، لكن OASIS رآه يفشل.', notObserved: 'لم يرصد OASIS أيًّا من نتائج الاختبارات الناجحة المذكورة أعلاه.', run: 'شغّل `{c}` للتأكد.', notApplied: 'لم يُطبَّق التغيير على {f} ({e})' },
  es: { verified: 'Sin verificar', done: 'Sin hacer', sep: ': ', end: '.', failed: 'la última comprobación (`{c}`) falló con el código de salida {n}', stale: 'los archivos cambiaron después de la última comprobación (`{c}`)', denied: '`{c}` no se aprobó, así que no se ejecutó ninguna comprobación', noCheck: 'no se ejecutó ninguna prueba ni comprobación después del último cambio', saidPassed: 'La respuesta de arriba dice que pasó; OASIS vio que falló.', notObserved: 'OASIS no observó ninguno de los resultados de pruebas superadas que se describen arriba.', run: 'Ejecuta `{c}` para confirmarlo.', notApplied: 'el cambio en {f} no se aplicó ({e})' },
  pt: { verified: 'Não verificado', done: 'Não feito', sep: ': ', end: '.', failed: 'a última verificação (`{c}`) falhou com o código de saída {n}', stale: 'os arquivos mudaram depois da última verificação (`{c}`)', denied: '`{c}` não foi aprovado, então nenhuma verificação foi executada', noCheck: 'nenhum teste ou verificação foi executado depois da última alteração', saidPassed: 'A resposta acima diz que passou; o OASIS viu falhar.', notObserved: 'O OASIS não observou nenhum dos resultados de testes aprovados descritos acima.', run: 'Execute `{c}` para confirmar.', notApplied: 'a alteração em {f} não foi aplicada ({e})' },
  fr: { verified: 'Non vérifié', done: 'Non fait', sep: ' : ', end: '.', failed: 'la dernière vérification (`{c}`) a échoué avec le code de sortie {n}', stale: 'des fichiers ont changé après la dernière vérification (`{c}`)', denied: '`{c}` n’a pas été approuvé, donc aucune vérification n’a été lancée', noCheck: 'aucun test ni aucune vérification n’a été lancé après la dernière modification', saidPassed: 'La réponse ci-dessus dit que c’est passé ; OASIS l’a vu échouer.', notObserved: 'OASIS n’a observé aucun des résultats de tests réussis décrits ci-dessus.', run: 'Lancez `{c}` pour confirmer.', notApplied: 'la modification de {f} n’a pas été appliquée ({e})' },
  de: { verified: 'Nicht verifiziert', done: 'Nicht erledigt', sep: ': ', end: '.', failed: 'die letzte Prüfung (`{c}`) ist mit Exit-Code {n} fehlgeschlagen', stale: 'nach der letzten Prüfung (`{c}`) wurden Dateien geändert', denied: '`{c}` wurde nicht genehmigt, daher lief keine Prüfung', noCheck: 'nach der letzten Änderung lief kein Test- oder Prüfbefehl', saidPassed: 'Die Antwort oben sagt, es sei bestanden; OASIS hat es fehlschlagen sehen.', notObserved: 'OASIS hat keines der oben beschriebenen bestandenen Testergebnisse beobachtet.', run: 'Führe `{c}` aus, um es zu bestätigen.', notApplied: 'die Änderung an {f} wurde nicht übernommen ({e})' },
  it: { verified: 'Non verificato', done: 'Non fatto', sep: ': ', end: '.', failed: 'l’ultimo controllo (`{c}`) è fallito con codice di uscita {n}', stale: 'i file sono cambiati dopo l’ultimo controllo (`{c}`)', denied: '`{c}` non è stato approvato, quindi non è stato eseguito alcun controllo', noCheck: 'nessun test o controllo è stato eseguito dopo l’ultima modifica', saidPassed: 'La risposta sopra dice che è passato; OASIS lo ha visto fallire.', notObserved: 'OASIS non ha osservato nessuno dei risultati di test superati descritti sopra.', run: 'Esegui `{c}` per confermare.', notApplied: 'la modifica a {f} non è stata applicata ({e})' },
  ru: { verified: 'Не проверено', done: 'Не сделано', sep: ': ', end: '.', failed: 'последняя проверка (`{c}`) завершилась с кодом выхода {n}', stale: 'после последней проверки (`{c}`) файлы изменились', denied: '`{c}` не был одобрен, поэтому проверка не запускалась', noCheck: 'после последнего изменения не запускалось ни одного теста или проверки', saidPassed: 'В ответе выше сказано, что всё прошло; OASIS видел, что проверка не прошла.', notObserved: 'OASIS не видел ни одного из описанных выше успешных результатов тестов.', run: 'Запустите `{c}`, чтобы убедиться.', notApplied: 'изменение в {f} не применилось ({e})' },
  tr: { verified: 'Doğrulanmadı', done: 'Yapılmadı', sep: ': ', end: '.', failed: 'son kontrol (`{c}`) {n} çıkış koduyla başarısız oldu', stale: 'son kontrolden (`{c}`) sonra dosyalar değişti', denied: '`{c}` onaylanmadı, bu yüzden hiçbir kontrol çalışmadı', noCheck: 'son değişiklikten sonra hiçbir test veya kontrol komutu çalışmadı', saidPassed: 'Yukarıdaki yanıt geçtiğini söylüyor; OASIS başarısız olduğunu gördü.', notObserved: 'OASIS yukarıda anlatılan başarılı test sonuçlarının hiçbirini gözlemlemedi.', run: 'Doğrulamak için `{c}` çalıştırın.', notApplied: '{f} üzerindeki değişiklik uygulanmadı ({e})' },
  id: { verified: 'Belum diverifikasi', done: 'Belum dilakukan', sep: ': ', end: '.', failed: 'pemeriksaan terakhir (`{c}`) gagal dengan kode keluar {n}', stale: 'file berubah setelah pemeriksaan terakhir (`{c}`) dijalankan', denied: '`{c}` tidak disetujui, jadi tidak ada pemeriksaan yang dijalankan', noCheck: 'tidak ada perintah tes atau pemeriksaan yang dijalankan setelah perubahan terakhir', saidPassed: 'Jawaban di atas mengatakan lulus; OASIS melihatnya gagal.', notObserved: 'OASIS tidak mengamati satu pun hasil tes lulus yang dijelaskan di atas.', run: 'Jalankan `{c}` untuk memastikan.', notApplied: 'perubahan pada {f} tidak diterapkan ({e})' },
  zh: { verified: '未验证', done: '未完成', sep: '：', end: '。', failed: '最后一次检查（`{c}`）失败，退出码为 {n}', stale: '最后一次检查（`{c}`）之后文件又有改动', denied: '`{c}` 未获批准，因此没有运行任何检查', noCheck: '最后一次修改之后没有运行任何测试或检查命令', saidPassed: '上面的回复说已通过；OASIS 看到它失败了。', notObserved: 'OASIS 没有观察到上面描述的任何测试通过结果。', run: '运行 `{c}` 进行确认。', notApplied: '对 {f} 的修改没有生效（{e}）' },
  ja: { verified: '未検証', done: '未完了', sep: '：', end: '。', failed: '最後のチェック（`{c}`）が終了コード {n} で失敗しました', stale: '最後のチェック（`{c}`）の後にファイルが変更されました', denied: '`{c}` が承認されなかったため、チェックは実行されていません', noCheck: '最後の変更の後、テストやチェックのコマンドは実行されていません', saidPassed: '上の回答では成功したとしていますが、OASIS は失敗を確認しました。', notObserved: '上に書かれたテスト成功の結果は、OASIS では確認されていません。', run: '確認するには `{c}` を実行してください。', notApplied: '{f} への変更は適用されていません（{e}）' },
  ko: { verified: '검증되지 않음', done: '완료되지 않음', sep: ': ', end: '.', failed: '마지막 검사(`{c}`)가 종료 코드 {n}(으)로 실패했습니다', stale: '마지막 검사(`{c}`) 이후 파일이 변경되었습니다', denied: '`{c}`이(가) 승인되지 않아 검사가 실행되지 않았습니다', noCheck: '마지막 변경 이후 테스트나 검사 명령이 실행되지 않았습니다', saidPassed: '위 답변은 통과했다고 하지만 OASIS는 실패를 확인했습니다.', notObserved: '위에 설명된 테스트 통과 결과는 OASIS가 확인하지 못했습니다.', run: '확인하려면 `{c}`을(를) 실행하세요.', notApplied: '{f} 변경 사항이 적용되지 않았습니다({e})' },
  vi: { verified: 'Chưa xác minh', done: 'Chưa làm', sep: ': ', end: '.', failed: 'lần kiểm tra cuối (`{c}`) thất bại với mã thoát {n}', stale: 'các tệp đã thay đổi sau lần kiểm tra cuối (`{c}`)', denied: '`{c}` không được phê duyệt nên không có kiểm tra nào chạy', noCheck: 'không có lệnh kiểm thử hay kiểm tra nào chạy sau thay đổi cuối cùng', saidPassed: 'Câu trả lời ở trên nói rằng đã đạt; OASIS thấy nó thất bại.', notObserved: 'OASIS không thấy kết quả kiểm thử đạt nào được mô tả ở trên.', run: 'Chạy `{c}` để xác nhận.', notApplied: 'thay đổi đối với {f} chưa được áp dụng ({e})' }
};

export const NOTE_LANGUAGES = Object.freeze(Object.keys(NOTES));

function table(lang) { return NOTES[lang] || NOTES.en; }

/** A note phrase in `lang`, with {c} {n} {f} {e} filled in. */
export function notePhrase(lang, key, vars = {}) {
  return String(table(lang)[key] || NOTES.en[key] || '').replace(/\{([cnfe])\}/g, (_, name) => String(vars[name] ?? ''));
}

/** "Not verified: " or "Not done: " in `lang`. */
export function noteLabel(lang, kind = 'verified') {
  const t = table(lang);
  return t[kind] + t.sep;
}

/** The sentence end for `lang` ("." or "।" or "。"). */
export function noteEnd(lang) { return table(lang).end; }

/** True when `text` already carries a runtime note of this kind, in any language. */
export function hasNote(text, kind = 'verified') {
  const value = String(text || '');
  return Object.values(NOTES).some((t) => value.includes(t[kind] + t.sep));
}
