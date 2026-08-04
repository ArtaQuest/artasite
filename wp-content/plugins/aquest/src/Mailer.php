<?php
namespace AQ;

/**
 * Mailer — every email ArtaQuest sends, in one place.
 *
 * One registry (TEMPLATES) of every outbound email, one branded HTML layout, one sender
 * identity: everything goes out as "ArtaQuest <support@artaquest.org>" (wp_mail_from is
 * forced globally, so stray WordPress-core notices use it too). Operators can reword any
 * subject/body at wp-admin → AQ Security → Emails; overrides live in the aq_email_templates
 * option (copy only — never secrets; the DB is public).
 *
 * Delivery: by default mail rides the host's relay (WP.com Atomic) with the forced From.
 * When SMTP_PASS (+ optionally SMTP_HOST/PORT/USER) is present via Secrets::get — i.e. set
 * in the AQ Security vault — phpmailer switches to authenticated SMTP as support@artaquest.org,
 * which keeps strict SPF/DKIM/DMARC happy. Timeout is bounded; a mail failure never blocks
 * the caller (wp_mail returns false, callers already treat email as best-effort).
 *
 * Templates are plain text with {{var}} placeholders; the renderer escapes everything,
 * auto-links URLs, renders the optional 'big' var as a large gold chip (the sign-in code)
 * and the optional 'cta' as a blue button. Test seam: filter aq_mail_send (return non-null
 * to swallow the send).
 */
class Mailer {

	const FROM_EMAIL = 'support@artaquest.org';
	const FROM_NAME  = 'ArtaQuest';
	const OPTION     = 'aq_email_templates'; // [key => ['subject'=>…, 'body'=>…]] overrides

	/**
	 * Every email the platform can send. 'audience' is who receives it; 'vars' documents the
	 * placeholders a template may use (plus the auto vars {{site_url}} and {{security_url}});
	 * 'big' names a var rendered as a large gold chip; 'cta' is [label, url-template] rendered
	 * as a blue button ('/path' resolves against home_url); 'sample' feeds the admin test-send.
	 */
	const TEMPLATES = [
		'signin_code' => [
			'label'    => 'Sign-in code',
			'audience' => 'member',
			'subject'  => 'Your ArtaQuest sign-in code',
			'body'     => "Here is your sign-in code:\n\n{{code}}\n\nIt expires in 10 minutes. If you didn't request it, you can safely ignore this email — no one can sign in without it.",
			'big'      => 'code',
			'vars'     => [ 'code' ],
			'sample'   => [ 'code' => '123456' ],
		],
		'signin_locked' => [
			'label'    => 'Sign-in temporarily locked',
			'audience' => 'member',
			'subject'  => 'Sign-in to your ArtaQuest account is paused',
			'body'     => "We saw repeated failed code attempts on your account, so we paused sign-in for about {{minutes}} minutes to protect it.\n\nIf this was you, just wait and try again. If not, your account is still safe — no one can sign in without a code sent to this inbox.",
			'vars'     => [ 'minutes' ],
			'sample'   => [ 'minutes' => '60' ],
		],
		/**
		 * A direct message arrived while the member was away. It deliberately carries NO message
		 * text — not as a policy choice but as a fact of the system: ArtaChat is end-to-end
		 * encrypted and the server holds only ciphertext, so there is nothing here to quote even if
		 * we wanted to. Saying that plainly is also the honest answer to "why is this email empty?".
		 */
		'dm_received' => [
			'label'    => 'New direct message',
			'audience' => 'member',
			'subject'  => '{{sender}} sent you a message on ArtaQuest',
			'body'     => "{{sender}} sent you a message.\n\nWe can't show it here — ArtaQuest messages are end-to-end encrypted, so only your own device holds the key that opens them. Open Messages to read it.\n\nWe only email you while you're away, and at most once every 30 minutes per conversation. To stop these, turn off \"Email me when a message arrives\" in Messages.",
			'cta'      => [ 'Open Messages', '/messages/' ],
			'vars'     => [ 'sender' ],
			'sample'   => [ 'sender' => 'Arash' ],
		],
		'new_device' => [
			'label'    => 'New device signed in',
			'audience' => 'member',
			'subject'  => 'New sign-in to your ArtaQuest account',
			'body'     => "A new sign-in to your account from {{where}} on {{device}}.\n\nWhen: {{when}}\nIP: {{ip}}\n\nIf this was you, no action is needed. If not, open Account → Security, sign out that device, then request a fresh sign-in code.",
			'cta'      => [ 'Review your sessions', '/user-account/' ],
			'vars'     => [ 'where', 'device', 'when', 'ip' ],
			'sample'   => [ 'where' => 'London, GB', 'device' => 'Safari on macOS', 'when' => 'Jun 11, 2026 · 14:05', 'ip' => '203.0.113.7' ],
		],
		'cdn_quota' => [
			'label'    => 'Media CDN approaching its free tier',
			'audience' => 'operator',
			'subject'  => '⚠️ [ArtaQuest CDN] {{metric}} at {{percent}}% of the free tier',
			'body'     => "{{body}}\n\nThis is a WARNING, not an outage — nothing has stopped working. You are being told at 90% so there is time to act before anything is billed.\n\n— ArtaQuest media monitor on {{site_url}}",
			'cta'      => [ 'Open AQ Security', '{{security_url}}' ],
			'vars'     => [ 'metric', 'percent', 'body' ],
			'sample'   => [ 'metric' => 'Storage', 'percent' => '91.4', 'body' => 'Storage on the media CDN has reached 91.4% of the free tier.' ],
		],
		'security_alert' => [
			'label'    => 'Security watchdog alarm',
			'audience' => 'operator',
			'subject'  => '{{tag}} {{subject}}',
			'body'     => "{{body}}\n\nIf this was you, no action is needed — baselines update automatically.\n\n— ArtaQuest Watchdog on {{site_url}}",
			'cta'      => [ 'Review in AQ Security', '{{security_url}}' ],
			'vars'     => [ 'tag', 'subject', 'body' ],
			'sample'   => [ 'tag' => '⚠️ [ArtaQuest security]', 'subject' => 'Sample alarm', 'body' => 'This is what a real watchdog alarm will look like.' ],
		],
		'security_test' => [
			'label'    => 'Security test alert',
			'audience' => 'operator',
			'subject'  => '✅ [ArtaQuest security] Test alert — channel works',
			'body'     => "This is a TEST alert from the ArtaQuest security watchdog, triggered manually by {{by}} from wp-admin → AQ Security.\n\nIf you received this email AND see a notification on your bell, the alarm channel works — real tamper/trap/rotation alarms will reach you the same way. No action needed.\n\n— ArtaQuest Watchdog on {{site_url}}",
			'vars'     => [ 'by' ],
			'sample'   => [ 'by' => 'an operator' ],
		],
		'ticket_stuck' => [
			'label'    => 'Ticket is proving hard (autopilot)',
			'audience' => 'operator',
			'subject'  => 'ArtaQuest: ticket #{{id}} is proving hard ({{attempts}} attempts)',
			'body'     => "The autopilot has tried ticket #{{id}} (“{{title}}”) {{attempts}} times without shipping — it may want a human eye. It will keep retrying with backoff.",
			'cta'      => [ 'Open the ticket', '{{url}}' ],
			'vars'     => [ 'id', 'title', 'attempts', 'url' ],
			'sample'   => [ 'id' => '42', 'title' => 'Example ticket', 'attempts' => '5', 'url' => '/issues/?ticket=42' ],
		],
		'ticket_approval' => [
			'label'    => 'Major change needs approval (autopilot)',
			'audience' => 'operator',
			'subject'  => 'ArtaQuest: approve a major change? (ticket #{{id}})',
			'body'     => "ArtaBot’s autonomous developer wants to ship a fix for a {{kind}} ticket, but judged it needs a MAJOR architectural change — so it’s holding for your OK.\n\nTicket #{{id}}: {{title}}\n\nProposed approach:\n{{plan}}\n\n▶ Approve (it will build + deploy this automatically):\n{{approve_url}}\n\n✕ Decline (it will stop and leave this for a human):\n{{decline_url}}\n\nFull thread: {{url}}",
			'vars'     => [ 'id', 'title', 'kind', 'plan', 'approve_url', 'decline_url', 'url' ],
			'sample'   => [ 'id' => '42', 'title' => 'Example ticket', 'kind' => 'feature', 'plan' => 'A sample plan.', 'approve_url' => '/', 'decline_url' => '/', 'url' => '/issues/?ticket=42' ],
		],
		// The gate is the SUBMITTING MEMBER's inbox, not the Kaggle author's: any member may submit any
		// public kernel (operator 2026-07-28), author_id is that member, and nothing links an account to
		// a Kaggle handle — so "the author IS the publisher" claimed a binding the code cannot make.
		// What IS true, and what this email now says: only the member who brought the notebook here can
		// publish it, from their own inbox, and the citation credits the notebook's Kaggle author.
		'nb_confirm' => [
			'label'     => 'Publish your work? (only the member who brought it here can)',
			'audience'  => 'member',
			'subject'   => 'Confirm to publish? — {{title}}',
			'body'      => "The work you brought here, “{{title}}”, cleared every reproducibility check. One question remains, and it is yours alone:\n\nDo you want to publish it?\n\nConfirming publishes it IMMEDIATELY: the work is listed publicly, its files enter the Library, and a PERMANENT DOI mints — crediting the notebook's Kaggle author, with you recorded as the member who brought it here. A DOI is forever and cannot be quietly undone, so look it over first. Nothing publishes until you confirm here, whoever (or whatever) requested it — not even an app or AI agent using your own API token.\n\nWhat we checked, read back from Kaggle:\n\n{{checks_html}}\n\nThe notebook on Kaggle:\n{{kernel}}\n\nRead the draft (the work page):\n{{draft}}\n\nThe button opens a review page that embeds your working deliverable and shows exactly what publishing means (nothing happens on the click itself). Publish there, or withdraw and the work stays a private draft. The link is single-use and bound to this exact version; any edit on Kaggle voids it. If you did not request publication, simply do nothing — or withdraw.",
			'cta'       => [ 'Review & publish (mints the DOI)', '{{url}}' ],
			'vars'      => [ 'id', 'title', 'kind', 'checks_html', 'kernel', 'url', 'draft' ],
			'html_vars' => [ 'checks_html' ],
			'sample'    => [ 'id' => '7', 'title' => 'Example work', 'kind' => 'dataset', 'checks_html' => '<div style="font-size:13px">18 reproducibility checks passed</div>', 'kernel' => 'https://www.kaggle.com/code/you/your-notebook', 'url' => '/', 'draft' => '/nb/7/example-work/' ],
		],
		'news_confirm' => [
			'label'    => 'ArtaNews reports awaiting your decision (nothing publishes automatically)',
			'audience' => 'member',
			'subject'  => '{{count}} ArtaNews report(s) awaiting your decision',
			'body'     => "The instruments detected something and ArtaNews has written up what they measured. Nothing has been published.\n\nEvery report below is a private draft until you say otherwise. Each link is single-use and belongs to that one report, so confirming one says nothing about the others — and opening a link only shows you the measurements; it publishes nothing on the click.\n\nThese pages state what an instrument recorded and what it cannot establish. They never assert a cause or name anyone, because a satellite sees radiant heat and a seismometer sees ground motion — nothing more.\n\n{{items}}\n\nIf you do nothing, nothing is published.",
			'vars'     => [ 'count', 'items' ],
			'sample'   => [ 'count' => '2', 'items' => "• Major heat signature, Kakhovka Ukraine (316 MW)\n  A signature classified as a high-intensity thermal anomaly was measured near Kakhovka, Ukraine.\n  Review & publish: https://artaquest.com/wp-admin/admin-post.php?action=aq_news_confirm&slug=example&k=deadbeef" ],
		],
		'passkey_added' => [
			'label'    => 'A passkey was added (publication co-signing key)',
			'audience' => 'member',
			'subject'  => 'A new passkey was added to your ArtaQuest account',
			'body'     => "A passkey (\"{{label}}\") was just enrolled on your account. From now on it co-signs your publications: publishing asks this device to cryptographically sign the exact work being published, and that signature becomes part of the public record.\n\nIf you added it, no action is needed. If you did NOT, someone with access to your session enrolled a signing key — revoke it immediately in Settings and sign out other devices.",
			'cta'      => [ 'Review your passkeys', '/user-account/' ],
			'vars'     => [ 'label' ],
			'sample'   => [ 'label' => 'MacBook Touch ID' ],
		],
		'passkey_revoked' => [
			'label'    => 'A passkey was revoked (publication signing key)',
			'audience' => 'member',
			'subject'  => 'A passkey was revoked from your ArtaQuest account',
			'body'     => "The passkey \"{{label}}\" was just revoked from your account and can no longer sign your publications.\n\nIf you revoked it, no action is needed. If you did NOT, someone with access to your session (or your account) removed a signing key — this can be a prelude to publishing in your name. Sign out other devices immediately and add a fresh passkey.",
			'cta'      => [ 'Review your passkeys', '/user-account/' ],
			'vars'     => [ 'label' ],
			'sample'   => [ 'label' => 'MacBook Touch ID' ],
		],
		'nb_integrity' => [
			'label'    => 'SECURITY: work published without the author\'s verified confirmation',
			'audience' => 'operator',
			'subject'  => 'ArtaQuest SECURITY: unauthorised publication reverted (nb {{ids}})',
			'body'     => "The integrity watchdog found published work(s) with NO matching author-confirmation record — meaning something flipped them live without the emailed approval of the member who brought them here.\n\nReverted to draft: notebook(s) {{ids}}.\n\nNo action is needed to contain it (the demotion already happened and they are no longer publicly listed), but this indicates something on the server attempted to bypass the publication gate — worth investigating how.",
			'vars'     => [ 'ids' ],
			'sample'   => [ 'ids' => '45' ],
		],
		'delete_account' => [
			'label'    => 'Account deletion code',
			'audience' => 'member',
			'subject'  => 'Confirm deleting your ArtaQuest account',
			'body'     => "Use this code to permanently delete your ArtaQuest account:\n\n{{code}}\n\nIt expires in 15 minutes. Deleting your account erases your profile, posts and progress for good — it can't be undone. If you didn't request this, you can safely ignore this email and your account stays exactly as it is.",
			'big'      => 'code',
			'vars'     => [ 'code' ],
			'sample'   => [ 'code' => '123456' ],
		],
		'ticket_shipped' => [
			'label'    => 'Your contribution is live',
			'audience' => 'member',
			'subject'  => 'Your ArtaQuest contribution is live',
			'body'     => "Good news — ArtaBot has shipped a fix for the ticket you raised:\n\n“{{title}}”\n\nIt’s live on ArtaQuest now. Take a look and, if you’re happy, mark it resolved.\n\nThank you for making ArtaQuest better.",
			'cta'      => [ 'Review your ticket', '{{url}}' ],
			'vars'     => [ 'title', 'url' ],
			'sample'   => [ 'title' => 'Example ticket', 'url' => '/issues/?ticket=42' ],
		],
		// ── ArtaShop (hard copies shipped worldwide with PTT — Turkish Post) ──
		'shop_order' => [
			'label'    => 'Shop order confirmation + invoice',
			'audience' => 'member',
			'subject'  => 'Order #{{id}} confirmed — your ArtaQuest invoice',
			'body'     => "Thank you — your order is confirmed and paid from your wallet. This email is your invoice.\n\nINVOICE — ArtaQuest Foundation\nOrder #{{id}} · {{date}}\n\n{{items}}\n\nGoods: ₳{{goods}}\nShipping ({{service}}): ₳{{shipping}}\n{{fee_detail}}\nTotal paid: ₳{{total}}\n\nDeliver to:\n{{address}}\n\n{{service_note}} We’ll email you again the moment it ships.",
			'cta'      => [ 'View your orders', '/shop/' ],
			'vars'     => [ 'id', 'date', 'items', 'goods', 'shipping', 'service', 'fee_detail', 'total', 'address', 'service_note' ],
			'sample'   => [ 'id' => '1', 'date' => 'Jul 4, 2026', 'items' => '1× ArtaQuest mug — ₳85', 'goods' => '85', 'shipping' => '77', 'service' => 'registered & tracked', 'fee_detail' => 'Shipping is the exact fee our postal carrier charges us for postage and customs clearance — passed through at cost, nothing added.', 'total' => '162', 'address' => "Test Person\nMusterstrasse 12\n10115 Berlin, DE", 'service_note' => 'Your parcel travels registered and gets a tracking number.' ],
		],
		'shop_shipped' => [
			'label'    => 'Shop order shipped (tracking)',
			'audience' => 'member',
			'subject'  => 'Order #{{id}} is on its way',
			'body'     => "Your order has been handed to our postal carrier and is on its way to you.\n\n{{items}}\n\n{{track_line}}\n\n{{tracking}}",
			'big'      => 'tracking',
			'cta'      => [ 'Track your parcel', '{{track_url}}' ],
			'vars'     => [ 'id', 'items', 'tracking', 'track_line', 'track_url' ],
			'sample'   => [ 'id' => '1', 'items' => '1× ArtaQuest mug — ₳85', 'tracking' => 'RR123456789TR', 'track_line' => 'Your tracking number (follow it door-to-door at the button below — it also works on your national post’s tracker once the parcel enters your country):', 'track_url' => 'https://gonderitakip.ptt.gov.tr/Track/Verify?q=RR123456789TR' ],
		],
		'shop_refund' => [
			'label'    => 'Shop order cancelled + refunded',
			'audience' => 'member',
			'subject'  => 'Order #{{id}} cancelled — ₳{{total}} refunded',
			'body'     => "Your order #{{id}} was cancelled before shipping and the full ₳{{total}} is back in your wallet.\n\n{{items}}\n\nIf you didn’t expect this, just reply to this email and we’ll sort it out.",
			'cta'      => [ 'See your wallet', '/wallet/' ],
			'vars'     => [ 'id', 'total', 'items' ],
			'sample'   => [ 'id' => '1', 'total' => '162', 'items' => '1× ArtaQuest mug — ₳85' ],
		],
	];

	// ── Boot (called from Watchdog::boot at plugins_loaded) ──────────────────

	public static function boot() {
		// ONE sender identity for everything wp_mail sends, including WordPress-core notices.
		add_filter( 'wp_mail_from', fn() => self::FROM_EMAIL );
		add_filter( 'wp_mail_from_name', fn() => self::FROM_NAME );
		// Authenticated SMTP as support@ when credentials exist in the AQ Security vault.
		add_action( 'phpmailer_init', [ self::class, 'smtp' ] );
		add_action( 'admin_menu', [ self::class, 'admin_menu' ], 60 ); // after the AQ Security parent
		add_action( 'admin_init', [ self::class, 'handle_actions' ] );
	}

	/** @param \PHPMailer\PHPMailer\PHPMailer $m */
	public static function smtp( $m ) {
		$pass = Secrets::get( 'SMTP_PASS' );
		if ( $pass === '' ) { return; } // no creds → host relay with the forced From
		$m->isSMTP();
		$m->Host       = Secrets::get( 'SMTP_HOST' ) ?: 'smtp.gmail.com';
		$m->Port       = (int) ( Secrets::get( 'SMTP_PORT' ) ?: 587 );
		$m->SMTPAuth   = true;
		$m->Username   = Secrets::get( 'SMTP_USER' ) ?: self::FROM_EMAIL;
		$m->Password   = $pass;
		$m->SMTPSecure = $m->Port === 465 ? 'ssl' : 'tls';
		$m->Timeout    = 10; // bounded — a dead relay must never hang a request
	}

	// ── Sending ──────────────────────────────────────────────────────────────

	/** Operator alert address — vault/env OPERATOR_EMAIL, else the site admin email. */
	public static function operator() {
		return Secrets::get( 'OPERATOR_EMAIL' ) ?: get_option( 'admin_email' );
	}

	/** Send one templated email. Returns wp_mail's bool; unknown keys are a no-op (false). */
	public static function send( $key, $to, $vars = [] ) {
		$tpl = self::template( $key );
		if ( ! $tpl || ! is_email( $to ) ) { return false; }
		$subject = self::fill( $tpl['subject'], $vars );
		$html    = self::layout( self::body_html( $tpl, $vars ) );
		// Test seam — but NEVER for the publication-confirm template on a live site: its vars
		// carry the single-use publish secret, and a filter added via `wp eval` could capture
		// it (the exact bypass class of the nb45 incident). Local dev opts in by defining
		// AQ_MAIL_SEAM in wp-config.php (gitignored); production never defines it.
		if ( $key !== 'nb_confirm' || ( defined( 'AQ_MAIL_SEAM' ) && AQ_MAIL_SEAM ) ) {
			$pre = apply_filters( 'aq_mail_send', null, $key, $to, $subject, $vars ); // test seam
			if ( $pre !== null ) { return (bool) $pre; }
		}
		return wp_mail( $to, $subject, $html, [
			'Content-Type: text/html; charset=UTF-8',
			'From: ' . self::FROM_NAME . ' <' . self::FROM_EMAIL . '>',
		] );
	}

	/** Template by key with any operator override applied (subject/body only). */
	public static function template( $key ) {
		if ( ! isset( self::TEMPLATES[ $key ] ) ) { return null; }
		$tpl = self::TEMPLATES[ $key ];
		$ov  = get_option( self::OPTION, [] );
		if ( isset( $ov[ $key ] ) && is_array( $ov[ $key ] ) ) {
			if ( ! empty( $ov[ $key ]['subject'] ) ) { $tpl['subject'] = (string) $ov[ $key ]['subject']; }
			if ( ! empty( $ov[ $key ]['body'] ) )    { $tpl['body']    = (string) $ov[ $key ]['body']; }
			$tpl['customized'] = true;
		}
		return $tpl;
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	/** Substitute {{vars}} (+ auto vars) into plain text. */
	private static function fill( $text, $vars ) {
		$vars += [
			'site_url'     => home_url(),
			'security_url' => admin_url( 'admin.php?page=aq-security' ),
		];
		foreach ( $vars as $k => $v ) { $text = str_replace( '{{' . $k . '}}', (string) $v, $text ); }
		return $text;
	}

	/** Template body → escaped, auto-linked, paragraph'd HTML (+ big chip + CTA button).
	 *  Templates may declare 'html_vars' — vars injected as RAW pre-built HTML blocks (the
	 *  AQBIG marker pattern); only code-built markup is ever passed through them. */
	private static function body_html( $tpl, $vars ) {
		$big  = (string) ( $tpl['big'] ?? '' );
		$work = $vars;
		if ( $big !== '' ) { $work[ $big ] = "\x01AQBIG\x01"; } // marker survives esc_html
		foreach ( (array) ( $tpl['html_vars'] ?? [] ) as $hv ) {
			if ( isset( $work[ $hv ] ) ) { $work[ $hv ] = "\x01AQHTML{$hv}\x01"; }
		}
		$html = esc_html( self::fill( $tpl['body'], $work ) );
		$html = preg_replace_callback(
			'#https?://[^\s<]+#',
			fn( $m ) => '<a href="' . esc_url( html_entity_decode( $m[0] ) ) . '" style="color:#1746DC;word-break:break-all">' . $m[0] . '</a>',
			$html
		);
		$out = '';
		foreach ( preg_split( "/\n{2,}/", $html ) as $p ) {
			$p = nl2br( trim( $p ) );
			if ( $p !== '' ) { $out .= '<p style="margin:0 0 14px;color:#1f2a37;font-size:15px;line-height:1.65">' . $p . '</p>'; }
		}
		if ( $big !== '' ) {
			$chip = '<span style="display:inline-block;background:#010C17;color:#E8B923;font-size:26px;font-weight:700;letter-spacing:6px;padding:12px 20px;border-radius:10px;font-family:ui-monospace,Menlo,Consolas,monospace">'
				. esc_html( (string) ( $vars[ $big ] ?? '' ) ) . '</span>';
			$out = str_replace( "\x01AQBIG\x01", $chip, $out );
		}
		foreach ( (array) ( $tpl['html_vars'] ?? [] ) as $hv ) {
			// a marker alone in its paragraph swaps the WHOLE <p> for the raw block
			$p_open = '<p style="margin:0 0 14px;color:#1f2a37;font-size:15px;line-height:1.65">';
			$out = str_replace( $p_open . "\x01AQHTML{$hv}\x01" . '</p>', (string) ( $vars[ $hv ] ?? '' ), $out );
			$out = str_replace( "\x01AQHTML{$hv}\x01", (string) ( $vars[ $hv ] ?? '' ), $out ); // inline fallback
		}
		if ( ! empty( $tpl['cta'] ) ) {
			$url = self::fill( (string) $tpl['cta'][1], $vars );
			if ( $url !== '' && $url[0] === '/' ) { $url = home_url( $url ); }
			$out .= '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 14px"><tr>'
				. '<td bgcolor="#1746DC" style="border-radius:8px"><a href="' . esc_url( $url ) . '" '
				. 'style="display:inline-block;padding:11px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none">'
				. esc_html( (string) $tpl['cta'][0] ) . '</a></td></tr></table>';
		}
		return $out;
	}

	/** The one branded shell: dark header, white card, quiet footer. Gold + blue only. */
	private static function layout( $inner ) {
		$home = esc_url( home_url( '/' ) );
		$font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
		return '<!doctype html><html><body style="margin:0;padding:0;background:#eef2f7">'
			. '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef2f7"><tr><td align="center" style="padding:28px 12px">'
			. '<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">'
			. '<tr><td style="background:#010C17;border-radius:12px 12px 0 0;padding:18px 28px">'
			. '<a href="' . $home . '" style="text-decoration:none;font-family:' . $font . ';font-size:18px;font-weight:800;color:#E8B923">ArtaQuest</a></td></tr>'
			. '<tr><td style="background:#ffffff;border-radius:0 0 12px 12px;padding:26px 28px 16px;font-family:' . $font . '">' . $inner . '</td></tr>'
			. '<tr><td style="padding:16px 10px;font-family:' . $font . ';color:#8a97a6;font-size:12px;line-height:1.6">'
			. 'Sent by ArtaQuest · <a href="' . $home . '" style="color:#8a97a6">artaquest.com</a><br>'
			. 'ArtaQuest Foundation — free learning</td></tr>'
			. '</table></td></tr></table></body></html>';
	}

	// ── wp-admin → AQ Security → Emails (operators only) ─────────────────────

	public static function admin_menu() {
		add_submenu_page(
			'aq-security', 'ArtaQuest Emails', 'Emails', 'manage_options', 'aq-emails',
			[ self::class, 'render_page' ]
		);
	}

	/** Save / reset / test-send actions (nonce + capability checked), then redirect back. */
	public static function handle_actions() {
		if ( empty( $_POST['aq_email_action'] ) || ! current_user_can( 'manage_options' ) ) { return; }
		check_admin_referer( 'aq_emails' );
		$action = sanitize_key( (string) $_POST['aq_email_action'] );
		$key    = sanitize_key( (string) ( $_POST['key'] ?? '' ) );
		if ( ! isset( self::TEMPLATES[ $key ] ) ) { return; }
		$msg = '';
		switch ( $action ) {
			case 'save': // plain text only — placeholders survive, markup is stripped
				$ov = get_option( self::OPTION, [] );
				$ov = is_array( $ov ) ? $ov : [];
				$ov[ $key ] = [
					'subject' => sanitize_text_field( (string) wp_unslash( $_POST['subject'] ?? '' ) ),
					'body'    => sanitize_textarea_field( (string) wp_unslash( $_POST['body'] ?? '' ) ),
				];
				update_option( self::OPTION, $ov, false );
				$msg = 'Saved “' . self::TEMPLATES[ $key ]['label'] . '”.';
				break;
			case 'reset':
				$ov = get_option( self::OPTION, [] );
				unset( $ov[ $key ] );
				update_option( self::OPTION, $ov, false );
				$msg = 'Restored the default “' . self::TEMPLATES[ $key ]['label'] . '” wording.';
				break;
			case 'test': // send the real template, sample vars, to the operator clicking the button
				$me = wp_get_current_user();
				$ok = $me && is_email( $me->user_email )
					&& self::send( $key, $me->user_email, self::TEMPLATES[ $key ]['sample'] ?? [] );
				$msg = $ok ? 'Test “' . self::TEMPLATES[ $key ]['label'] . '” sent to ' . $me->user_email . '.'
					: 'Test send failed — check the SMTP credentials in the vault.';
				break;
		}
		wp_safe_redirect( add_query_arg( 'aq_msg', rawurlencode( $msg ), admin_url( 'admin.php?page=aq-emails' ) ) );
		exit;
	}

	public static function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) { return; }
		$smtp = Secrets::get( 'SMTP_PASS' ) !== '';
		echo '<div class="wrap aq-mail">' . self::styles();
		echo '<div class="aq-hero"><div class="aq-mark">A</div><div><div class="aq-title">ArtaQuest Emails</div>'
			. '<div class="aq-tag">Every email the platform sends — one sender, one template, editable wording</div></div>'
			. '<div class="aq-health ' . ( $smtp ? 'ok' : 'warn' ) . '">' . ( $smtp ? '✓ SMTP as ' . esc_html( self::FROM_EMAIL ) : '⚠ host relay (no SMTP creds)' ) . '</div></div>';
		if ( ! empty( $_GET['aq_msg'] ) ) {
			echo '<div class="notice notice-success is-dismissible"><p>' . esc_html( (string) wp_unslash( $_GET['aq_msg'] ) ) . '</p></div>';
		}
		echo '<p class="aq-lead">All mail goes out as <strong>' . esc_html( self::FROM_NAME ) . ' &lt;' . esc_html( self::FROM_EMAIL ) . '&gt;</strong> '
			. '(WordPress-core notices included). To deliver through the real support@ mailbox, add <code>SMTP_PASS</code> '
			. '(and optionally <code>SMTP_HOST</code>/<code>SMTP_PORT</code>/<code>SMTP_USER</code>) in <a href="' . esc_url( admin_url( 'admin.php?page=aq-security' ) ) . '">AQ Security</a> — '
			. 'never in the database, it is public. Bodies are plain text: <code>{{placeholders}}</code> are filled per send, URLs become links, '
			. 'blank lines start new paragraphs. The gold chip and blue buttons come from the shared template automatically.</p>';
		foreach ( self::TEMPLATES as $key => $def ) {
			$tpl = self::template( $key );
			echo '<div class="aq-card"><div class="aq-card-head"><div>'
				. '<span class="aq-name">' . esc_html( $def['label'] ) . '</span>'
				. '<span class="aq-pill ' . ( $def['audience'] === 'operator' ? 'op' : 'mem' ) . '">' . esc_html( $def['audience'] ) . '</span>'
				. ( ! empty( $tpl['customized'] ) ? '<span class="aq-pill cust">customised</span>' : '' )
				. '</div><code class="aq-key">' . esc_html( $key ) . '</code></div>';
			echo '<form method="post">' . wp_nonce_field( 'aq_emails', '_wpnonce', true, false )
				. '<input type="hidden" name="key" value="' . esc_attr( $key ) . '">'
				. '<label>Subject<input type="text" name="subject" value="' . esc_attr( $tpl['subject'] ) . '"></label>'
				. '<label>Body<textarea name="body" rows="' . max( 4, substr_count( $tpl['body'], "\n" ) + 2 ) . '">' . esc_textarea( $tpl['body'] ) . '</textarea></label>'
				. '<div class="aq-meta">Placeholders: ' . implode( ' ', array_map( fn( $v ) => '<code>{{' . esc_html( $v ) . '}}</code>', $def['vars'] ) )
				. ( ! empty( $def['cta'] ) ? ' · button: “' . esc_html( $def['cta'][0] ) . '”' : '' ) . '</div>'
				. '<div class="aq-actions">'
				. '<button class="button button-primary" name="aq_email_action" value="save">Save wording</button>'
				. ( ! empty( $tpl['customized'] ) ? '<button class="button" name="aq_email_action" value="reset">Restore default</button>' : '' )
				. '<button class="button" name="aq_email_action" value="test">Send me a test</button>'
				. '</div></form></div>';
		}
		echo '</div>';
	}

	/** Scoped styling matching the AQ Security page: brand gold/blue hero, native-admin body. */
	private static function styles() {
		return '<style>
		.aq-mail{max-width:880px}
		.aq-mail .aq-hero{display:flex;align-items:center;gap:16px;background:linear-gradient(120deg,#010C17,#0C1E32);border:1px solid #16324f;border-radius:12px;padding:18px 22px;margin:14px 0 20px;color:#eaf1f9}
		.aq-mail .aq-mark{width:40px;height:40px;border-radius:50%;border:2px solid #1746DC;color:#E8B923;font-weight:800;font-size:22px;display:flex;align-items:center;justify-content:center}
		.aq-mail .aq-title{font-size:18px;font-weight:700}
		.aq-mail .aq-tag{color:#9fb1c5;font-size:12.5px}
		.aq-mail .aq-health{margin-left:auto;font-size:12.5px;padding:6px 12px;border-radius:999px;white-space:nowrap}
		.aq-mail .aq-health.ok{background:rgba(23,70,220,.18);color:#9db8ff}
		.aq-mail .aq-health.warn{background:rgba(232,185,35,.15);color:#E8B923}
		.aq-mail .aq-lead{max-width:72em}
		.aq-mail .aq-card{background:#fff;border:1px solid #dcdfe5;border-radius:10px;padding:16px 18px;margin:0 0 16px}
		.aq-mail .aq-card-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
		.aq-mail .aq-name{font-weight:600;font-size:14px;margin-right:8px}
		.aq-mail .aq-key{color:#6b7682;font-size:12px}
		.aq-mail .aq-pill{font-size:11px;padding:2px 9px;border-radius:999px;margin-right:6px;vertical-align:1px}
		.aq-mail .aq-pill.mem{background:rgba(23,70,220,.12);color:#1746DC}
		.aq-mail .aq-pill.op{background:#0C1E32;color:#E8B923}
		.aq-mail .aq-pill.cust{background:rgba(232,185,35,.18);color:#8a6d00}
		.aq-mail label{display:block;font-weight:600;font-size:12.5px;margin:8px 0}
		.aq-mail input[type=text],.aq-mail textarea{display:block;width:100%;margin-top:4px;font-weight:400}
		.aq-mail textarea{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
		.aq-mail .aq-meta{color:#6b7682;font-size:12px;margin:6px 0 10px}
		.aq-mail .aq-actions{display:flex;gap:8px}
		</style>';
	}
}
