# ArtaQuest — unified messaging (single source of truth, 2026-06-10)

Every front-facing surface (SPA copy, theme SEO, FAQ, llms.txt, emails) tells ONE story, in this
order, with these words. If copy on any surface contradicts this file, the copy is wrong.

## The one-liner

> ArtaQuest is the free learning arena: watch the best free lectures on the internet,
> reply with your sharpest thinking, and the most-upvoted minds win real gold every new moon.

Tagline (3 beats): **Watch free. Think sharp. Win gold.**
Spiritual through-line (eyebrow): **Quest for the truth.**

## The model — the same five beats, everywhere, in this order

1. **Watching is free.** Every video, for everyone, forever — no account needed.
2. **No quizzes, no right answers.** After each video you post a **reply** — the question or
   thought it leaves you with — and **upvote** at least one peer's reply.
3. **Every course is a competition.** Joining costs **1 gold-backed coin per video** (a course of
   N videos costs ₳N), and those entry fees are the prize: **80% of the course's revenue** is the
   prize pool for its top three questers.
4. **Seasons end on each new moon.** Most upvotes wins; the podium splits the pool **50/30/20**;
   finish the course (earn the certificate) to collect. Prizes unlock at 20 enrolled learners.
5. **The money is real.** ₳1 = 1 mg of real gold held in full reserve — buy in or cash out at the
   live gold rate. If the fee is a barrier, **grants** (donor-funded bursaries) cover it.

Supporting pillars: radical transparency (the entire database is public); one rule only (ArtaMod
filters hate and fear, nothing else); for everyone (~133 languages, works offline);
independent (registered Canadian non-profit, no investors); creators earn a tiered share
of the remaining 20% as they climb the ladder (50% → 100%).

## Voice

Plain, warm, confident. Short declaratives, second person, concrete numbers, British spelling,
no hype adjectives, no trailing periods on headings. User-facing nouns: **video** (never
"section"/"lesson"), **reply** (never "comment"/"question" for the learner's post), **upvote**,
**quester**, **season**, **prize pool**, **entry fee**, **Arta Coin (₳)**, **certificate**.

## Hand-translated languages (fa · tr · ar · fr · es)

Address: fa = شما (formal-warm) · tr = sen (warm, modern app convention) · ar = MSA, أنت ·
fr = vous · es = tú (neutral international). RTL: fa + ar. Persian uses ZWNJ (نیم‌فاصله) correctly.
Brand names never translated: ArtaQuest, Arta Coin, ArtaMod, ₳. Seed file: `tools/i18n/seed.ndjson`
(one JSON object per line: `{"en":…,"fa":…,"tr":…,"ar":…,"fr":…,"es":…}`), loaded by
`tools/i18n/seed.php` into the content-addressed mesh (`ay_translations`, key = md5(en), one row
per language, write-once, `status='human'`). All other languages fall to the auto-translate mesh.

### Glossary (locked — do not improvise)

| en | fa | tr | ar | fr | es |
|---|---|---|---|---|---|
| quester | پرسشگر | kâşif | المستكشف | questeur | explorador |
| reply (n) | پاسخ | yanıt | رد | réponse | respuesta |
| upvote (n) | رأی مثبت | olumlu oy | تصويت مؤيد | vote | voto |
| season | فصل | sezon | موسم | saison | temporada |
| new moon | ماه نو | yeniay | المحاق | nouvelle lune | luna nueva |
| prize pool | صندوق جوایز | ödül havuzu | صندوق الجوائز | cagnotte | bolsa de premios |
| entry fee | ورودیه | katılım ücreti | رسم الدخول | droit d'entrée | cuota de entrada |
| certificate | گواهینامه | sertifika | الشهادة | certificat | certificado |
| gold-backed | باپشتوانهٔ طلا | altın karşılıklı | مدعومة بالذهب | adossé à l'or | respaldado en oro |
| wallet | کیف پول | cüzdan | المحفظة | portefeuille | billetera |
| reserve | ذخیرهٔ طلا | rezerv | الاحتياطي | réserve | reserva |
| points | امتیاز | puan | نقاط | points | puntos |
| tiers (Quester→Legend) | پرسشگر، آفریننده، خبره، پیشگام، اسطوره | Kâşif, Yaratıcı, Uzman, Öncü, Efsane | المستكشف، المبدع، الخبير، الرائد، الأسطورة | Questeur, Créateur, Expert, Pionnier, Légende | Explorador, Creador, Experto, Pionero, Leyenda |
| ArtaMod (brand — never translated; was “Fearometer”) | ArtaMod | ArtaMod | ArtaMod | ArtaMod | ArtaMod |
| grant | کمک‌هزینه | hibe | منحة | subvention | subvención |
| bursary | بورسیه | burs | منحة دراسية | bourse | beca |
| Topics (nav) | موضوع‌ها | Konular | المواضيع | Thèmes | Temas |
| Discussions (nav) | گفت‌وگوها | Tartışmalar | النقاشات | Discussions | Debates |
| Rankings (nav) | رتبه‌بندی | Sıralama | التصنيف | Classement | Clasificación |
| Explore (nav) | کاوش | Keşfet | استكشاف | Explorer | Explorar |
| Donations (nav) | کمک‌های مالی | Bağışlar | التبرعات | Dons | Donaciones |
| Teach (nav) | تدریس | Öğretin | التدريس | Enseigner | Enseñar |
| Contribute (nav) | مشارکت | Katkı | المساهمة | Contribuer | Contribuir |
| Offline (nav) | آفلاین | Çevrimdışı | بلا إنترنت | Hors ligne | Sin conexión |
| Open data | دادهٔ باز | Açık veri | البيانات المفتوحة | Données ouvertes | Datos abiertos |
| Sign in / Register | ورود / ثبت‌نام | Giriş yap / Kaydol | تسجيل الدخول / إنشاء حساب | Se connecter / S'inscrire | Iniciar sesión / Regístrate |
| Watching is free | تماشا رایگان است | İzlemek ücretsiz | المشاهدة مجانية | Regarder est gratuit | Ver es gratis |
| Tagline | رایگان ببین. تیز بیندیش. طلا ببر. | Ücretsiz izle. Keskin düşün. Altını kazan. | شاهد مجانًا. فكِّر بحدّة. واربح الذهب. | Regardez librement. Pensez juste. Gagnez de l'or. | Mira gratis. Piensa agudo. Gana oro. |
| Quest for the truth | در جست‌وجوی حقیقت | Hakikat arayışı | السعي وراء الحقيقة | En quête de vérité | En busca de la verdad |
