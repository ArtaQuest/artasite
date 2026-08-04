# ArtaQuest — unified messaging (single source of truth)

Every front-facing surface (SPA copy, theme SEO, FAQ, llms.txt, emails) tells ONE story, in this
order, with these words. If copy on any surface contradicts this file, the copy is wrong.

**Rewritten 2026-08-04.** This file still described the platform retired on 2026-07-13 — watching
lectures, replies and upvotes, courses as competitions, new-moon seasons, certificates, ₳1 per video.
None of that exists. A source of truth that is out of date is worse than none, because it is the one
document an author is told to trust over what they can see.

## The one-liner

> ArtaQuest is a social feed of citable, reproducible work: every post is a public Kaggle notebook
> that has already been run, and only its author can publish it.

Tagline (3 beats): **Run it. Check it. Publish it yourself.**
Spiritual through-line (eyebrow): **Quest for the truth.**

## The model — the same five beats, everywhere, in this order

1. **Reading, playing and running are free.** Every published work, for everyone, no account needed —
   and anyone can re-run it on Kaggle for as long as its author keeps it there.
2. **Every post is a public Kaggle notebook that has been run.** The author pastes the link to its
   output page and picks which of its output files to publish.
3. **A checklist reads Kaggle's public record.** Four things a stranger can check without us: the
   notebook is public; every input is public; the run finished and produced these files; it ran with
   the internet switched off — or, if it did not, we say so plainly. Nothing is scored, ranked,
   graded or judged. Kaggle runs the notebook and enforces the offline switch; we only report what
   its record says.
4. **Only the author publishes.** A single-use secret goes to their own registered email; their
   click, signed by their device passkey, publishes the work and mints its permanent DOI short link.
   No token, agent, relay or operator can take that step. The work is credited to its KAGGLE author,
   never to whoever submitted it.
5. **Members earn only by winning challenges.** A member founds a challenge (kind + topic +
   full-moon deadline + entry fee); every entrant pays the fee into the pool; at the deadline the
   most-hearted entry takes the whole pool. The Foundation never touches a pool.

Supporting pillars: radical transparency (the entire database is public); one rule only (ArtaMod
filters hate and fear, nothing else); for everyone (~133 languages, works offline); independent
(registered Canadian non-profit, no investors, runs on donations).

## Voice

Plain, warm, confident. Short declaratives, second person, concrete numbers, British spelling, no
hype adjectives, no trailing periods on headings. Written for a reader whose English is their second
language: common words, active voice, few idioms.

User-facing nouns — one name per concept, never a synonym:
**work** or **post** (never "submission"/"kernel" to a member), **notebook** (never "kernel"),
**challenge** (never "tournament"/"competition"), **heart** (never "vote"/"upvote"),
**member** (never "quester"/"user"), **entry fee**, **prize pool**, **Arta Coin (₳)**,
**checklist** (never "review"/"panel"/"score"), **DOI** — glossed on first use as a permanent
citation link.

Never claim: that we run the notebook, that we enforce the offline switch, that anything is scored or
graded, that a coin is "held in full reserve" (say a claim on 1 mg, and point at the live ratio), or
that a work lasts "forever" (the DOI does; the notebook is the author's to delete).

## Hand-translated languages (fa · tr · ar · fr · es)

Address: fa = شما (formal-warm) · tr = sen (warm, modern app convention) · ar = MSA, أنت ·
fr = vous · es = tú (neutral international). RTL: fa + ar. Persian uses ZWNJ (نیم‌فاصله) correctly.
Brand names never translated: ArtaQuest, Arta Coin, ArtaMod, ₳. Seed file: `tools/i18n/seed.ndjson`
(one JSON object per line: `{"en":…,"fa":…,"tr":…,"ar":…,"fr":…,"es":…}`), loaded by
`tools/i18n/seed.php` into the content-addressed mesh (`ay_translations`, key = md5(en), one row
per language, write-once, `status='human'`). All other languages fall to the auto-translate mesh.

### Glossary (locked — do not improvise)

Rows for the retired model (quester, season, new moon, certificate, upvote) are kept because the
translations exist in the mesh and removing them would orphan rows; do NOT use those terms in new
copy. The live vocabulary is the list under Voice above.

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
