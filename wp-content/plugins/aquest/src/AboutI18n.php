<?php
/**
 * Hand-written Persian and Arabic for the founder's note on /about.
 *
 * WHY THIS EXISTS. Every other string on the site is machine-translated by the mesh and that is
 * fine — it is platform copy. This one is not: it is a signed, first-person account of somebody's
 * life, in the two languages he actually speaks, read by the people most likely to notice a
 * machine's phrasing. A relay translation of "we were raised by a single mom" or "the universe's
 * masterpiece" is intelligible and slightly wrong in a way its author would feel, so these are
 * written rather than generated.
 *
 * HOW IT SURVIVES THE MESH. `aq_translations` is content-addressed on md5 of the ENGLISH source,
 * and the ArtaTranslate upgrade queue claims rows `WHERE status = 'auto'` (Artaai::160). Rows are
 * seeded with `status = 'human'`, so:
 *   • the queue never claims them and no relay pass can overwrite them;
 *   • `I18n::store()` only backfills `status='auto' AND translated_text=''`, so an anonymous
 *     /i18n/save from a visitor's browser cannot clobber them either;
 *   • `I18n::resolve()` and `cached_many()` select on (lang, source_hash) with NO status filter,
 *     so they are served exactly like any other hit.
 *
 * THE FRAGILE PART, AND ITS GUARD. The key is md5 of the English text, so changing one character of
 * a paragraph in About.tsx silently orphans its translation — the page would quietly fall back to
 * machine output with nothing failing. `tools/about-i18n-gate.php` (wired into preflight) asserts
 * that every English source below still appears verbatim in About.tsx, and fails the build if not.
 * If you edit the note, re-run the gate; it prints the paragraphs that no longer match.
 */

namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

class AboutI18n {

	/** Option gating the seed. Presence-gated, never version-gated (a version-keyed seed has
	 *  destroyed real data in this codebase before). Bump the suffix to force a re-seed. */
	const SEEDED = 'aq_about_i18n_seeded_v1';

	/**
	 * english => [ fa, ar ].
	 *
	 * The English keys MUST match About.tsx byte for byte, including the em dashes and the
	 * curly apostrophes. Do not "tidy" the punctuation here.
	 */
	public static function pairs() {
		return [
			// ── labels (the margin navigation beside each paragraph) ───────────────────────────
			'Tehran, 1994' => [ 'تهران، ۱۹۹۴', 'طهران، 1994' ],
			'The climb'    => [ 'بالا رفتن', 'الصعود' ],
			'Why I left the PhD' => [ 'چرا دکترا را رها کردم', 'لماذا تركتُ الدكتوراه' ],
			'What science cannot ask' => [ 'آنچه علم نمی‌تواند بپرسد', 'ما لا يستطيع العلم أن يسأله' ],
			'Why ArtaQuest' => [ 'چرا آرتاکوئست', 'لماذا آرتاكويست' ],
			'From the founder' => [ 'از بنیان‌گذار', 'من المؤسِّس' ],

			// ── the note itself ────────────────────────────────────────────────────────────────
			'I was born in Tehran on 15 February 1994. I have two sisters, and we were raised by a single mom who taught French and English. I love physics, and as a teenager I competed in Iran\'s national olympiads. I have lived most of my life abroad — across Malaysia, Turkey and Canada. I started teaching very young, and I learned that teaching something is the best way to understand it deeply.' => [
				'۱۵ فوریهٔ ۱۹۹۴ در تهران به دنیا آمدم. دو خواهر دارم و مادرمان به‌تنهایی بزرگمان کرد؛ او فرانسه و انگلیسی درس می‌داد. فیزیک را دوست دارم و در نوجوانی در المپیادهای ملی ایران شرکت می‌کردم. بیشتر زندگی‌ام را بیرون از کشور گذرانده‌ام — در مالزی، ترکیه و کانادا. از همان نوجوانی درس دادن را شروع کردم و آموختم که یاد دادنِ چیزی بهترین راه برای فهمیدنِ عمیقِ آن است.',
				'وُلدت في طهران في 15 فبراير 1994. لي أختان، وقد ربّتنا أمٌّ بمفردها كانت تُدرّس الفرنسية والإنجليزية. أُحبّ الفيزياء، وفي مراهقتي شاركت في الأولمبيادات الوطنية في إيران. عشتُ معظم حياتي خارج البلاد — بين ماليزيا وتركيا وكندا. بدأت التدريس في سنٍّ مبكّرة جدًّا، وتعلّمت أنّ تعليم شيءٍ ما هو أفضل طريقة لفهمه فهمًا عميقًا.',
			],
			'I had one goal — to figure out how the universe works, and why — and I followed it upward. From gases to galaxies, then to circuits and information systems, then to machine intelligence, and finally to biological intelligence: the universe\'s masterpiece, the matter with the most degrees of freedom, the most conscious entity. That climb led me to artificial intelligence, and I moved to Montréal to study it for a PhD.' => [
				'یک هدف داشتم — اینکه بفهمم جهان چگونه کار می‌کند، و چرا — و همان را رو به بالا دنبال کردم. از گازها تا کهکشان‌ها، سپس مدارها و سامانه‌های اطلاعات، سپس هوش ماشین، و سرانجام هوش زیستی: شاهکارِ جهان، ماده‌ای با بیشترین درجات آزادی، آگاه‌ترین موجود. آن بالا رفتن مرا به هوش مصنوعی رساند و برای دکترا در همان رشته به مونترآل رفتم.',
				'كان لي هدفٌ واحد — أن أفهم كيف يعمل الكون، ولماذا — فتتبّعته صعودًا. من الغازات إلى المجرّات، ثم إلى الدوائر ونُظُم المعلومات، ثم إلى ذكاء الآلة، وأخيرًا إلى الذكاء البيولوجي: تُحفة الكون، وأكثر المادة امتلاكًا لدرجات الحرية، وأكثر الكيانات وعيًا. قادني ذلك الصعود إلى الذكاء الاصطناعي، فانتقلت إلى مونتريال لدراسته في الدكتوراه.',
			],
			'I passed the qualifying exam, but the more I saw of how these systems are trained, the more they worried me. An AI is trained to minimise entropy — to collapse a world of possibilities into its single most likely answer. That makes it confident, often overconfident: it hands you that answer before you have even finished your question, and points everyone towards the same one. Slowly, this can weaken our ability to think for ourselves — and, by narrowing the variety that change depends on, it could even harm our evolution over time. The danger looked less like the science-fiction fear of machines taking over, and more like people quietly choosing to let the machine think for them. As a researcher, I had no answer to this. As a teacher, I thought I might. So I left the PhD and returned to education.' => [
				'امتحان جامع را گذراندم، اما هرچه بیشتر دیدم این سامانه‌ها چگونه آموزش می‌بینند، بیشتر نگرانم کردند. هوش مصنوعی آموزش می‌بیند که آنتروپی را کمینه کند — یعنی جهانی از امکان‌ها را در محتمل‌ترین پاسخِ واحد فرو بریزد. همین او را مطمئن می‌کند، و اغلب بیش از اندازه مطمئن: پاسخ را پیش از آنکه پرسشت تمام شود جلویت می‌گذارد و همه را به سوی یک پاسخ می‌راند. این کار به‌آرامی می‌تواند توانِ ما را برای اندیشیدنِ مستقل تحلیل ببرد — و با تنگ کردنِ همان تنوعی که تغییر به آن وابسته است، حتی می‌تواند در درازمدت به تکاملِ ما آسیب بزند. خطر کمتر شبیه ترسِ علمی‌تخیلی از چیرگیِ ماشین‌ها بود و بیشتر شبیه آنکه مردم بی‌سروصدا بپذیرند ماشین به‌جای‌شان فکر کند. به‌عنوان پژوهشگر پاسخی برای این نداشتم. به‌عنوان معلم، فکر کردم شاید داشته باشم. پس دکترا را رها کردم و به آموزش بازگشتم.',
				'اجتزتُ امتحان التأهيل، لكن كلّما رأيت أكثر كيف تُدرَّب هذه الأنظمة ازداد قلقي منها. يُدرَّب الذكاء الاصطناعي على تقليل الإنتروبيا إلى أدنى حدّ — أي أن يطوي عالمًا من الاحتمالات في إجابةٍ واحدة هي الأرجح. وهذا يجعله واثقًا، وكثيرًا ما يكون مفرط الثقة: يقدّم لك تلك الإجابة قبل أن تُنهي سؤالك، ويوجّه الجميع نحو الإجابة نفسها. وببطء، قد يُضعف هذا قدرتنا على التفكير بأنفسنا — وبتضييق التنوّع الذي يعتمد عليه التغيّر، قد يضرّ حتى بتطوّرنا مع الزمن. بدا الخطر أقلّ شبهًا بمخاوف الخيال العلمي من سيطرة الآلات، وأكثر شبهًا بأن يختار الناس بهدوء أن تُفكّر الآلة نيابةً عنهم. كباحثٍ لم يكن لديّ جوابٌ لهذا. وكمعلّمٍ ظننتُ أنّي قد أملك واحدًا. فتركتُ الدكتوراه وعدتُ إلى التعليم.',
			],
			'I helped found Neuromatch Academy, an online school for science. My most recent work was at the Center for Rigor, on how to make science itself more honest. Both taught me the same lesson. Science explains how the world works, but on its own it does not ask why — why we use what we learn, or who it serves. That question belongs to philosophy. Without it, science becomes only a tool — and that is how it earns its bad reputation: not because it is wrong, but because, without the why, it is so easily turned to domination and the suppression of people.' => [
				'در بنیان‌گذاریِ «نورومچ آکادمی»، مدرسه‌ای آنلاین برای علم، همکاری کردم. آخرین کارم در «مرکز سخت‌گیری علمی» (Center for Rigor) بود، دربارهٔ اینکه چگونه خودِ علم را صادق‌تر کنیم. هر دو یک درس را به من دادند. علم توضیح می‌دهد جهان چگونه کار می‌کند، اما به‌تنهایی نمی‌پرسد چرا — چرا از آنچه می‌آموزیم استفاده می‌کنیم، و به سودِ چه کسی. آن پرسش از آنِ فلسفه است. بی آن، علم فقط یک ابزار می‌شود — و بدنامی‌اش از همین‌جاست: نه چون نادرست است، بلکه چون بی آن «چرا»، به‌سادگی به خدمتِ سلطه و سرکوبِ مردم درمی‌آید.',
				'شاركتُ في تأسيس «نيوروماتش أكاديمي»، وهي مدرسة إلكترونية للعلوم. وكان آخر عملٍ لي في «مركز الصرامة العلمية» (Center for Rigor)، حول كيف نجعل العلم نفسه أكثر نزاهة. علّمني الاثنان الدرس ذاته. يشرح العلم كيف يعمل العالم، لكنه وحده لا يسأل: لماذا — لماذا نستخدم ما نتعلّمه، ولمن يخدم. ذلك السؤال من شأن الفلسفة. وبدونه يصير العلم مجرّد أداة — ومن هنا تأتي سمعته السيّئة: لا لأنه خاطئ، بل لأنه بغير «لماذا» يسهل جدًّا تحويله إلى أداة هيمنةٍ وقمعٍ للناس.',
			],
			'ArtaQuest grew from that: take the best free knowledge the world has already produced — on whatever people most need to learn — and give it an honest, focused home, free of propaganda, where anyone can learn it and think for themselves. I run it alone, on purpose: no employer, no funder, no organisation telling me what to teach. That keeps it honest, and keeps it on the mission I have set for my life — to expand everyone\'s creativity.' => [
				'آرتاکوئست از همین‌جا شکل گرفت: بهترین دانشِ آزادی که جهان تا امروز پدید آورده — دربارهٔ هر چیزی که مردم بیش از همه به آموختنش نیاز دارند — برداشته شود و خانه‌ای صادق و متمرکز بیابد، عاری از تبلیغات، جایی که هر کس بتواند آن را بیاموزد و خودش فکر کند. آن را عمداً به‌تنهایی می‌گردانم: نه کارفرمایی، نه سرمایه‌گذاری، نه سازمانی که به من بگوید چه درس بدهم. همین آن را صادق نگه می‌دارد و بر مأموریتی که برای زندگی‌ام برگزیده‌ام استوار می‌دارد — گستردنِ خلاقیتِ همه.',
				'من هنا وُلدت «آرتاكويست»: أن نأخذ أفضل ما أنتجه العالم من معرفةٍ حرّة — في أيّ شيءٍ يحتاج الناس إلى تعلّمه أكثر من غيره — ونمنحه بيتًا صادقًا ومركّزًا، خاليًا من الدعاية، يستطيع فيه أيّ إنسان أن يتعلّم وأن يفكّر بنفسه. أُديره وحدي عن قصد: لا ربَّ عملٍ، ولا مموّلًا، ولا مؤسسةً تُملي عليّ ما أُدرّس. هذا ما يُبقيه صادقًا، ويُبقيه على الرسالة التي اخترتها لحياتي: توسيع إبداع الجميع.',
			],
		];
	}

	/** Write the pairs into aq_translations as `human` rows. Idempotent, and safe to call on every
	 *  load: it returns immediately once the option is set. */
	public static function seed( $force = false ) {
		if ( ! $force && get_option( self::SEEDED ) ) { return 'already seeded'; }
		global $wpdb;
		$t = Data::t( 'aq_translations' );
		$n = 0;
		foreach ( self::pairs() as $en => $tr ) {
			foreach ( [ 'fa' => $tr[0], 'ar' => $tr[1] ] as $lang => $txt ) {
				if ( $txt === '' ) { continue; }
				$hash = md5( $en );
				$has  = $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM $t WHERE source_hash = %s AND lang = %s", $hash, $lang ) );
				if ( $has ) {
					// Overwrite whatever the mesh produced — that is the whole point — but only the
					// text and the status, so demand counters and timestamps other code keeps are not
					// disturbed.
					$wpdb->query( $wpdb->prepare(
						"UPDATE $t SET translated_text = %s, status = 'human', updated_at = %s WHERE source_hash = %s AND lang = %s",
						$txt, gmdate( 'Y-m-d H:i:s' ), $hash, $lang
					) );
				} else {
					$wpdb->insert( $t, [
						'lang'            => $lang,
						'source_hash'     => $hash,
						'source_text'     => $en,
						'translated_text' => $txt,
						'status'          => 'human',
						'updated_at'      => gmdate( 'Y-m-d H:i:s' ),
					] );
				}
				$n++;
			}
		}
		update_option( self::SEEDED, gmdate( 'Y-m-d' ), true );
		return "seeded $n rows";
	}
}
