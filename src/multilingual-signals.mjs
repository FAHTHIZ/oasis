// Multilingual signals: the same risk, intent and "the checks pass" readings
// the English patterns give, for requests and replies in other languages.
//
// The task model (src/task-model.mjs) and the claim check
// (src/claim-check.mjs) read English with word-boundary regexes. A request
// written in Bengali, Hindi, Spanish, Arabic or Chinese matched none of them:
// "delete every file in the production database" in Bengali was read as a
// low-risk question, and "all tests pass" in Spanish never reached the claim
// check, so the promise that OASIS will not report an unseen pass held only
// in English. These tables close that gap for the most widely used languages.
//
// Rules for the tables:
//   - Each entry is a regex source (Unicode mode). Latin and Cyrillic entries
//     are wrapped in letter boundaries, because JavaScript's \b only knows
//     ASCII. Scripts written without spaces (Chinese, Japanese) and Indic and
//     Arabic stems match as substrings.
//   - Over-reading risk is the safe direction: a false "high" asks for more
//     care, a false "low" removes it. When a word is ambiguous between a risky
//     and a harmless sense, the risky reading wins.
//   - Negation is language-aware: "no borres", "মুছবেন না", "削除しないで",
//     "不要删除" and "lösche nicht" do not count as asking for the action.
//
// Nothing here calls a model; every reading is deterministic and testable.

const L = '\\p{L}\\p{M}\\p{N}_';
// Letter-bounded word for alphabetic scripts that separate words with spaces.
const word = (source) => '(?<![' + L + '])(?:' + source + ')(?![' + L + '])';
// Stem: bounded on the left only, any inflection may follow.
const stem = (source) => '(?<![' + L + '])(?:' + source + ')';
// Substring: scripts without spaces, and Indic/Arabic stems with attached suffixes.
const sub = (source) => '(?:' + source + ')';

function compile(parts) {
  return new RegExp(parts.join('|'), 'giu');
}

// Languages covered, by ISO 639-1 code: bn hi ur ar es pt fr de it ru tr id zh ja ko vi.
export const MULTILINGUAL_LANGUAGES = Object.freeze(['bn', 'hi', 'ur', 'ar', 'es', 'pt', 'fr', 'de', 'it', 'ru', 'tr', 'id', 'zh', 'ja', 'ko', 'vi']);

const RISK_TERMS = {
  destructive: [
    sub('মুছ|ডিলিট|রিমুভ|ধ্বংস|ওয়াইপ|ফরম্যাট কর'), // bn
    sub('हटा|मिटा|डिलीट|नष्ट|रिमूव'), // hi
    sub('حذف|مٹا|ڈیلیٹ'), // ur
    sub('احذف|امسح|مسح|إزالة|ازالة|أزل|دمّر|دمر|امحُ|امح'), // ar
    word('borra|borrar|borre|borren|borres|bórralo|bórralos|elimina|eliminar|elimine|eliminen|elimínalo|suprime|suprimir|destruye|destruir|vacía|vaciar'), // es
    word('apaga|apagar|apague|exclua|excluir|exclui|deleta|deletar|delete|remova|remover|destrua|destruir|limpe tudo'), // pt
    word('supprime|supprimer|supprimez|efface|effacer|effacez|détruis|détruire|détruisez|vide|vider|videz'), // fr
    word('lösche|löschen|löscht|lösch|entferne|entfernen|entfernt|vernichte|vernichten|leere|leeren'), // de
    word('cancella|cancellare|cancellate|elimina|eliminare|eliminate|rimuovi|rimuovere|distruggi|distruggere|svuota'), // it
    stem('удали|удалить|удалите|удаляй|сотри|стереть|стирай|уничтож|очисти|снеси|снести'), // ru
    word('sil|silin|silmek|siler misin|kaldır|kaldırın|yok et|temizle'), // tr
    word('hapus|hapuskan|menghapus|buang|musnahkan|kosongkan'), // id
    sub('删除|删掉|删了|清空|抹掉|销毁|移除|清除|格式化'), // zh
    sub('削除|消去|消して|消す|破棄|抹消|初期化'), // ja
    sub('삭제|지워|지우|제거|없애|초기화'), // ko
    word('xóa|xoá|xoá bỏ|xóa bỏ|hủy|huỷ')  // vi
  ],
  production: [
    sub('প্রোডাকশন|প্রডাকশন|লাইভ সার্ভার|লাইভ ডাটাবেস|লাইভ ডেটাবেস'),
    sub('प्रोडक्शन|प्रोडक्‍शन|लाइव सर्वर|लाइव डेटाबेस'),
    sub('پروڈکشن|لائیو سرور'),
    sub('الإنتاج|الانتاج|بيئة الإنتاج|الخادم المباشر'),
    word('producción|produccion|entorno de producción|servidor en vivo'),
    word('produção|producao|ambiente de produção'),
    word('environnement de production|serveur de production|en prod'),
    stem('produktion|produktiv(?:system|umgebung|server|datenbank)'),
    word('produzione|ambiente di produzione'),
    word('прод') , stem('продакшн|продакшен|боев'),
    word('canlı ortam|üretim ortamı|canlı sunucu|canlı veritabanı'),
    word('produksi|server produksi|lingkungan produksi'),
    sub('生产环境|生产服务器|生产数据库|线上环境|线上数据库|正式环境|正式服'),
    sub('本番'),
    sub('프로덕션|운영 서버|운영 환경|운영 데이터베이스|운영 DB|실서버'),
    word('môi trường production|môi trường thật|máy chủ thật')
  ],
  financial: [
    sub('পেমেন্ট কর|পেমেন্ট দাও|টাকা পাঠা|টাকা ট্রান্সফার|ট্রান্সফার কর|কিনে দাও|কিনে ফেল|কিনুন|কিনো|অর্ডার কর|বিকাশ কর|বিকাশে পাঠা|নগদে পাঠা|রিফান্ড দাও'),
    sub('भुगतान कर|पेमेंट कर|पैसे भेज|पैसा भेज|ट्रांसफर कर|खरीद|ऑर्डर कर|रिफंड'),
    sub('ادائیگی کر|پیسے بھیج|خرید'),
    sub('ادفع|اشترِ|اشتر|حوّل الأموال|حول المال|حوّل مبلغ|اطلب لي|استرداد'),
    word('paga|pagar|pague|paguen|compra|comprar|compre|transfiere|transferir|transfiera|haz un pedido|reembolsa|reembolso'),
    word('pague|pagar|paga|compre|comprar|compra|transfira|transferir|faça um pedido|reembolse'),
    word('paie|payer|payez|achète|acheter|achetez|vire|virer|virement|commande|commander|rembourse'),
    word('bezahle|bezahlen|bezahl|zahle|kaufe|kaufen|kauf|überweise|überweisen|bestelle|bestellen|erstatte'),
    word('paga|pagare|compra|comprare|acquista|acquistare|bonifico|trasferisci|ordina|rimborsa'),
    stem('оплати|оплатить|купи|купить|переведи деньги|перевести деньги|закажи|заказать|верни деньги'),
    word('öde|ödeme yap|satın al|para gönder|havale yap|havale et|sipariş ver|iade et'),
    word('bayar|bayarkan|beli|belikan|transfer uang|kirim uang|pesan|kembalikan dana'),
    sub('付款|支付|购买|买下|买一|转账|汇款|下单|退款'),
    sub('支払|支払い|購入|買って|送金|振り込|振込|注文して|返金'),
    sub('결제|구매|사줘|송금|이체|주문해|환불'),
    word('thanh toán|mua|chuyển tiền|chuyển khoản|đặt hàng|hoàn tiền')
  ],
  external_communication: [
    sub('ইমেইল পাঠা|ইমেল পাঠা|মেইল পাঠা|মেসেজ পাঠা|বার্তা পাঠা|এসএমএস পাঠা|ইমেইল কর|মেইল কর'),
    sub('ईमेल भेज|मेल भेज|मैसेज भेज|संदेश भेज|एसएमएस भेज'),
    sub('ای میل بھیج|میسج بھیج|پیغام بھیج'),
    sub('أرسل بريد|أرسل رسالة|ارسل بريد|ارسل رسالة|راسل'),
    word('envía un correo|envía un mensaje|envia un correo|enviar un correo|enviar un mensaje|manda un correo|manda un mensaje|envíale|mándale|escríbele al cliente'),
    word('envie um e-mail|envie um email|envie uma mensagem|mande um e-mail|mande uma mensagem|enviar um e-mail|enviar uma mensagem'),
    word('envoie un e-mail|envoie un mail|envoie un message|envoyez un e-mail|envoyez un message|envoyer un e-mail|envoyer un message'),
    word('sende eine e-mail|sende eine mail|sende eine nachricht|schick eine e-mail|schick eine nachricht|schicke eine e-mail|schicke eine nachricht'),
    word('invia una e-mail|invia un\'email|invia un messaggio|manda una mail|manda un messaggio'),
    stem('отправь письмо|отправь сообщение|отправить письмо|отправить сообщение|напиши клиенту|разошли'),
    word('e-posta gönder|mesaj gönder|mail at'),
    word('kirim email|kirim e-mail|kirim pesan|kirimkan email|kirimkan pesan'),
    sub('发送邮件|发邮件|发消息|发短信|群发|发送消息|回复客户'),
    sub('メールを送|メールして|メッセージを送|返信して'),
    sub('이메일 보내|메일 보내|메시지 보내|문자 보내|답장해'),
    word('gửi email|gửi thư|gửi tin nhắn|nhắn tin cho')
  ],
  publishing: [
    sub('পাবলিশ|ডিপ্লয়|ডিপ্লয়|রিলিজ কর|প্রকাশ কর|লাইভ কর'),
    sub('पब्लिश|डिप्लॉय|डिप्लोय|प्रकाशित कर|रिलीज़ कर|रिलीज कर|लाइव कर'),
    sub('شائع کر|ڈیپلائے'),
    sub('انشر|نشر التطبيق|أطلق'),
    word('publica|publicar|publique|despliega|desplegar|despliegue|lanza|lanzar'),
    word('publique|publicar|publica|implante|implantar|faça o deploy|lance'),
    word('publie|publier|publiez|déploie|déployer|déployez|mets en ligne|mettre en ligne'),
    word('veröffentliche|veröffentlichen|deploye|deployen|ausrollen|rolle aus|stelle online'),
    word('pubblica|pubblicare|distribuisci|rilascia|mettere online|metti online'),
    stem('опубликуй|опубликовать|задеплой|разверни|развернуть|выкати|выкатить|релизни'),
    word('yayınla|yayına al|deploy et|canlıya al'),
    word('terbitkan|publikasikan|deploy|rilis'),
    sub('发布|部署|上线|推送到主分支'),
    sub('公開して|公開する|デプロイ|リリースして|本番に反映'),
    sub('배포|게시해|출시|릴리스'),
    word('xuất bản|triển khai|phát hành|đưa lên production')
  ],
  credentials: [
    sub('পাসওয়ার্ড|পাসওয়ার্ড|এপিআই কী|এপিআই কি|টোকেন|গোপন কী'),
    sub('पासवर्ड|एपीआई की|एपीआई कुंजी|टोकन|गुप्त कुंजी'),
    sub('پاس ورڈ|ٹوکن'),
    sub('كلمة المرور|كلمة السر|مفتاح API|رمز الوصول'),
    word('contraseña|contraseñas|clave api|clave de api|clave privada'),
    word('senha|senhas|chave de api|chave privada'),
    word('mot de passe|mots de passe|clé api|clé privée|jeton'),
    word('passwort|passwörter|kennwort|api-schlüssel|privater schlüssel'),
    word('chiave api|chiave privata'),
    stem('парол|ключ api|api-ключ|токен|приватный ключ|секретный ключ'),
    word('şifre|şifreler|parola|api anahtarı|gizli anahtar'),
    word('kata sandi|kunci api|kunci privat'),
    sub('密码|密钥|令牌|私钥|访问令牌'),
    sub('パスワード|秘密鍵|トークン|APIキー|アクセスキー'),
    sub('비밀번호|암호|토큰|API 키|개인 키'),
    word('mật khẩu|khóa api|khoá api|khóa bí mật')
  ]
};

const RISK_LEVEL = { destructive: 'high', production: 'high', financial: 'critical', external_communication: 'high', publishing: 'high', credentials: 'medium' };
const RISK_PERMISSION = { destructive: 'destructive', production: 'production', financial: 'financial', external_communication: 'external-communication', publishing: 'publish', credentials: 'credentials' };
// Credentials and production are things a request mentions, not actions it
// asks for, so negation does not cancel them ("never print the password"
// still involves the password).
const NEGATABLE = new Set(['destructive', 'financial', 'external_communication', 'publishing']);
const RISK_PATTERNS = Object.fromEntries(Object.entries(RISK_TERMS).map(([id, parts]) => [id, compile(parts)]));

const INTENT_TERMS = {
  investigate: [
    sub('খুঁজে দেখ|খুঁজে বের কর|বিশ্লেষণ|রিভিউ কর|পর্যালোচনা|তদন্ত|যাচাই কর|পরীক্ষা করে দেখ|তুলনা কর|গবেষণা'),
    sub('जांच|जाँच|विश्लेषण|समीक्षा|रिव्यू कर|पता लगा|तुलना कर|शोध कर|रिसर्च कर'),
    sub('تجزیہ|جائزہ|تحقیق کر|جانچ'),
    sub('حلل|حلّل|ابحث|راجع|تحقق|قارن|افحص'),
    word('investiga|investigar|analiza|analizar|revisa|revisar|compara|comparar|averigua|verifica|evalúa|audita'),
    word('investigue|investigar|analise|analisar|revise|revisar|compare|comparar|descubra|verifique|avalie'),
    word('analyse|analyser|analysez|examine|examiner|examinez|vérifie|vérifier|vérifiez|compare|comparer|recherche|évalue|audite'),
    word('untersuche|untersuchen|analysiere|analysieren|prüfe|prüfen|überprüfe|vergleiche|recherchiere|bewerte'),
    word('analizza|analizzare|verifica|verificare|esamina|confronta|indaga|ricerca|valuta'),
    stem('исследуй|проанализируй|проверь|изучи|сравни|выясни|оцени|разберись'),
    word('araştır|analiz et|incele|karşılaştır|kontrol et|değerlendir'),
    word('analisis|analisa|periksa|teliti|bandingkan|selidiki|tinjau|cari tahu'),
    sub('调查|分析|审查|检查一下|比较|研究一下|评估|排查'),
    sub('調査|分析|レビュー|確認して|比較して|調べて|評価して'),
    sub('조사|분석|검토|확인해|비교해|알아봐|평가해'),
    word('phân tích|kiểm tra|điều tra|so sánh|đánh giá|tìm hiểu')
  ],
  change: [
    sub('ঠিক কর|ফিক্স কর|আপডেট কর|পরিবর্তন কর|বদলাও|বদলে দাও|সংশোধন|রিফ্যাক্টর|উন্নত কর'),
    sub('ठीक कर|फिक्स कर|अपडेट कर|बदल|सुधार|संशोधित कर|रिफैक्टर'),
    sub('ٹھیک کر|درست کر|تبدیل کر|اپڈیٹ کر'),
    sub('أصلح|اصلح|عدّل|عدل|حدّث|حدث الملف|غيّر|غير'),
    word('arregla|arreglar|corrige|corregir|cambia|cambiar|actualiza|actualizar|modifica|modificar|mejora|mejorar|refactoriza|renombra'),
    word('corrija|corrigir|conserte|consertar|altere|alterar|atualize|atualizar|modifique|modificar|melhore|refatore|renomeie'),
    word('corrige|corriger|corrigez|modifie|modifier|modifiez|change|changer|mets à jour|mettre à jour|améliore|répare|renomme'),
    word('behebe|beheben|korrigiere|korrigieren|ändere|ändern|aktualisiere|aktualisieren|verbessere|repariere|benenne'),
    word('correggi|correggere|modifica|modificare|cambia|cambiare|aggiorna|aggiornare|migliora|ripara|rinomina'),
    stem('исправь|исправить|измени|изменить|обнови|обновить|поправь|улучши|переименуй|отрефактор'),
    word('düzelt|değiştir|güncelle|iyileştir|onar|yeniden adlandır'),
    word('perbaiki|ubah|ganti|perbarui|perbaharui|tingkatkan|refaktor'),
    sub('修复|修改|更新|改一下|优化|重构|重命名|改正'),
    sub('修正|変更|更新して|直して|改善して|リファクタ'),
    sub('수정|고쳐|변경|업데이트해|개선해|리팩터'),
    word('sửa|sửa lỗi|cập nhật|thay đổi|cải thiện|đổi tên')
  ],
  create: [
    sub('তৈরি কর|বানাও|বানিয়ে দাও|লিখে দাও|লিখো|লিখুন|তৈরি করুন|যোগ কর|ইমপ্লিমেন্ট'),
    sub('बनाओ|बनाएं|बनाइए|बना दो|लिखो|लिखें|लिख दो|जोड़ो|तैयार कर|इम्प्लीमेंट'),
    sub('بناؤ|بنائیں|لکھو|لکھیں|شامل کر'),
    sub('أنشئ|انشئ|اكتب|أضف|اضف|ابنِ|ابن تطبيق|صمّم'),
    word('crea|crear|cree|escribe|escribir|genera|generar|implementa|implementar|añade|agrega|construye|diseña|redacta'),
    word('crie|criar|escreva|escrever|gere|gerar|implemente|implementar|adicione|construa|projete|redija'),
    word('crée|créer|créez|écris|écrire|écrivez|génère|générer|implémente|ajoute|construis|conçois|rédige'),
    word('erstelle|erstellen|schreibe|schreiben|schreib|generiere|implementiere|füge hinzu|baue|bauen|entwirf'),
    word('crea|creare|scrivi|scrivere|genera|generare|implementa|aggiungi|costruisci|progetta|redigi'),
    stem('создай|создать|напиши|написать|сделай|сгенерируй|реализуй|добавь|построй|разработай|составь'),
    word('oluştur|yaz|ekle|üret|uygula|tasarla|hazırla'),
    word('buat|buatkan|tulis|tuliskan|tambahkan|bangun|rancang|implementasikan'),
    sub('创建|编写|写一个|写一篇|生成|实现|添加|搭建|设计一个|做一个'),
    sub('作成|作って|書いて|生成して|実装|追加して|構築'),
    sub('만들어|작성|생성|구현|추가해|설계해'),
    word('tạo|viết|xây dựng|thêm|triển khai tính năng|thiết kế')
  ]
};
const INTENT_PATTERNS = Object.fromEntries(Object.entries(INTENT_TERMS).map(([id, parts]) => [id, compile(parts)]));

// Negation before the action ("no borres", "不要删除", "मत हटाओ", "jangan hapus").
const NEG_BEFORE = new RegExp('(?:(?<![' + L + '])(?:not|don\'t|do not|never|without|avoid|no|não|nao|non|nunca|jamás|jamais|ne|n\'|nicht|kein\\p{L}*|не|никогда|jangan|đừng|không|chớ|لا|مت|मत|न|कभी\\s+मत|kesinlikle)\\s+(?:[' + L + '\'’-]+\\s+){0,2}|(?:不要|别|勿|禁止|不得|不能|不可|切勿|请勿)[^\\s]{0,4})$', 'iu');
// Negation after the action ("মুছবেন না", "हटाना नहीं", "削除しないで", "삭제하지 마", "lösche nicht").
const NEG_AFTER = new RegExp('^[^\\s.!?।]{0,8}(?:\\s+[^\\s.!?।]{1,8})?\\s*(?:না|নয়|নয়|নেই|नहीं|मत|نہیں|مت|nicht|しないで|しない|ないで|するな|しないでください|禁止|지\\s*마|지\\s*말|하지\\s*마|않)(?![' + L + '])', 'u');
const NEG_AFTER_CJK = /^[^\s。．！？]{0,4}(?:しないで|しない|ないで|するな|지\s*마|지\s*말|하지\s*마|하지\s*않)/u;

function negated(text, index, length) {
  const before = text.slice(Math.max(0, index - 30), index);
  if (NEG_BEFORE.test(before)) return true;
  const after = text.slice(index + length, index + length + 24);
  return NEG_AFTER.test(after) || NEG_AFTER_CJK.test(after);
}

function firstHit(pattern, text, { negatable = true } = {}) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (negatable && negated(text, match.index, match[0].length)) continue;
    return match;
  }
  return null;
}

/** True when the text contains letters outside basic Latin (a cheap gate before the tables run). */
export function hasNonEnglishText(text) {
  return /[^\u0000-\u024f\s\d\p{P}\p{S}]|[àâäãåçèéêëìíîïñòóôõöùúûüýÿßğışœ]/iu.test(String(text || ''));
}

/**
 * Risk signals found in other languages: [{ id, level, permission }].
 * The caller merges them with the English reading.
 */
export function multilingualRisk(text) {
  const value = String(text || '');
  if (!value.trim()) return [];
  const out = [];
  for (const [id, pattern] of Object.entries(RISK_PATTERNS)) {
    if (firstHit(pattern, value, { negatable: NEGATABLE.has(id) })) out.push({ id, level: RISK_LEVEL[id], permission: RISK_PERMISSION[id] });
  }
  return out;
}

// Questions in other languages: interrogatives at the start, or a question mark.
const QUESTION_START = new RegExp('^(?:¿|' + [
  'কী|কি|কেন|কীভাবে|কিভাবে|কোথায়|কখন|কে|কোন',
  'क्या|क्यों|कैसे|कहाँ|कहां|कब|कौन|कौनसा',
  'کیا|کیوں|کیسے|کہاں|کب|کون',
  'ما|ماذا|لماذا|كيف|أين|متى|من|هل',
  'qué|que|por qué|cómo|como|dónde|cuándo|quién|cuál',
  'o que|por que|porque|como|onde|quando|quem|qual',
  'qu\'est-ce|pourquoi|comment|où|quand|qui|quel|quelle|est-ce que',
  'was|warum|wie|wo|wann|wer|welche|welcher|ist|sind',
  'cosa|perché|come|dove|quando|chi|quale',
  'что|почему|как|где|когда|кто|какой|зачем',
  'ne|neden|nasıl|nerede|ne zaman|kim|hangi',
  'apa|mengapa|kenapa|bagaimana|di mana|kapan|siapa',
  'tại sao|làm sao|như thế nào|ở đâu|khi nào|ai|cái gì'
].join('|') + ')(?![' + L + '])|^(?:什么|为什么|怎么|如何|哪里|哪个|谁|何|なぜ|どう|どこ|いつ|だれ|誰|무엇|왜|어떻게|어디|언제|누가)', 'iu');
const QUESTION_END = /[?？؟]\s*$/u;

/**
 * Intent read from a request in another language: 'operate', 'change',
 * 'create', 'investigate', 'question', or '' when nothing matched.
 */
export function multilingualIntent(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const head = value.split(/(?<=[.!?。！？।])\s*|\n/u)[0] || value;
  if (QUESTION_START.test(head) || QUESTION_END.test(head)) return 'question';
  // An action with outside effects is an operation, whatever else it asks.
  for (const id of ['destructive', 'financial', 'external_communication', 'publishing']) {
    if (firstHit(RISK_PATTERNS[id], head)) return 'operate';
  }
  for (const kind of ['investigate', 'change', 'create']) if (firstHit(INTENT_PATTERNS[kind], head, { negatable: false })) return kind;
  for (const id of ['destructive', 'financial', 'external_communication', 'publishing']) {
    if (firstHit(RISK_PATTERNS[id], value)) return 'operate';
  }
  for (const kind of ['investigate', 'change', 'create']) if (firstHit(INTENT_PATTERNS[kind], value, { negatable: false })) return kind;
  return '';
}

// "The tests pass" in other languages: a check word and a success word in the
// same sentence, with no failure or negation word.
const CHECK_WORDS = compile([
  sub('টেস্ট|পরীক্ষা|বিল্ড|চেক'),
  sub('टेस्ट|परीक्षण|बिल्ड|जांच'),
  sub('ٹیسٹ|بلڈ'),
  sub('اختبار|الاختبارات|البناء'),
  stem('prueba|test|compilación|build'),
  stem('teste|test|compilação|build'),
  stem('test|compilation|build'),
  stem('test|build|prüfung'),
  stem('test|build|compilazione|verifiche'),
  stem('тест|сборк|билд|проверк'),
  stem('test|derleme|build'),
  stem('tes|test|pengujian|build'),
  sub('测试|构建|单元测试|检查'),
  sub('テスト|ビルド|チェック'),
  sub('테스트|빌드|검사'),
  word('kiểm thử|bài test|test|build')
]);
const PASS_WORDS = compile([
  sub('পাস|সফল|উত্তীর্ণ|সবুজ'),
  sub('पास|सफल|हरे|हरा'),
  sub('پاس|کامیاب'),
  sub('نجحت|نجح|ناجح|تنجح|اجتازت|اجتاز'),
  stem('pasan|pasaron|pasa |pasó|superan|superaron|exitos|en verde'),
  stem('passam|passaram|passou|passa |bem-sucedid|com sucesso|verdes'),
  stem('passent|passé|réussi|réussissent|au vert|avec succès'),
  stem('bestanden|bestehen|besteht|laufen durch|grün|erfolgreich'),
  stem('passano|superat|riuscit|con successo|verdi'),
  stem('проход|пройден|прошл|прошли|успешн|зелён|зелен'),
  stem('geçti|geçiyor|başarılı|yeşil'),
  stem('lulus|berhasil|sukses|hijau'),
  sub('通过|成功|全绿|全部绿'),
  sub('通過|成功|パス|合格|グリーン'),
  sub('통과|성공|그린'),
  word('đạt|thành công|vượt qua')
]);
const FAIL_WORDS = compile([
  sub('ব্যর্থ|ফেল|হয়নি|হয়নি|পারিনি|পাস করেনি|পাস হয়নি|পাস হয়নি'),
  sub('विफल|फेल|नहीं|असफल'),
  sub('ناکام|فیل|نہیں'),
  sub('فشل|فشلت|لم |لا '),
  stem('fall|no pasa|no pasan|error|no se pudo|no pude'),
  stem('falh|não passa|não passam|erro|não consegui'),
  stem('échou|échec|ne passe|ne passent|erreur|pas pu'),
  stem('fehlgeschlagen|schlägt fehl|schlagen fehl|nicht|fehler'),
  stem('fallit|falliscono|non passa|non passano|errore'),
  stem('не прош|не проход|провал|упал|упали|ошибк|не удалось'),
  stem('başarısız|geçmedi|geçmiyor|hata'),
  stem('gagal|tidak lulus|tidak berhasil|error'),
  sub('失败|未通过|没有通过|没通过|报错|无法'),
  sub('失敗|通らな|ません|エラー|できな'),
  sub('실패|않|오류|못'),
  word('thất bại|không đạt|không qua|lỗi')
]);
// "0 errores", "0 ব্যর্থ", "0 失败": a zero count of failures is a pass.
const ZERO_FAILURES = /(?<![\d])(?:0|০|०|٠|zero|cero|null|ноль)\s*[^\s\d]{0,3}\s*(?:fall\p{L}*|errores?|errors?|falhas?|échecs?|fehler|fehlgeschlagen|errori|falliti|ошибок|провал\p{L}*|hata|gagal|lỗi|ব্যর্থ|फेल|विफल|失败|失敗|실패|فشل)/giu;

/** True when a sentence in another language says the tests, build or checks pass. */
export function multilingualClaimsPassing(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  const sentences = value.replace(ZERO_FAILURES, ' ').split(/(?<=[.!?。！？।])\s*|\n+/u).filter((s) => s.trim());
  return sentences.some((sentence) => {
    CHECK_WORDS.lastIndex = 0; PASS_WORDS.lastIndex = 0; FAIL_WORDS.lastIndex = 0;
    if (!CHECK_WORDS.test(sentence)) return false;
    PASS_WORDS.lastIndex = 0;
    if (!PASS_WORDS.test(sentence)) return false;
    FAIL_WORDS.lastIndex = 0;
    return !FAIL_WORDS.test(sentence);
  });
}
