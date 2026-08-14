<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * The Foundation's books — a real double-entry general ledger, published in full.
 *
 * ArtaQuest Foundation is a Canadian non-profit CORPORATION relying on the paragraph 149(1)(l)
 * income-tax exemption. It is NOT a registered charity, which decides three things this class
 * encodes: it must file a T2 every year even with nil income (CRA excuses only tax-exempt Crown
 * corporations, Hutterite colonies and registered charities); it files a T1044 only if one of
 * three thresholds is crossed; and it may NEVER issue an official donation receipt.
 *
 * WHY A SECOND LEDGER, next to aq_fund_ledger. The fund ledger answers "how much donated money is
 * sitting in which bucket" — one signed number per bucket, single-entry. That is a cash book, not
 * a set of books: it cannot express an expense, a liability, a director's advance, an accrual or a
 * deficit, and none of those are optional in a corporate return. So this class keeps the general
 * ledger — every transaction as balanced debits and credits — and the fund ledger stays exactly
 * what it always was, the earmark tracker feeding /foundation/finances. They are reconciled by
 * verify() rather than merged, so neither one silently rewrites the other.
 *
 * THE INVARIANT THAT MATTERS: an entry that does not balance is never written. journal() is the
 * ONE writer, it sums the lines before it inserts anything, and a torn write is deleted rather
 * than left behind — because a half-written entry is not a ledger row, it is a corrupt one. Every
 * downstream figure (trial balance, balance sheet, statement of operations, GIFI schedules) is a
 * pure function of the lines, so the statements cannot disagree with the ledger.
 *
 * EVERYTHING HERE IS PUBLIC. Extra::db enumerates with SHOW TABLES, so these four tables publish
 * themselves at /data the moment they exist. That is deliberate — the point of the exercise is
 * that a stranger can check the books.
 *
 * Be precise about what that publishes, because "no personal data" would be too comfortable to be
 * true. The ledger itself holds amounts, dates, account codes and vendor names. The invoice register
 * additionally holds `pay_method`, which carries a card brand and its last four digits ("Visa ending
 * 2178") — published knowingly, on the same operator decision that publishes the invoice PDFs, which
 * print the same thing. A last-four is not a credential and cannot be transacted on, but it IS
 * personal data and should be named rather than glossed over. Never add a full card number, a
 * billing address or a bank detail to these tables.
 *
 * Money is INTEGER CENTS, CAD, everywhere. Dates are 'YYYY-MM-DD' strings, never timestamps: a
 * fiscal period is a calendar fact about Edmonton, and string dates compare and sort correctly
 * without a single timezone conversion to get wrong.
 */
final class Books {

	/** Bumped when the table shapes change. Isolated from Schema::VERSION, like every subsystem
	 *  added since 2026-07 (Notebook, Chat, Rooms, Library, Api, Passkey…). */
	const TABLE_VERSION = '1';

	const CURRENCY = 'CAD';
	const TZ       = 'America/Edmonton';

	/** Identity, as it appears on the corporation's own records and on every vendor invoice. */
	const ENTITY       = 'ArtaQuest Foundation';
	const BN           = '779107374';
	const INCORPORATED = '2026-05-20';
	const PROVINCE     = 'AB';

	/** Default fiscal year end (MM-DD). A corporation's first fiscal period must end within 53
	 *  weeks of incorporation and is FIXED BY THE FIRST T2 FILED — so until that return goes in,
	 *  this is genuinely still the operator's choice. Overridable with the aq_books_fy_end option;
	 *  fy_end_md() refuses a value that would put the first period beyond the 53-week limit. */
	const FY_END_DEFAULT = '12-31';

	/**
	 * The chart of accounts, each line carrying the CRA GIFI code it reports under.
	 *
	 * Every code below was read off Guide RC4088 Appendix A with its official description; nothing
	 * here is inferred. Three traps are deliberately avoided:
	 *   - 8522 "Donations" is an EXPENSE code (donations the corporation PAYS OUT). Donation
	 *     REVENUE for a non-profit is 8223 "Gifts", inside the "Items 8220 to 8224 | For non-profit
	 *     organizations" block. Coding gifts to 8522 would understate revenue and overstate
	 *     expenses at the same time.
	 *   - The 9800-series office/professional/bank codes are FARMING codes. The general-corporation
	 *     ones are 8810, 8860 and 8715.
	 *   - Prepaid expenses are 1484 in Appendix A. RC4088's own narrative "Examples" section says
	 *     1483, which is wrong twice over (1483 is "Taxes recoverable/refundable" and "Other current
	 *     assets" is 1480). Appendix A is the authoritative table.
	 *
	 * `short` is the GIFI-Short (Form T1178) rollup, which is what this Foundation will actually
	 * file while gross revenue and assets stay under $1 million.
	 *
	 * Shape: code => [ label, type, gifi, short, note ].
	 */
	const ACCOUNTS = [
		'cash' => [ 'Cash and bank', 'asset', '1002', '1000',
			'Deposits in Canadian banks and institutions – Canadian currency' ],
		'prepaid' => [ 'Prepaid expenses', 'asset', '1484', '1480',
			'Subscription time paid for but not yet consumed at the year end' ],

		'due_director' => [ 'Due to a director', 'liability', '2780', '2780',
			'Current amounts due to shareholder(s)/director(s), such as advances, loans, and notes' ],
		'coin_liability' => [ 'ArtaCoin in circulation', 'liability', '2960', '2960',
			'Other current liabilities — member-held tokens the Foundation is obliged to honour' ],
		'deferred' => [ 'Deferred income', 'liability', '2770', '2960',
			'Amounts received for a period that has not yet run' ],
		'gst_payable' => [ 'GST self-assessed on imported services', 'liability', '2960', '2960',
			'Other current liabilities. Tax the Foundation owes CRA directly on services bought from a non-resident supplier, not tax collected from anyone' ],

		'net_assets' => [ 'Accumulated surplus / (deficit)', 'equity', '3600', '3600',
			'Retained earnings/deficit. Derived from the ledger, never posted to directly' ],

		'donations' => [ 'Gifts received', 'revenue', '8223', '8223',
			'GIFI block "Items 8220 to 8224 | For non-profit organizations". NOT 8522, which is an expense' ],
		'grants_in' => [ 'Subsidies and grants received', 'revenue', '8242', '8242', '' ],
		'activity_revenue' => [ 'Revenue from organisational activities', 'revenue', '8224', '8224', '' ],

		'software' => [ 'Computer and software subscriptions', 'expense', '9150', '9150',
			'Computer-related expenses. CRA publishes no general-corporation code named for a SaaS subscription; 9150 is the nearest verified line and 9807 belongs to the farming section' ],
		'office' => [ 'Office expenses', 'expense', '8810', '8810', '' ],
		'professional_fees' => [ 'Professional fees', 'expense', '8860', '8860',
			'Accounting, bookkeeping, audit and legal. NOT 9809, which is the farming code' ],
		'bank_charges' => [ 'Bank and payment charges', 'expense', '8715', '8710', '' ],
		'grants_out' => [ 'Bursaries and grants paid', 'expense', '8522', '8522',
			'GIFI 8522 "Donations" — amounts the corporation pays out' ],
	];

	/**
	 * The official RC4088 description for each code in use. A GIFI schedule carries ONE amount per
	 * code, so when two accounts share one — ArtaCoin and self-assessed GST are both "other current
	 * liabilities" — the filed line has to be their sum under the code's own name, not either
	 * account's label. Filing the same code twice is a rejected schedule.
	 */
	const GIFI_NAMES = [
		'1002' => 'Deposits in Canadian banks and institutions - Canadian currency',
		'1484' => 'Prepaid expenses',
		'2770' => 'Deferred income',
		'2780' => 'Due to shareholder(s)/director(s)',
		'2960' => 'Other current liabilities',
		'8223' => 'Gifts',
		'8224' => 'Gross sales and revenues from organizational activities',
		'8242' => 'Subsidies and grants',
		'8522' => 'Donations',
		'8715' => 'Bank charges',
		'8810' => 'Office expenses',
		'8860' => 'Professional fees',
		'9150' => 'Computer-related expenses',
	];

	/**
	 * GIFI totals that are computed, not posted: code => label. Reported on the schedules.
	 *
	 * Only codes whose number AND official description were read off RC4088 appear here. The
	 * balance-sheet SUBTOTALS (total assets, total liabilities) are deliberately absent: their codes
	 * were not confirmed against the guide, and a wrong code on a filed return is worse than a
	 * subtotal the filing software derives for itself. `cra()` says so in its notes rather than
	 * quietly omitting them.
	 */
	const GIFI_TOTALS = [
		'3600' => 'Retained earnings/deficit',
		'3620' => 'Total shareholder equity',
		'3640' => 'Total liabilities and shareholder equity',
		'8299' => 'Total revenue',
		'9367' => 'Total operating expenses',
		'9368' => 'Total expenses',
		'9970' => 'Net income/loss before taxes and extraordinary items',
		'9999' => 'Net income/loss after taxes and extraordinary items',
	];

	// ── Tables ────────────────────────────────────────────────────────────────
	// Self-installing, gated on aq_books_table_version. NOTHING may be commented INSIDE a CREATE
	// TABLE body: dbDelta parses it line-by-line with regexes, and under Studio's SQLite emulation
	// an inline `--` makes it emit NO TABLE AT ALL, silently. `PRIMARY KEY  (` keeps its two spaces
	// for the same parser. No column is called `stored`, `blob` or `rank`, and no index is a MySQL
	// prefix index — each of those has already cost this repo a silently-missing table.

	public static function ensure_tables() {
		global $wpdb;
		if ( get_option( 'aq_books_table_version' ) === self::TABLE_VERSION ) { return; }
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$p       = $wpdb->prefix;
		$charset = $wpdb->get_charset_collate();

		$tables = [
			'aq_books_entry' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				ref VARCHAR(96) NOT NULL DEFAULT '',
				on_date CHAR(10) NOT NULL DEFAULT '',
				fy VARCHAR(12) NOT NULL DEFAULT '',
				memo VARCHAR(191) NOT NULL DEFAULT '',
				source VARCHAR(24) NOT NULL DEFAULT 'manual',
				invoice_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY ref (ref),
				KEY on_date_id (on_date, id),
				KEY fy_id (fy, id),
				KEY invoice_id (invoice_id)",

			'aq_books_line' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				entry_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				account VARCHAR(32) NOT NULL DEFAULT '',
				debit BIGINT NOT NULL DEFAULT 0,
				credit BIGINT NOT NULL DEFAULT 0,
				party_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
				memo VARCHAR(191) NOT NULL DEFAULT '',
				PRIMARY KEY  (id),
				KEY entry_id (entry_id),
				KEY account_id (account, id)",

			'aq_books_invoice' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				vendor VARCHAR(160) NOT NULL DEFAULT '',
				number VARCHAR(96) NOT NULL DEFAULT '',
				description VARCHAR(191) NOT NULL DEFAULT '',
				issued CHAR(10) NOT NULL DEFAULT '',
				paid CHAR(10) NOT NULL DEFAULT '',
				period_start CHAR(10) NOT NULL DEFAULT '',
				period_end CHAR(10) NOT NULL DEFAULT '',
				currency CHAR(3) NOT NULL DEFAULT 'CAD',
				subtotal_cents BIGINT NOT NULL DEFAULT 0,
				tax_cents BIGINT NOT NULL DEFAULT 0,
				total_cents BIGINT NOT NULL DEFAULT 0,
				fx_rate BIGINT NOT NULL DEFAULT 1000000,
				fx_date CHAR(10) NOT NULL DEFAULT '',
				fx_source VARCHAR(191) NOT NULL DEFAULT '',
				cad_cents BIGINT NOT NULL DEFAULT 0,
				account VARCHAR(32) NOT NULL DEFAULT 'software',
				tax_note VARCHAR(191) NOT NULL DEFAULT '',
				pay_method VARCHAR(64) NOT NULL DEFAULT '',
				payer_uid BIGINT UNSIGNED NOT NULL DEFAULT 0,
				coins BIGINT NOT NULL DEFAULT 0,
				coin_price_1e6 BIGINT NOT NULL DEFAULT 0,
				gold_oz_usd_1e4 BIGINT NOT NULL DEFAULT 0,
				usdcad_1e6 BIGINT NOT NULL DEFAULT 0,
				rate_date CHAR(10) NOT NULL DEFAULT '',
				rate_source VARCHAR(191) NOT NULL DEFAULT '',
				entry_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				note VARCHAR(191) NOT NULL DEFAULT '',
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				UNIQUE KEY number (number),
				KEY paid_id (paid, id)",

			'aq_books_doc' => "
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				invoice_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				kind VARCHAR(16) NOT NULL DEFAULT 'invoice',
				name VARCHAR(191) NOT NULL DEFAULT '',
				file_key VARCHAR(191) NOT NULL DEFAULT '',
				mime VARCHAR(64) NOT NULL DEFAULT 'application/pdf',
				bytes BIGINT NOT NULL DEFAULT 0,
				sha256 CHAR(64) NOT NULL DEFAULT '',
				uploaded_by BIGINT UNSIGNED NOT NULL DEFAULT 0,
				created INT UNSIGNED NOT NULL DEFAULT 0,
				PRIMARY KEY  (id),
				KEY invoice_id_id (invoice_id, id),
				KEY sha256 (sha256)",
		];
		foreach ( $tables as $name => $body ) {
			dbDelta( "CREATE TABLE {$p}{$name} (\n{$body}\n) {$charset};" );
		}

		// VERIFY BEFORE CLAIMING. The version option is a "do not run this again" guard, so writing
		// it is a promise that the columns really landed. The SQLite dev integration has been seen
		// to skip an entire CREATE while the caller's version stamp advanced anyway, which leaves
		// the table missing forever because the retry that would fix it never happens.
		$want = [
			'aq_books_entry'   => [ 'ref', 'on_date', 'fy' ],
			'aq_books_line'    => [ 'entry_id', 'account', 'debit', 'credit' ],
			'aq_books_invoice' => [ 'number', 'total_cents', 'cad_cents', 'coins', 'rate_date' ],
			'aq_books_doc'     => [ 'invoice_id', 'file_key', 'sha256' ],
		];
		$missing = [];
		foreach ( $want as $t => $cols ) {
			$have = array_map( 'strval', (array) $wpdb->get_col( "SHOW COLUMNS FROM {$p}{$t}" ) );
			if ( ! $have ) { $missing[] = $t; continue; }
			foreach ( $cols as $c ) {
				if ( ! in_array( $c, $have, true ) ) { $missing[] = "{$t}.{$c}"; }
			}
		}
		if ( $missing ) {
			error_log( 'AQ Books: schema v' . self::TABLE_VERSION . ' incomplete, NOT recording the version — missing ' . implode( ', ', $missing ) );
			return;
		}
		update_option( 'aq_books_table_version', self::TABLE_VERSION, true );
	}

	// ── The fiscal calendar ───────────────────────────────────────────────────

	/** Today, as a date string in the Foundation's own timezone (Edmonton). */
	public static function today() {
		return ( new \DateTimeImmutable( 'now', new \DateTimeZone( self::TZ ) ) )->format( 'Y-m-d' );
	}

	/**
	 * The fiscal year end as 'MM-DD'.
	 *
	 * A first fiscal period may not exceed 53 weeks from incorporation, so a year end that would
	 * blow that limit is not merely unusual, it is invalid — and a set of books that quietly
	 * accepted it would produce a return CRA rejects. An out-of-range option is therefore refused
	 * (falling back to the default) rather than honoured.
	 */
	public static function fy_end_md() {
		$md = (string) get_option( 'aq_books_fy_end', self::FY_END_DEFAULT );
		if ( ! preg_match( '/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/', $md ) ) { return self::FY_END_DEFAULT; }
		$first = self::first_period_end( $md );
		return ( $first !== '' && $first <= self::max_first_year_end() ) ? $md : self::FY_END_DEFAULT;
	}

	/** The last date the FIRST fiscal period may legally end: 53 weeks (371 days) after incorporation. */
	public static function max_first_year_end() {
		return ( new \DateTimeImmutable( self::INCORPORATED, new \DateTimeZone( self::TZ ) ) )
			->modify( '+371 days' )->format( 'Y-m-d' );
	}

	/** The end date of the first fiscal period under a given MM-DD, or '' if none can be formed. */
	private static function first_period_end( $md ) {
		[ $m, $d ] = array_map( 'intval', explode( '-', $md ) );
		$inc = new \DateTimeImmutable( self::INCORPORATED, new \DateTimeZone( self::TZ ) );
		for ( $y = (int) $inc->format( 'Y' ); $y <= (int) $inc->format( 'Y' ) + 2; $y++ ) {
			$cand = self::clamp_date( $y, $m, $d );
			if ( $cand > self::INCORPORATED ) { return $cand; }
		}
		return '';
	}

	/** A 'Y-m-d' for (year, month, day), clamped to the month's real length (29 Feb → 28 Feb). */
	private static function clamp_date( $y, $m, $d ) {
		$last = (int) ( new \DateTimeImmutable( sprintf( '%04d-%02d-01', $y, $m ), new \DateTimeZone( self::TZ ) ) )->format( 't' );
		return sprintf( '%04d-%02d-%02d', $y, $m, min( $d, $last ) );
	}

	/**
	 * The fiscal period containing a date: [ label, start, end, first ].
	 * The label is the calendar year the period ENDS in, prefixed 'FY'. The first period is
	 * truncated at incorporation — the corporation did not exist before then, so nothing can be
	 * dated into a period that starts earlier.
	 */
	public static function fy_of( $date ) {
		$md = self::fy_end_md();
		[ $m, $d ] = array_map( 'intval', explode( '-', $md ) );
		$y = (int) substr( $date, 0, 4 );
		$end = self::clamp_date( $y, $m, $d );
		if ( $date > $end ) { $end = self::clamp_date( $y + 1, $m, $d ); }
		$prev  = self::clamp_date( (int) substr( $end, 0, 4 ) - 1, $m, $d );
		$start = ( new \DateTimeImmutable( $prev, new \DateTimeZone( self::TZ ) ) )->modify( '+1 day' )->format( 'Y-m-d' );
		$first = $start <= self::INCORPORATED;
		if ( $first ) { $start = self::INCORPORATED; }
		return [ 'label' => 'FY' . substr( $end, 0, 4 ), 'start' => $start, 'end' => $end, 'first' => $first ];
	}

	/** Every fiscal period from incorporation to the one containing today, oldest first. */
	public static function fy_list() {
		$out  = [];
		$cur  = self::fy_of( self::INCORPORATED );
		$last = self::fy_of( self::today() );
		$guard = 0;
		while ( $guard++ < 60 ) {
			$out[] = $cur;
			if ( $cur['label'] === $last['label'] ) { break; }
			$cur = self::fy_of( ( new \DateTimeImmutable( $cur['end'], new \DateTimeZone( self::TZ ) ) )->modify( '+1 day' )->format( 'Y-m-d' ) );
		}
		return $out;
	}

	/** Fiscal periods whose return has been filed and which are therefore frozen. */
	public static function locked_years() {
		$v = get_option( 'aq_books_locked_years', [] );
		return is_array( $v ) ? array_values( array_filter( array_map( 'strval', $v ) ) ) : [];
	}

	/** The filing deadline for a period: six months after the end, same day of the month. */
	public static function filing_due( $end ) {
		$dt = new \DateTimeImmutable( $end, new \DateTimeZone( self::TZ ) );
		// CRA: when the year end is the LAST day of a month, the return is due on the last day of
		// the sixth month after; otherwise on the same day of the sixth month after. Those two
		// rules differ for a 31st, so the month-end case is handled explicitly.
		if ( $dt->format( 'd' ) === $dt->format( 't' ) ) {
			return $dt->modify( 'first day of +6 months' )->modify( 'last day of this month' )->format( 'Y-m-d' );
		}
		// Add six months by CALENDAR arithmetic and clamp to the target month's length. PHP's
		// '+6 months' overflows instead of clamping — a 30 August year end became 30 February and
		// therefore 2 March, publishing a deadline two days after the real one.
		$y = (int) $dt->format( 'Y' );
		$m = (int) $dt->format( 'n' ) + 6;
		$d = (int) $dt->format( 'j' );
		$y += intdiv( $m - 1, 12 );
		$m  = ( ( $m - 1 ) % 12 ) + 1;
		return self::clamp_date( $y, $m, $d );
	}

	// ── The one write choke point ─────────────────────────────────────────────

	/**
	 * Post ONE balanced journal entry, or post nothing at all.
	 *
	 * $lines is a list of [ account, debit, credit, party_uid?, memo? ] in integer CAD cents. A
	 * line is a debit OR a credit, never both — a line carrying both is a sign error wearing a
	 * disguise, and summing it would balance an entry that means nothing.
	 *
	 * Idempotent by $ref, so a retried import, a replayed webhook and a re-run migration all land
	 * exactly one entry. Returns the entry id (existing or new), or 0 when nothing was written.
	 *
	 * A torn write — the header inserted, a line refused — is DELETED rather than kept. That is not
	 * a ledger mutation: an entry whose lines do not sum was never a valid entry, and leaving it
	 * behind would break every statement derived from the lines. The house append-only rule
	 * protects records that were once true; this one never was.
	 */
	private static function journal( $ref, $on_date, $memo, $lines, $source = 'manual', $invoice_id = 0 ) {
		self::ensure_tables();
		$ref = substr( sanitize_text_field( (string) $ref ), 0, 96 );
		if ( '' === $ref ) { error_log( 'AQ Books: journal refused — empty ref' ); return 0; }

		$on_date = self::norm_date( $on_date );
		if ( '' === $on_date ) { error_log( "AQ Books: journal refused ref={$ref} — bad date" ); return 0; }

		$existing = (int) Data::col( 'SELECT id FROM ' . Data::t( 'aq_books_entry' ) . ' WHERE ref = %s', [ $ref ] );
		if ( $existing ) { return $existing; }

		$fy = self::fy_of( $on_date );
		if ( in_array( $fy['label'], self::locked_years(), true ) ) {
			error_log( "AQ Books: journal refused ref={$ref} — {$fy['label']} is filed and locked" );
			return 0;
		}
		if ( $on_date < self::INCORPORATED ) {
			error_log( "AQ Books: journal refused ref={$ref} — dated before incorporation" );
			return 0;
		}

		$dr = 0; $cr = 0; $clean = [];
		foreach ( (array) $lines as $l ) {
			$acct = (string) ( $l['account'] ?? '' );
			if ( ! isset( self::ACCOUNTS[ $acct ] ) ) {
				error_log( "AQ Books: journal refused ref={$ref} — unknown account '{$acct}'" );
				return 0;
			}
			$d = (int) ( $l['debit'] ?? 0 );
			$c = (int) ( $l['credit'] ?? 0 );
			if ( $d < 0 || $c < 0 ) {
				error_log( "AQ Books: journal refused ref={$ref} — negative amount on '{$acct}' (post the other side instead)" );
				return 0;
			}
			if ( $d > 0 && $c > 0 ) {
				error_log( "AQ Books: journal refused ref={$ref} — line on '{$acct}' is both a debit and a credit" );
				return 0;
			}
			if ( 0 === $d && 0 === $c ) { continue; }
			$dr += $d; $cr += $c;
			$clean[] = [
				'account'   => $acct,
				'debit'     => $d,
				'credit'    => $c,
				'party_uid' => (int) ( $l['party_uid'] ?? 0 ),
				'memo'      => substr( sanitize_text_field( (string) ( $l['memo'] ?? '' ) ), 0, 191 ),
			];
		}
		if ( count( $clean ) < 2 || $dr !== $cr ) {
			error_log( "AQ Books: journal refused ref={$ref} — debits {$dr} != credits {$cr} (" . count( $clean ) . ' lines)' );
			return 0;
		}

		$eid = (int) Data::insert( 'aq_books_entry', [
			'ref'        => $ref,
			'on_date'    => $on_date,
			'fy'         => $fy['label'],
			'memo'       => substr( sanitize_text_field( (string) $memo ), 0, 191 ),
			'source'     => substr( sanitize_key( (string) $source ), 0, 24 ),
			'invoice_id' => (int) $invoice_id,
			'created'    => Data::now(),
		] );
		if ( ! $eid ) { error_log( "AQ Books: journal INSERT FAILED ref={$ref} — nothing recorded" ); return 0; }

		foreach ( $clean as $l ) {
			$l['entry_id'] = $eid;
			if ( ! Data::insert( 'aq_books_line', $l ) ) {
				global $wpdb;
				$wpdb->delete( Data::t( 'aq_books_line' ), [ 'entry_id' => $eid ] );
				$wpdb->delete( Data::t( 'aq_books_entry' ), [ 'id' => $eid ] );
				error_log( "AQ Books: line INSERT FAILED ref={$ref} — the whole entry was rolled back" );
				return 0;
			}
		}
		return $eid;
	}

	/**
	 * Mirror one fund-ledger row into the general ledger. Called from Funds::fund_append, the single
	 * door every donated cent passes through.
	 *
	 * Money ARRIVING is revenue against cash; money LEAVING a bucket is the Foundation spending it
	 * (a bursary, a prize pool, a redeemed credit) and reduces cash. The fund ledger row id is the
	 * idempotency anchor, so a replayed Stripe fulfilment that finds its existing fund row will also
	 * find its existing journal entry.
	 *
	 * Deliberately best-effort in ONE direction only: if the books tables are absent this no-ops, so
	 * a donation is never blocked by bookkeeping. It is not best-effort about correctness — an
	 * unbalanced mirror is refused by journal() like any other entry.
	 */
	public static function mirror_fund( $fund_id, $bucket, $cents, $note = '', $kind = '' ) {
		$fund_id = (int) $fund_id;
		$cents   = (int) $cents;
		if ( $fund_id < 1 || 0 === $cents ) { return 0; }
		if ( get_option( 'aq_books_table_version' ) !== self::TABLE_VERSION ) { return 0; }
		$memo = substr( sanitize_text_field( (string) ( $note ?: $bucket ) ), 0, 191 );
		$date = self::today();
		// A TRANSFER BETWEEN BUCKETS IS NOT AN ECONOMIC EVENT. A fund bucket is an earmark, not a GL
		// account: money moving from one to another has not been received and has not been spent, and
		// the cash balance is unchanged. Booking each half by its sign posted a matching fake expense
		// and fake gift, which balanced perfectly and inflated both totals.
		if ( 'transfer' === $kind ) { return 0; }
		// A REFUND is revenue coming back, not a grant being paid: it reverses the gift entry rather
		// than recording money spent on someone. Same cash credit, different debit.
		if ( 'refund' === $kind && $cents < 0 ) {
			return self::journal( 'fund:' . $fund_id, $date, $memo, [
				[ 'account' => 'donations', 'debit'  => -$cents, 'memo' => $memo ],
				[ 'account' => 'cash',      'credit' => -$cents, 'memo' => 'Refunded from ' . $bucket ],
			], 'donation', 0 );
		}
		if ( $cents > 0 ) {
			return self::journal( 'fund:' . $fund_id, $date, $memo, [
				[ 'account' => 'cash',      'debit'  => $cents, 'memo' => 'Received into ' . $bucket ],
				[ 'account' => 'donations', 'credit' => $cents, 'memo' => $memo ],
			], 'donation', 0 );
		}
		return self::journal( 'fund:' . $fund_id, $date, $memo, [
			[ 'account' => 'grants_out', 'debit'  => -$cents, 'memo' => $memo ],
			[ 'account' => 'cash',       'credit' => -$cents, 'memo' => 'Paid out of ' . $bucket ],
		], 'donation', 0 );
	}

	/**
	 * Mirror a COIN SALE — a member paid fiat and received ArtaCoin.
	 *
	 * Donations reach the books because Funds::fund_append mirrors them. Coin sales are the platform's
	 * OTHER live fiat rail (Stripe is in live mode with cash-out enabled) and reached them not at all:
	 * Economy::fulfil_coin_purchase minted against a captured payment and wrote no journal entry, so
	 * the balance sheet showed neither the cash that came in nor the obligation it created. That is not
	 * a modelling choice — the chart of accounts already carries `coin_liability`, and the filing notes
	 * already describe ArtaCoin as an obligation of the Foundation.
	 *
	 * A sale is not revenue: the Foundation owes the coin. Cash rises, and so does what it owes.
	 * Idempotent on the coin-ledger ref, which is the same ref the ledger row carries.
	 */
	public static function mirror_coin_sale( $ref, $uid, $coins, $cad_cents ) {
		$cad_cents = (int) $cad_cents;
		$coins     = (int) $coins;
		if ( $cad_cents < 1 || $coins < 1 || (string) $ref === '' ) { return 0; }
		if ( get_option( 'aq_books_table_version' ) !== self::TABLE_VERSION ) { return 0; }
		return self::journal( 'coinbuy:' . $ref, self::today(), $coins . ' ₳ sold', [
			[ 'account' => 'cash',           'debit'  => $cad_cents, 'party_uid' => (int) $uid, 'memo' => 'Coin top-up received' ],
			[ 'account' => 'coin_liability', 'credit' => $cad_cents, 'party_uid' => (int) $uid, 'memo' => $coins . ' ₳ issued to a member' ],
		], 'coin', 0 );
	}

	/**
	 * Mirror a CASH-OUT — a member redeemed ArtaCoin and real money left the platform. The mirror of
	 * the sale above: the obligation is discharged and cash falls.
	 */
	public static function mirror_cashout( $ref, $uid, $coins, $cad_cents ) {
		$cad_cents = (int) $cad_cents;
		$coins     = (int) $coins;
		if ( $cad_cents < 1 || $coins < 1 || (string) $ref === '' ) { return 0; }
		if ( get_option( 'aq_books_table_version' ) !== self::TABLE_VERSION ) { return 0; }
		return self::journal( 'coinout:' . $ref, self::today(), $coins . ' ₳ redeemed', [
			[ 'account' => 'coin_liability', 'debit'  => $cad_cents, 'party_uid' => (int) $uid, 'memo' => $coins . ' ₳ redeemed by a member' ],
			[ 'account' => 'cash',           'credit' => $cad_cents, 'party_uid' => (int) $uid, 'memo' => 'Paid out to a member' ],
		], 'coin', 0 );
	}

	/** 'YYYY-MM-DD' or '' — a real calendar date, not merely a well-shaped string. */
	private static function norm_date( $v ) {
		$v = trim( (string) $v );
		if ( ! preg_match( '/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m ) ) { return ''; }
		return checkdate( (int) $m[2], (int) $m[3], (int) $m[1] ) ? $v : '';
	}

	// ── Reading the ledger ────────────────────────────────────────────────────

	/**
	 * Net movement per account over a date window, as [ account => cents ] in the account's own
	 * natural direction: assets and expenses positive on a debit, liabilities, equity and revenue
	 * positive on a credit. Both bounds inclusive; '' means unbounded.
	 */
	public static function movement( $from = '', $to = '' ) {
		self::ensure_tables();
		$where = [];
		$args  = [];
		if ( '' !== $from ) { $where[] = 'e.on_date >= %s'; $args[] = $from; }
		if ( '' !== $to )   { $where[] = 'e.on_date <= %s'; $args[] = $to; }
		$sql = 'SELECT l.account, COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM '
			. Data::t( 'aq_books_line' ) . ' l JOIN ' . Data::t( 'aq_books_entry' ) . ' e ON e.id = l.entry_id'
			. ( $where ? ' WHERE ' . implode( ' AND ', $where ) : '' ) . ' GROUP BY l.account';
		$out = [];
		foreach ( Data::all( $sql, $args ) as $r ) {
			$acct = (string) $r['account'];
			if ( ! isset( self::ACCOUNTS[ $acct ] ) ) { continue; }
			$type = self::ACCOUNTS[ $acct ][1];
			$out[ $acct ] = in_array( $type, [ 'asset', 'expense' ], true )
				? (int) $r['d'] - (int) $r['c']
				: (int) $r['c'] - (int) $r['d'];
		}
		return $out;
	}

	/** Raw debit/credit totals over a window — the trial balance, before any natural-direction flip. */
	public static function trial_balance( $from = '', $to = '' ) {
		self::ensure_tables();
		$where = [];
		$args  = [];
		if ( '' !== $from ) { $where[] = 'e.on_date >= %s'; $args[] = $from; }
		if ( '' !== $to )   { $where[] = 'e.on_date <= %s'; $args[] = $to; }
		$sql = 'SELECT COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM '
			. Data::t( 'aq_books_line' ) . ' l JOIN ' . Data::t( 'aq_books_entry' ) . ' e ON e.id = l.entry_id'
			. ( $where ? ' WHERE ' . implode( ' AND ', $where ) : '' );
		$r = Data::one( $sql, $args );
		return [ 'debits' => (int) ( $r['d'] ?? 0 ), 'credits' => (int) ( $r['c'] ?? 0 ) ];
	}

	/**
	 * The two statements for one fiscal period.
	 *
	 * The balance sheet is CUMULATIVE from incorporation to the period end; the statement of
	 * operations is the period alone. Accumulated surplus/(deficit) is DERIVED — cumulative revenue
	 * less cumulative expenses — never posted, so there is no year-end closing entry to forget and
	 * no way for the equity line to drift from the income it represents.
	 */
	public static function period_statements( $fy ) {
		$cum    = self::movement( '', $fy['end'] );
		$per    = self::movement( $fy['start'], $fy['end'] );
		$assets = []; $liabs = []; $rev = []; $exp = [];
		foreach ( self::ACCOUNTS as $code => $a ) {
			$row_c = [ 'account' => $code, 'label' => $a[0], 'gifi' => $a[2], 'gifi_short' => $a[3], 'cents' => (int) ( $cum[ $code ] ?? 0 ) ];
			$row_p = [ 'account' => $code, 'label' => $a[0], 'gifi' => $a[2], 'gifi_short' => $a[3], 'cents' => (int) ( $per[ $code ] ?? 0 ) ];
			if ( 'asset' === $a[1] )     { $assets[] = $row_c; }
			if ( 'liability' === $a[1] ) { $liabs[]  = $row_c; }
			if ( 'revenue' === $a[1] )   { $rev[]    = $row_p; }
			if ( 'expense' === $a[1] )   { $exp[]    = $row_p; }
		}
		$sum = fn( $rows ) => array_sum( array_map( fn( $r ) => $r['cents'], $rows ) );

		$total_assets = $sum( $assets );
		$total_liabs  = $sum( $liabs );
		$total_rev    = $sum( $rev );
		$total_exp    = $sum( $exp );

		// Cumulative result to the period end = the accumulated surplus/(deficit).
		$cum_rev = 0; $cum_exp = 0;
		foreach ( self::ACCOUNTS as $code => $a ) {
			if ( 'revenue' === $a[1] ) { $cum_rev += (int) ( $cum[ $code ] ?? 0 ); }
			if ( 'expense' === $a[1] ) { $cum_exp += (int) ( $cum[ $code ] ?? 0 ); }
		}
		$net_assets = $cum_rev - $cum_exp;

		return [
			'fy'      => $fy,
			'position' => [
				'assets'            => $assets,
				'total_assets'      => $total_assets,
				'liabilities'       => $liabs,
				'total_liabilities' => $total_liabs,
				'net_assets'        => $net_assets,
				'balances'          => $total_assets === $total_liabs + $net_assets,
			],
			'operations' => [
				'revenue'       => $rev,
				'total_revenue' => $total_rev,
				'expenses'      => $exp,
				'total_expenses' => $total_exp,
				'result'        => $total_rev - $total_exp,
			],
			// Since incorporation, not this period. Already computed above for the deficit; exposed
			// because "nothing has ever come in" is a claim about all time, and deciding it from one
			// period's revenue would make it reappear the first year donations stop.
			'cumulative' => [ 'revenue' => $cum_rev, 'expenses' => $cum_exp ],
		];
	}

	/**
	 * GET /foundation/statements — the whole published set of books.
	 * ?fy=FY2026 selects a period; the default is the one containing today.
	 */
	public static function statements( $req ) {
		self::ensure_tables();
		$want = sanitize_text_field( (string) Rest::p( $req, 'fy', '' ) );
		$years = self::fy_list();
		$fy = $years ? $years[ count( $years ) - 1 ] : self::fy_of( self::today() );
		foreach ( $years as $y ) { if ( $y['label'] === $want ) { $fy = $y; } }

		$st = self::period_statements( $fy );
		return [
			'entity'   => [
				'name'          => self::ENTITY,
				'bn'            => self::BN,
				'kind'          => 'Canadian non-profit corporation, paragraph 149(1)(l) — NOT a registered charity',
				'incorporated'  => self::INCORPORATED,
				'province'      => self::PROVINCE,
				'receipts'      => false,
				'receipts_note' => 'A non-profit organisation cannot issue official donation receipts for income tax purposes (CRA Summary Policy CSP-N03). Gifts to the Foundation are not tax-deductible.',
			],
			'currency'    => self::CURRENCY,
			'fiscal'      => [
				'year_end'          => self::fy_end_md(),
				'year_end_chosen'   => (string) get_option( 'aq_books_fy_end_chosen', '' ),
				'year_end_settled'  => (bool) get_option( 'aq_books_fy_filed_once', false ),
				'max_first_end'     => self::max_first_year_end(),
				'note'              => 'The first fiscal period must end within 53 weeks of incorporation, and is fixed by the first T2 filed.',
				'years'             => $years,
				'locked'            => self::locked_years(),
				'filing_due'        => self::filing_due( $fy['end'] ),
				'filings'           => self::filings(),
				'archives'          => self::archives(),
			],
			'statements'  => $st,
			'entries'     => self::recent_entries( $fy ),
			'checks'      => self::verify(),
		];
	}

	/** Every entry of a period, newest first, with its lines — the audit trail itself. */
	private static function recent_entries( $fy, $limit = 200 ) {
		// Selected by DATE RANGE, not by the stored fy label. The label is denormalised at write time
		// and never recomputed, so moving the year end (still the operator's to choose until the
		// first T2 is filed) would silently drop entries out of the published audit trail while the
		// statements — which do use the range — went on counting them.
		$rows = Data::all(
			'SELECT id, ref, on_date, memo, source, invoice_id FROM ' . Data::t( 'aq_books_entry' )
			. ' WHERE on_date >= %s AND on_date <= %s ORDER BY on_date DESC, id DESC LIMIT %d',
			[ $fy['start'], $fy['end'], (int) $limit ] );
		if ( ! $rows ) { return []; }
		$ids   = array_map( fn( $r ) => (int) $r['id'], $rows );
		$in    = implode( ',', array_map( 'intval', $ids ) );
		$lines = Data::all( 'SELECT entry_id, account, debit, credit, memo FROM ' . Data::t( 'aq_books_line' )
			. " WHERE entry_id IN ($in) ORDER BY id" );
		$by = [];
		foreach ( $lines as $l ) { $by[ (int) $l['entry_id'] ][] = [
			'account' => $l['account'],
			'label'   => self::ACCOUNTS[ $l['account'] ][0] ?? $l['account'],
			'debit'   => (int) $l['debit'],
			'credit'  => (int) $l['credit'],
			'memo'    => $l['memo'],
		]; }
		return array_map( fn( $r ) => [
			'id'         => (int) $r['id'],
			'ref'        => $r['ref'],
			'date'       => $r['on_date'],
			'memo'       => $r['memo'],
			'source'     => $r['source'],
			'invoice_id' => (int) $r['invoice_id'],
			'lines'      => $by[ (int) $r['id'] ] ?? [],
		], $rows );
	}

	// ── The invoice register ──────────────────────────────────────────────────

	/** GET /foundation/invoices — every invoice with its evidence documents. */
	public static function invoices( $req ) {
		self::ensure_tables();
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_books_invoice' ) . ' ORDER BY paid DESC, id DESC LIMIT 500' );
		$docs = Data::all( 'SELECT id, invoice_id, kind, name, bytes, sha256, mime FROM ' . Data::t( 'aq_books_doc' ) . ' ORDER BY id' );
		$by   = [];
		foreach ( $docs as $d ) {
			$by[ (int) $d['invoice_id'] ][] = [
				'id'     => (int) $d['id'],
				'kind'   => $d['kind'],
				'name'   => $d['name'],
				'bytes'  => (int) $d['bytes'],
				'sha256' => $d['sha256'],
				'mime'   => $d['mime'],
				'url'    => rest_url( 'aq/v1/foundation/invoices/' . (int) $d['invoice_id'] . '/file/' . (int) $d['id'] ),
			];
		}
		$total = 0;
		$items = [];
		foreach ( $rows as $r ) {
			$total += (int) $r['cad_cents'];
			$items[] = [
				'id'          => (int) $r['id'],
				'vendor'      => $r['vendor'],
				'number'      => $r['number'],
				'description' => $r['description'],
				'issued'      => $r['issued'],
				'paid'        => $r['paid'],
				'period'      => [ 'start' => $r['period_start'], 'end' => $r['period_end'] ],
				'currency'    => $r['currency'],
				'subtotal_cents' => (int) $r['subtotal_cents'],
				'tax_cents'   => (int) $r['tax_cents'],
				'total_cents' => (int) $r['total_cents'],
				'fx'          => [ 'rate' => (int) $r['fx_rate'] / 1000000, 'date' => $r['fx_date'], 'source' => $r['fx_source'] ],
				'cad_cents'   => (int) $r['cad_cents'],
				'account'     => $r['account'],
				'gifi'        => self::ACCOUNTS[ $r['account'] ][2] ?? '',
				'tax_note'    => $r['tax_note'],
				'pay_method'  => $r['pay_method'],
				'payer_uid'   => (int) $r['payer_uid'],
				'coins'       => (int) $r['coins'],
				'coin_basis'  => (int) $r['coins'] > 0 ? [
					'price_cad'   => (int) $r['coin_price_1e6'] / 1000000,
					'gold_oz_usd' => (int) $r['gold_oz_usd_1e4'] / 10000,
					'usdcad'      => (int) $r['usdcad_1e6'] / 1000000,
					'rate_date'   => $r['rate_date'],
					'source'      => $r['rate_source'],
				] : null,
				'entry_id'    => (int) $r['entry_id'],
				'note'        => $r['note'],
				'documents'   => $by[ (int) $r['id'] ] ?? [],
			];
		}
		return [ 'items' => $items, 'count' => count( $items ), 'total_cad_cents' => $total, 'currency' => self::CURRENCY ];
	}

	/**
	 * GET /foundation/invoices/{id}/file/{doc} — the evidence document itself.
	 *
	 * This is the CANONICAL address for an invoice document, and the one the API publishes. It sets
	 * Content-Disposition: attachment, nosniff and a sandbox CSP, so a browser saves the file rather
	 * than running anything from our origin.
	 *
	 * SAY THE TRUE THING ABOUT THIS, THOUGH: the bytes live under wp-content/uploads, which IS
	 * web-served on this host (verified against production). So the same file is also reachable at
	 * its direct uploads URL, where none of those headers apply. The headers here are a sensible
	 * default for the link we hand out, NOT a containment boundary, and nothing should be built on
	 * the belief that they are one. What actually keeps this safe is narrower and more reliable:
	 * only an operator can upload, the stored name is the sha256 of the content rather than anything
	 * a stranger chose, and the documents are meant to be public anyway.
	 *
	 * They are PUBLIC by the operator's decision: an invoice is the evidence for a published figure,
	 * and it is worth nothing if a stranger cannot open it.
	 */
	public static function invoice_file( $req ) {
		self::ensure_tables();
		$doc = (int) Rest::pint( $req, 'doc', 0 );
		$inv = (int) Rest::pint( $req, 'id', 0 );
		$row = Data::one( 'SELECT * FROM ' . Data::t( 'aq_books_doc' ) . ' WHERE id = %d AND invoice_id = %d', [ $doc, $inv ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such document', 404 ); }
		$path = self::doc_path( (string) $row['file_key'] );
		if ( '' === $path || ! is_file( $path ) ) { return Rest::err( 'gone', 'The stored file is missing', 410 ); }

		while ( ob_get_level() ) { ob_end_clean(); }
		status_header( 200 );
		header( 'Content-Type: ' . ( $row['mime'] ?: 'application/pdf' ) );
		header( 'Content-Length: ' . (string) filesize( $path ) );
		header( 'Content-Disposition: attachment; filename="' . sanitize_file_name( (string) $row['name'] ) . '"' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Content-Security-Policy: default-src \'none\'; sandbox' );
		header( 'Cache-Control: public, max-age=86400, s-maxage=86400' );
		header( 'X-AQ-SHA256: ' . (string) $row['sha256'] );
		readfile( $path );
		exit;
	}

	/** Where evidence documents live. Outside aq-media on purpose — nothing here is web-root served. */
	private static function doc_dir() {
		$up  = wp_upload_dir();
		$dir = trailingslashit( $up['basedir'] ) . 'aq-books';
		if ( ! is_dir( $dir ) ) { wp_mkdir_p( $dir ); }
		return $dir;
	}

	/** Absolute path for a stored key, or '' if the key tries to escape the directory. */
	private static function doc_path( $key ) {
		$key = (string) $key;
		if ( '' === $key || ! preg_match( '/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/', $key ) ) { return ''; }
		return trailingslashit( self::doc_dir() ) . $key;
	}

	/**
	 * Store one evidence PDF, content-addressed by its own sha256.
	 * Returns [ file_key, sha256, bytes ] or a WP_REST_Response error.
	 */
	private static function store_doc( $f ) {
		$size = (int) ( $f['size'] ?? 0 );
		if ( $size <= 0 ) { return Rest::err( 'empty', 'The file is empty' ); }
		if ( $size > 25 * 1024 * 1024 ) { return Rest::err( 'too_big', 'An invoice PDF may not exceed 25 MB' ); }
		$tmp = (string) ( $f['tmp_name'] ?? '' );
		if ( '' === $tmp || ! is_uploaded_file( $tmp ) ) { return Rest::err( 'failed', 'No uploaded file', 400 ); }
		if ( strncmp( (string) @file_get_contents( $tmp, false, null, 0, 5 ), '%PDF', 4 ) !== 0 ) {
			return Rest::err( 'bad_type', 'That file is not a PDF' );
		}
		$sha = hash_file( 'sha256', $tmp );
		if ( ! $sha ) { return Rest::err( 'failed', 'Could not hash the file', 500 ); }
		$key  = $sha . '.pdf';
		$dest = trailingslashit( self::doc_dir() ) . $key;
		if ( ! is_file( $dest ) && ! @move_uploaded_file( $tmp, $dest ) ) {
			return Rest::err( 'failed', 'Could not store the file', 500 );
		}
		@chmod( $dest, 0644 );
		return [ 'file_key' => $key, 'sha256' => $sha, 'bytes' => $size ];
	}

	// ── Verification — every invariant, checkable by a stranger ────────────────

	/**
	 * Prove the books. Each row is [ check, ok, detail ]. Nothing here trusts a stored total: every
	 * figure is recomputed from the lines, so a check that passes is evidence rather than assertion.
	 */
	/** Integer cents as a readable CAD figure. A check that fails must be legible to whoever reads
	 *  it — "liabilities 84000" is a number nobody can act on; "CA$840.00" is. */
	/** Money for HUMANS, in accounting presentation: a negative is parenthesised, never signed.
	 *  "CA$-432.18" in a column of figures reads as a typo; "(CA$432.18)" reads as a deficit. Every
	 *  string a person sees goes through here — the check details, the ledger memos, the package. */
	private static function cad( $cents ) {
		$c = (int) $cents;
		$s = 'CA$' . number_format( abs( $c ) / 100, 2 );
		return $c < 0 ? '(' . $s . ')' : $s;
	}

	public static function verify() {
		self::ensure_tables();
		$checks = [];

		$tb = self::trial_balance();
		$checks[] = [ 'check' => 'trial_balance', 'ok' => $tb['debits'] === $tb['credits'],
			'detail' => 'debits ' . self::cad( $tb['debits'] ) . ' vs credits ' . self::cad( $tb['credits'] ) ];

		$bad = Data::all(
			'SELECT e.id, e.ref, COALESCE(SUM(l.debit),0) d, COALESCE(SUM(l.credit),0) c FROM '
			. Data::t( 'aq_books_entry' ) . ' e LEFT JOIN ' . Data::t( 'aq_books_line' ) . ' l ON l.entry_id = e.id'
			. ' GROUP BY e.id, e.ref HAVING d <> c OR d = 0' );
		$checks[] = [ 'check' => 'every_entry_balances', 'ok' => ! $bad,
			'detail' => $bad ? count( $bad ) . ' unbalanced: ' . implode( ', ', array_map( fn( $r ) => $r['ref'], array_slice( $bad, 0, 5 ) ) ) : 'all entries balance' ];

		$fy = self::fy_of( self::today() );
		$st = self::period_statements( $fy );
		$checks[] = [ 'check' => 'accounting_equation', 'ok' => (bool) $st['position']['balances'],
			'detail' => 'assets ' . self::cad( $st['position']['total_assets'] ) . ' = liabilities '
				. self::cad( $st['position']['total_liabilities'] ) . ' + net assets ' . self::cad( $st['position']['net_assets'] ) ];

		// Compare the register against the expense DEBITS OF INVOICE ENTRIES ONLY. Comparing it with
		// the net expense balance looks equivalent and is not: the year-end prepaid adjustment
		// CREDITS an expense account, so from the first close onward the net balance is legitimately
		// lower than the register and this check would have gone permanently red — the system's own
		// correct accounting driving its own public proof to "failing".
		$inv_total = (int) Data::col( 'SELECT COALESCE(SUM(cad_cents),0) FROM ' . Data::t( 'aq_books_invoice' ) );
		$exp_total = (int) Data::col(
			'SELECT COALESCE(SUM(l.debit),0) FROM ' . Data::t( 'aq_books_line' ) . ' l JOIN '
			. Data::t( 'aq_books_entry' ) . " e ON e.id = l.entry_id WHERE e.source = 'invoice'" );
		$checks[] = [ 'check' => 'invoices_tie_to_expenses', 'ok' => $inv_total === $exp_total,
			'detail' => 'invoice register ' . self::cad( $inv_total ) . ' vs invoice-sourced expense entries ' . self::cad( $exp_total ) ];

		// Compare the books against the coin rows the books THEMSELVES created ('reimb'), not against
		// the platform-wide circulating supply. coins_issued moves every time any member earns, buys,
		// spends or transfers a coin, so equating it with a bookkeeping figure would turn the public
		// verify endpoint red on the first ordinary wallet movement and stay that way.
		$booked_coins = (int) Data::col( 'SELECT COALESCE(SUM(coins),0) FROM ' . Data::t( 'aq_books_invoice' ) );
		$reimb        = (int) Data::col(
			'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) . ' WHERE reason = %s', [ 'reimb' ] );
		$checks[] = [ 'check' => 'coins_issued_matches_books', 'ok' => $booked_coins === $reimb,
			'detail' => 'books say ' . $booked_coins . ' ₳ issued to settle advances, the coin ledger holds ' . $reimb ];

		$issued     = class_exists( '\\AQ\\Economy' ) ? (int) Economy::counter( 'coins_issued' ) : 0;
		$ledger_sum = (int) Data::col( 'SELECT COALESCE(SUM(delta),0) FROM ' . Data::t( 'aq_coin_ledger' ) );
		$checks[] = [ 'check' => 'coin_counter_matches_ledger', 'ok' => $ledger_sum === $issued,
			'detail' => 'Σ coin ledger ' . $ledger_sum . ' ₳ vs the coins_issued counter ' . $issued ];

		$missing = (int) Data::col(
			'SELECT COUNT(*) FROM ' . Data::t( 'aq_books_doc' ) . " WHERE file_key = '' OR sha256 = ''" );
		$checks[] = [ 'check' => 'every_document_hashed', 'ok' => 0 === $missing,
			'detail' => $missing ? $missing . ' document(s) without a stored hash' : 'all documents carry a sha256' ];

		$orphan = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_books_line' ) . ' l LEFT JOIN '
			. Data::t( 'aq_books_entry' ) . ' e ON e.id = l.entry_id WHERE e.id IS NULL' );
		$checks[] = [ 'check' => 'no_orphan_lines', 'ok' => 0 === $orphan,
			'detail' => $orphan ? $orphan . ' line(s) with no entry' : 'every line belongs to an entry' ];

		// THE CHECK THAT TIES THE FUND LEDGER TO THE BOOKS.
		//
		// Every invariant above this line is internal to the general ledger: it can prove the ledger is
		// self-consistent, and nothing more. All eight stayed green through two real defects. A refund
		// wrote aq_fund_ledger directly and never mirrored, so the published income statement kept the
		// gift as revenue and as cash after the money had gone back. And a pure bucket transfer was
		// mirrored as a matching fake expense and fake gift, which balanced perfectly while overstating
		// both totals. A ledger that only checks itself cannot see either.
		//
		// So: every cent in the fund ledger must be answered by a journal entry keyed on its row id.
		// A bypass shows up as a missing entry; the transfer rows are legitimately absent, so they are
		// excluded by the same 'transfer' movement kind that keeps them out of the books.
		// Joined in PHP, not in SQL: the natural form needs CONCAT('fund:', f.id) in an ON clause, and
		// this plugin also runs on Studio's SQLite emulation where that is not dependable. Two bounded
		// reads and an array_diff say the same thing on both engines. The 'rename:'/'widen:' refs are
		// the zero-sum bucket transfers, which are correctly absent from the books.
		$fund_rows = Data::all(
			'SELECT id, bucket FROM ' . Data::t( 'aq_fund_ledger' )
			. " WHERE ref NOT LIKE 'rename:%' AND ref NOT LIKE 'widen:%' ORDER BY id DESC LIMIT 500" );
		$unmirrored = [];
		if ( $fund_rows ) {
			$ids  = array_map( static fn( $r ) => (int) $r['id'], $fund_rows );
			$refs = array_map( static fn( $i ) => 'fund:' . $i, $ids );
			$in   = implode( ',', array_fill( 0, count( $refs ), '%s' ) );
			$seen = [];
			foreach ( Data::all( 'SELECT ref FROM ' . Data::t( 'aq_books_entry' ) . " WHERE ref IN ($in)", $refs ) as $e ) {
				$seen[ (string) $e['ref'] ] = true;
			}
			foreach ( $fund_rows as $r ) {
				if ( ! isset( $seen[ 'fund:' . (int) $r['id'] ] ) ) { $unmirrored[] = '#' . (int) $r['id'] . ' ' . $r['bucket']; }
			}
		}
		$checks[] = [ 'check' => 'fund_ledger_mirrored', 'ok' => ! $unmirrored,
			'detail' => $unmirrored
				? count( $unmirrored ) . ' fund row(s) with no journal entry: ' . implode( ', ', array_slice( $unmirrored, 0, 6 ) )
				: 'every fund-ledger movement is mirrored into the books (last 500)' ];

		return $checks;
	}

	/** GET /foundation/books/verify — the invariants alone, for a monitor or a sceptic. */
	public static function verify_rest( $req ) {
		$c = self::verify();
		return [ 'checks' => $c, 'ok' => ! array_filter( $c, fn( $x ) => ! $x['ok'] ) ];
	}

	// ── The CRA package ───────────────────────────────────────────────────────

	/**
	 * GET /foundation/cra — the year-end filing package, computed from the ledger.
	 *
	 * This PREPARES a return; it does not file one. It produces the GIFI schedules CRA wants with
	 * the T2 (100 balance sheet, 101 opening balance sheet in the first year, 125 income statement,
	 * 141 additional information), applies the three T1044 threshold tests, and states the deadline.
	 *
	 * The T1044 test is deliberately conservative in one direction: it reports "not required" when
	 * no threshold is met, and says so loudly, because filing one voluntarily is a ONE-WAY RATCHET
	 * — CRA requires an information return for every subsequent period once one has been filed,
	 * with a $25/day penalty attached forever after.
	 */
	public static function cra( $req ) {
		self::ensure_tables();
		return self::cra_package( sanitize_text_field( (string) Rest::p( $req, 'fy', '' ) ) );
	}

	/**
	 * The package itself, from a fiscal-year LABEL rather than a request.
	 *
	 * Split out because return_pdf() and the year-end cron have no request to hand, and calling the
	 * REST wrapper with null reached Rest::p → $req->get_param() and fatalled. The harness never saw
	 * it: its Rest::p stub returns the default and never touches the argument, so the test proved the
	 * function and not the pathway. Anything callable from cron takes data, not a request.
	 */
	public static function cra_package( $want = '' ) {
		self::ensure_tables();
		$years = self::fy_list();
		$fy    = $years ? $years[ count( $years ) - 1 ] : self::fy_of( self::today() );
		foreach ( $years as $y ) { if ( $y['label'] === $want ) { $fy = $y; } }

		$st  = self::period_statements( $fy );
		$s100 = self::gifi_lines( array_merge( $st['position']['assets'], $st['position']['liabilities'] ) );
		$s125 = self::gifi_lines( array_merge( $st['operations']['revenue'], $st['operations']['expenses'] ) );

		$net = $st['operations']['result'];
		$s100[] = [ 'gifi' => '3600', 'label' => self::GIFI_TOTALS['3600'], 'cents' => $st['position']['net_assets'] ];
		$s100[] = [ 'gifi' => '3620', 'label' => self::GIFI_TOTALS['3620'], 'cents' => $st['position']['net_assets'] ];
		$s100[] = [ 'gifi' => '3640', 'label' => self::GIFI_TOTALS['3640'], 'cents' => $st['position']['total_liabilities'] + $st['position']['net_assets'] ];
		$s125[] = [ 'gifi' => '8299', 'label' => self::GIFI_TOTALS['8299'], 'cents' => $st['operations']['total_revenue'] ];
		$s125[] = [ 'gifi' => '9367', 'label' => self::GIFI_TOTALS['9367'], 'cents' => $st['operations']['total_expenses'] ];
		$s125[] = [ 'gifi' => '9368', 'label' => self::GIFI_TOTALS['9368'], 'cents' => $st['operations']['total_expenses'] ];
		$s125[] = [ 'gifi' => '9970', 'label' => self::GIFI_TOTALS['9970'], 'cents' => $net ];
		$s125[] = [ 'gifi' => '9999', 'label' => self::GIFI_TOTALS['9999'], 'cents' => $net ];

		return [
			'fy'     => $fy,
			'entity' => [ 'name' => self::ENTITY, 'bn' => self::BN, 'incorporated' => self::INCORPORATED, 'province' => self::PROVINCE ],
			'currency' => self::CURRENCY,
			't2' => [
				'required' => true,
				'why'      => 'CRA requires a T2 from every resident corporation for every tax year, even with no tax payable. Only tax-exempt Crown corporations, Hutterite colonies and registered charities are excused — a 149(1)(l) non-profit is not.',
				'form'     => 'T2 Short Return',
				'form_why' => 'Eligible because the corporation is exempt from tax under section 149. Confirm the remaining conditions before filing: one permanent establishment, no taxable dividends paid or received, reporting in Canadian dollars, no refundable credits claimed.',
				'due'      => self::filing_due( $fy['end'] ),
				'schedules' => array_values( array_filter( [
					'100' => 'Schedule 100 — Balance Sheet Information',
					'101' => $fy['first'] ? 'Schedule 101 — Opening Balance Sheet Information (first year only)' : '',
					'125' => 'Schedule 125 — Income Statement Information',
					'141' => 'Schedule 141 — GIFI Additional Information',
				] ) ),
				'gifi_short_eligible' => ( $st['position']['total_assets'] < 100000000 && $st['operations']['total_revenue'] < 100000000 ),
				'gifi_short_note'     => 'Form T1178 (GIFI-Short) may be used on paper when both gross revenue and assets are under $1 million.',
			],
			'schedule_100' => $s100,
			'schedule_101' => $fy['first'] ? [ [ 'gifi' => '3640', 'label' => 'Total liabilities and shareholder equity at incorporation', 'cents' => 0 ] ] : [],
			'schedule_125' => $s125,
			'schedule_141' => self::schedule_141(),
			't1044'        => self::t1044_test( $fy, $years ),
			'notes'        => self::filing_notes( $fy ),
			'generated'    => self::today(),
			'source'       => 'Computed from the published general ledger. Every figure is reproducible from /foundation/statements and /data.',
		];
	}

	/**
	 * Collapse account rows into filed GIFI lines: ONE line per code, amounts summed, labelled with
	 * the code's official description. `accounts` keeps the contributing account labels so a reader
	 * can still see what went into a line the form shows only as a number.
	 */
	private static function gifi_lines( $rows ) {
		$by = [];
		foreach ( $rows as $r ) {
			if ( ! (int) $r['cents'] ) { continue; }
			$code = (string) $r['gifi'];
			if ( ! isset( $by[ $code ] ) ) {
				$by[ $code ] = [
					'gifi'       => $code,
					'gifi_short' => (string) $r['gifi_short'],
					'label'      => self::GIFI_NAMES[ $code ] ?? (string) $r['label'],
					'accounts'   => [],
					'cents'      => 0,
				];
			}
			$by[ $code ]['cents']     += (int) $r['cents'];
			$by[ $code ]['accounts'][] = (string) $r['label'];
		}
		ksort( $by );
		return array_values( $by );
	}

	/**
	 * Schedule 141 — the questions about who prepared the statements. Two of these are facts about
	 * a person, not about the ledger, so they are stored as operator-set options rather than
	 * guessed; the rest are answered from what the books actually contain.
	 */
	private static function schedule_141() {
		$designated = (bool) get_option( 'aq_books_preparer_designated', false );
		return [
			'part1' => [
				[ 'line' => '111', 'q' => 'Can you identify the person primarily involved with the financial information?', 'a' => 'Yes',
					'note' => 'One person prepares more than 50% of the financial information.' ],
				[ 'line' => '095', 'q' => 'Does that person have a professional designation in accounting?', 'a' => $designated ? 'Yes' : 'No',
					'note' => 'Operator-set (aq_books_preparer_designated).' ],
				[ 'line' => '097', 'q' => 'Is that person connected with the corporation?', 'a' => 'Yes',
					'note' => 'A director of the corporation is a connected person by CRA\'s definition.' ],
			],
			'part2' => [ [ 'line' => '304', 'selected' => true, 'q' => 'Provided bookkeeping services' ] ],
			'part3' => [ [ 'line' => '099', 'q' => 'Has the person expressed a reservation?', 'a' => 'n/a',
				'note' => 'Answered only when option 300 (auditor\'s report) or 301 (review engagement) is selected in Part 2.' ] ],
			'part4' => [
				[ 'line' => '101', 'q' => 'Were notes to the financial statements prepared?', 'a' => 'Yes',
					'note' => 'The published statements carry notes — see the notes block of this package.' ],
				[ 'line' => '104', 'q' => 'Did the corporation have any subsequent events?', 'a' => 'Operator to confirm' ],
				[ 'line' => '105', 'q' => 'Did the corporation re-evaluate its assets during the tax year?', 'a' => 'No' ],
				[ 'line' => '106', 'q' => 'Did the corporation have any contingent liabilities during the tax year?', 'a' => 'No',
					'note' => 'The self-assessed GST is measurable and accrued as a liability, so it is not a contingency.' ],
				[ 'line' => '107', 'q' => 'Did the corporation have any commitments during the tax year?', 'a' => 'Operator to confirm' ],
				[ 'line' => '108', 'q' => 'Does the corporation have investments in joint ventures or partnerships?', 'a' => 'No' ],
			],
			'note' => 'Schedule 141 must be completed even when there are no notes to the financial statements.',
		];
	}

	/**
	 * The three T1044 threshold tests. Any ONE of them triggers the information return.
	 * The asset test looks at the PRECEDING period, not the current one — a detail that is easy to
	 * get backwards and that CRA's own worked example turns on.
	 */
	private static function t1044_test( $fy, $years ) {
		$prev_end = '';
		foreach ( $years as $i => $y ) {
			if ( $y['label'] === $fy['label'] && $i > 0 ) { $prev_end = $years[ $i - 1 ]['end']; }
		}
		$prev_assets = 0;
		if ( '' !== $prev_end ) {
			foreach ( self::movement( '', $prev_end ) as $code => $cents ) {
				if ( 'asset' === ( self::ACCOUNTS[ $code ][1] ?? '' ) ) { $prev_assets += $cents; }
			}
		}
		// Only taxable dividends, interest, rentals and royalties count toward the $10,000 test —
		// gifts and membership revenue do NOT. The Foundation books none of those categories today,
		// so the figure is zero by construction rather than by omission.
		$investment_income = 0;
		$filed_before      = (bool) get_option( 'aq_books_t1044_filed_once', false );

		$t1 = $investment_income > 1000000;
		$t2 = $prev_assets > 20000000;
		$t3 = $filed_before;
		$req = $t1 || $t2 || $t3;
		return [
			'required' => $req,
			'tests'    => [
				[ 'test' => 'Taxable dividends, interest, rentals or royalties over $10,000 in the period', 'met' => $t1, 'value_cents' => $investment_income ],
				[ 'test' => 'Total assets over $200,000 at the end of the IMMEDIATELY PRECEDING period', 'met' => $t2, 'value_cents' => $prev_assets, 'as_at' => $prev_end ?: 'no preceding period' ],
				[ 'test' => 'An NPO information return had to be filed for a previous period', 'met' => $t3 ],
			],
			'due'      => $req ? self::filing_due( $fy['end'] ) : '',
			'warning'  => 'Do not file a T1044 voluntarily. Once one has been filed, CRA requires an information return for every subsequent fiscal period regardless of later revenue or assets, and the late-filing penalty is $25 per day (minimum $100, maximum $2,500) for each failure.',
			'note'     => $req ? 'File by mail to the Jonquière Tax Centre, T1044 Program.' : 'No NPO information return is due for this period. The T2 obligation is separate and unconditional.',
		];
	}

	/** Notes to the financial statements — the things a reader must be told, in plain words. */
	private static function filing_notes( $fy ) {
		$notes = [];
		$notes[] = [
			'title' => 'Basis of preparation',
			'body'  => 'These statements are prepared from a double-entry general ledger held in ' . self::CURRENCY
				. ' and published in full. Every figure is the sum of ledger lines; nothing is entered as a total. '
				. 'The ledger, the invoice register and the supporting documents are all public.',
		];
		$notes[] = [
			'title' => 'Not a registered charity',
			'body'  => self::ENTITY . ' is a Canadian non-profit corporation relying on the paragraph 149(1)(l) exemption. '
				. 'It is not a registered charity and cannot issue official donation receipts for income tax purposes. '
				. 'Gifts to the Foundation are not tax-deductible.',
		];
		$notes[] = [
			'title' => 'Expenses paid by a director',
			'body'  => 'Operating costs have been paid personally by a director and recorded as an expense of the Foundation '
				. 'with a matching amount due to that director. Where the director has accepted ArtaCoin in settlement, the '
				. 'amount due is reduced and a coin liability recognised in its place. No cash passed through a Foundation bank account.',
		];
		$notes[] = [
			'title' => 'ArtaCoin is a liability, and it is not gold-backed',
			'body'  => 'ArtaCoin issued to settle a director advance is an obligation of the Foundation, not revenue. '
				. 'The cash that gave rise to it was spent on operating costs, so no gold was acquired to back those coins. '
				. 'The reserve shortfall is stated openly on the reserve page rather than smoothed over.',
		];
		$notes[] = [
			'title' => 'GST self-assessed on imported services',
			'body'  => 'The supplier is registered under CRA\'s simplified regime for non-resident digital suppliers and charged '
				. '0% because a Canadian business number was supplied. That relief is for a recipient who provides a GST/HST '
				. 'REGISTRATION number, and the Foundation is not a registrant — so the tax was not extinguished, it moved. A '
				. 'non-registrant acquiring an imported taxable supply of services self-assesses the tax and remits it on form '
				. 'GST59. It is accrued here at ' . self::GST_RATE_PCT . '% (' . self::GST_JURISDICTION . ') and is NOT '
				. 'recoverable, because an input tax credit requires a registration the Foundation does not hold — which makes '
				. 'it part of the cost of the subscriptions rather than a balance to net off. Two things follow for the '
				. 'operator: stop giving this supplier the business number as though it were a GST/HST registration, and put '
				. 'both the rate and the remittance deadline to an adviser before filing.',
		];
		$notes[] = [
			'title' => 'GIFI balance-sheet subtotals are not asserted here',
			'body'  => 'Each account above carries the GIFI code read off Guide RC4088 with its official '
				. 'description. The balance-sheet SUBTOTAL codes (total assets, total liabilities) are '
				. 'deliberately not asserted: they were not confirmed against the guide, and a wrong code on a '
				. 'filed return is worse than a subtotal the filing software derives for itself. Confirm them '
				. 'there, along with whether Form T1178 (GIFI-Short) is the right vehicle at this size.',
		];
		$notes[] = [
			'title' => 'Records retention',
			'body'  => 'CRA requires records and supporting documents to be kept for six years from the end of the last tax year '
				. 'they relate to. Records that were born electronic must be kept in electronic form; a printout is not sufficient. '
				. 'The invoice PDFs held here are the original electronic documents.',
		];
		return $notes;
	}

	// ── Operator writes ───────────────────────────────────────────────────────

	/**
	 * POST /studio/books/invoice — record a cost and its evidence.
	 *
	 * Multipart: invoice_pdf and/or receipt_pdf files, plus the figures. The figures are TYPED by
	 * the operator rather than parsed out of the PDF, and that is a considered choice: a PDF stores
	 * spaces as positioning rather than as characters, so a pure-PHP parser recovers glyphs but not
	 * the adjacency that binds the word "Total" to the number beside it. A bookkeeping total that
	 * is right 95% of the time manufactures errors that only surface at year end.
	 *
	 * Posts the double entry: expense debited, and either cash or the director's account credited.
	 */
	public static function add_invoice( $req ) {
		self::ensure_tables();
		if ( Rest::throttle( 'books_invoice', 60, 3600 ) ) { return Rest::err( 'rate_limited', 'Slow down', 429 ); }

		$vendor = substr( sanitize_text_field( (string) Rest::p( $req, 'vendor', '' ) ), 0, 160 );
		$number = substr( sanitize_text_field( (string) Rest::p( $req, 'number', '' ) ), 0, 96 );
		$desc   = substr( sanitize_text_field( (string) Rest::p( $req, 'description', '' ) ), 0, 191 );
		$paid   = self::norm_date( Rest::p( $req, 'paid', '' ) );
		$issued = self::norm_date( Rest::p( $req, 'issued', '' ) ) ?: $paid;
		$acct   = (string) Rest::p( $req, 'account', 'software' );
		$cur    = strtoupper( substr( (string) Rest::p( $req, 'currency', self::CURRENCY ), 0, 3 ) );
		$total  = (int) round( (float) Rest::p( $req, 'total', 0 ) * 100 );
		$tax    = (int) round( (float) Rest::p( $req, 'tax', 0 ) * 100 );
		$payer  = (int) Rest::pint( $req, 'payer_uid', 0 );
		// IS THIS AN IMPORTED SERVICE? The Foundation is not a GST/HST registrant, so a non-resident
		// supplier's 0% "reverse charge" against a bare BN does NOT extinguish the tax — it makes the
		// Foundation liable to self-assess it. filing_notes publishes to every reader that this is
		// accrued at 5% as a matter of policy, and the T2 package reports gst_payable straight off the
		// ledger, so an invoice recorded without its GST leg understates a real CRA liability on a
		// published return. Only the three hard-coded founding costs ever got one.
		//
		// Deliberately NOT defaulted. Guessing from the currency would be wrong in both directions (a
		// non-resident can invoice in CAD; a Canadian supplier can invoice in USD), and this is a tax
		// position, so the operator answers it. `imported` accepts 1/0/true/false and nothing else.
		$imported_raw = Rest::p( $req, 'imported_service', null );

		if ( '' === $vendor || '' === $number ) { return Rest::err( 'bad_input', 'A vendor and an invoice number are required.' ); }
		if ( null === $imported_raw || '' === $imported_raw ) {
			return Rest::err( 'bad_input', 'Say whether this is a service bought from a NON-RESIDENT supplier (imported_service: true/false). '
				. 'If it is, the Foundation must self-assess ' . self::GST_RATE_PCT . '% GST on it — the supplier charging 0% does not settle it.' );
		}
		$imported = filter_var( $imported_raw, FILTER_VALIDATE_BOOLEAN );
		if ( '' === $paid )   { return Rest::err( 'bad_input', 'A payment date is required (YYYY-MM-DD).' ); }
		if ( $total <= 0 )    { return Rest::err( 'bad_input', 'The invoice total must be positive.' ); }
		if ( ! isset( self::ACCOUNTS[ $acct ] ) || 'expense' !== self::ACCOUNTS[ $acct ][1] ) {
			return Rest::err( 'bad_input', 'Choose an expense account.' );
		}
		if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE number = %s', [ $number ] ) ) {
			return Rest::err( 'duplicate', 'That invoice number is already recorded.', 409 );
		}

		// Foreign currency converts at the Bank of Canada rate for the day the expense arose, which
		// is what CRA's Income Tax Folio S5-F4-C1 calls the relevant spot rate. A day the Bank does
		// not quote resolves to the most recent published rate at or before it.
		$fx = [ 'rate' => 1000000, 'date' => $paid, 'source' => 'no conversion — invoiced in CAD' ];
		if ( self::CURRENCY !== $cur ) {
			$got = self::fx_rate( $cur, $paid );
			if ( ! $got ) { return Rest::err( 'fx_unavailable', 'Could not resolve an exchange rate for that date. Try again shortly.', 503 ); }
			$fx = $got;
		}
		$cad = (int) round( $total * ( $fx['rate'] / 1000000 ) );

		$files   = (array) $req->get_file_params();
		$stored  = [];
		foreach ( [ 'invoice_pdf' => 'invoice', 'receipt_pdf' => 'receipt' ] as $field => $kind ) {
			if ( empty( $files[ $field ] ) ) { continue; }
			$s = self::store_doc( $files[ $field ] );
			if ( $s instanceof \WP_REST_Response || is_wp_error( $s ) ) { return $s; }
			$s['kind'] = $kind;
			$s['name'] = sanitize_file_name( (string) ( $files[ $field ]['name'] ?? ( $kind . '.pdf' ) ) );
			$stored[]  = $s;
		}

		$id = (int) Data::insert( 'aq_books_invoice', [
			'vendor' => $vendor, 'number' => $number, 'description' => $desc,
			'issued' => $issued, 'paid' => $paid,
			'period_start' => self::norm_date( Rest::p( $req, 'period_start', '' ) ),
			'period_end'   => self::norm_date( Rest::p( $req, 'period_end', '' ) ),
			'currency' => $cur, 'subtotal_cents' => $total - $tax, 'tax_cents' => $tax, 'total_cents' => $total,
			'fx_rate' => (int) $fx['rate'], 'fx_date' => (string) $fx['date'], 'fx_source' => substr( (string) $fx['source'], 0, 191 ),
			'cad_cents' => $cad, 'account' => $acct,
			'tax_note' => substr( sanitize_text_field( (string) Rest::p( $req, 'tax_note', '' ) ), 0, 191 ),
			'pay_method' => substr( sanitize_text_field( (string) Rest::p( $req, 'pay_method', '' ) ), 0, 64 ),
			'payer_uid' => $payer,
			'note' => substr( sanitize_text_field( (string) Rest::p( $req, 'note', '' ) ), 0, 191 ),
			'created' => Data::now(),
		] );
		if ( ! $id ) { return Rest::err( 'failed', 'Could not record the invoice', 500 ); }

		foreach ( $stored as $s ) {
			Data::insert( 'aq_books_doc', [
				'invoice_id' => $id, 'kind' => $s['kind'], 'name' => $s['name'],
				'file_key' => $s['file_key'], 'mime' => 'application/pdf', 'bytes' => (int) $s['bytes'],
				'sha256' => $s['sha256'], 'uploaded_by' => Rest::uid(), 'created' => Data::now(),
			] );
		}

		// A cost paid personally by a director is owed back to them; one paid from a Foundation
		// account reduces cash. Both are the same expense.
		$funded = $payer > 0 ? 'due_director' : 'cash';
		$eid = self::journal( 'inv:' . $number, $paid, $vendor . ' — ' . ( $desc ?: $number ), [
			[ 'account' => $acct,   'debit'  => $cad, 'memo' => $vendor . ' ' . $number ],
			[ 'account' => $funded, 'credit' => $cad, 'party_uid' => $payer, 'memo' => $payer > 0 ? 'Paid personally by a director' : 'Paid from Foundation funds' ],
		], 'invoice', $id );
		// A register row with no double entry is worse than no row: it shows on the public statement,
		// burns the invoice number against the UNIQUE key so the cost can never be re-entered, and
		// breaks invoices_tie_to_expenses forever. If the journal refused, take the row back out.
		if ( ! $eid ) {
			global $wpdb;
			$wpdb->delete( Data::t( 'aq_books_doc' ), [ 'invoice_id' => $id ] );
			$wpdb->delete( Data::t( 'aq_books_invoice' ), [ 'id' => $id ] );
			error_log( 'AQ Books: add_invoice rolled back ' . $number . ' — the journal refused the entry' );
			return Rest::err( 'not_posted', 'That cost could not be posted to the ledger — check the date is inside an open fiscal period.', 409 );
		}

		// The self-assessed tax is its OWN entry, ref 'gst:<number>', source 'tax' — exactly the shape
		// accrue_founding_gst posts, so the invoices_tie_to_expenses invariant (which compares the
		// register against invoice-SOURCED entries) is unaffected by it. It is not recoverable without
		// a registration, so it debits the expense rather than a receivable.
		if ( $imported ) {
			$gst = (int) round( $cad * self::GST_RATE_PCT / 100 );
			if ( $gst > 0 ) {
				self::journal( 'gst:' . $number, $paid, 'Self-assessed GST — ' . $vendor . ' ' . $number, [
					[ 'account' => $acct,         'debit'  => $gst, 'memo' => self::GST_RATE_PCT . '% of ' . self::cad( $cad ) . ' — not recoverable without a registration' ],
					[ 'account' => 'gst_payable', 'credit' => $gst, 'memo' => 'Owed to CRA on form GST59 · ' . self::GST_JURISDICTION ],
				], 'tax', $id );
			}
		}
		Data::update( 'aq_books_invoice', [ 'entry_id' => $eid ], [ 'id' => $id ] );

		return [ 'ok' => true, 'id' => $id, 'entry_id' => $eid, 'cad_cents' => $cad, 'documents' => count( $stored ) ];
	}

	// ── Rates ─────────────────────────────────────────────────────────────────

	/**
	 * The Bank of Canada daily rate for a currency on a date, as an integer ×1e6.
	 * Returns null when it cannot be resolved — never a guess, because a guessed rate silently
	 * misstates every figure derived from it. Cached per (currency, date) once resolved: a
	 * published historical rate never changes.
	 */
	public static function fx_rate( $currency, $date ) {
		$cur  = strtoupper( preg_replace( '/[^A-Z]/', '', (string) $currency ) );
		$date = self::norm_date( $date );
		if ( '' === $cur || '' === $date || self::CURRENCY === $cur ) { return null; }
		$ck = 'aq_books_fx_' . strtolower( $cur ) . '_' . $date;
		$hit = get_option( $ck );
		if ( is_array( $hit ) && ! empty( $hit['rate'] ) ) { return $hit; }

		$series = 'FX' . $cur . 'CAD';
		$from   = ( new \DateTimeImmutable( $date, new \DateTimeZone( self::TZ ) ) )->modify( '-10 days' )->format( 'Y-m-d' );
		$url    = 'https://www.bankofcanada.ca/valet/observations/' . rawurlencode( $series ) . '/json?start_date=' . $from . '&end_date=' . $date;
		$resp   = wp_remote_get( $url, [ 'timeout' => 8 ] );
		if ( is_wp_error( $resp ) || 200 !== (int) wp_remote_retrieve_response_code( $resp ) ) { return null; }
		$j = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
		$obs = is_array( $j ) && is_array( $j['observations'] ?? null ) ? $j['observations'] : [];
		$best = null;
		foreach ( $obs as $o ) {
			$d = (string) ( $o['d'] ?? '' );
			$v = (float) ( $o[ $series ]['v'] ?? 0 );
			if ( $d && $v > 0 && $d <= $date && ( null === $best || $d > $best['date'] ) ) {
				$best = [ 'rate' => (int) round( $v * 1000000 ), 'date' => $d,
					'source' => 'Bank of Canada Valet ' . $series . ' (' . $d . ')' ];
			}
		}
		if ( ! $best ) { return null; }
		update_option( $ck, $best, false );
		return $best;
	}

	// ── Genesis: the reset and the opening books ──────────────────────────────

	/**
	 * Wipe every ledger and open a clean set of books. Runs AT MOST ONCE, ever.
	 *
	 * GATED ON PRESENCE, NOT ON A VERSION. This block deletes data and then seeds; keying it to a
	 * version constant would re-run it on every future bump. That exact mistake has already cost
	 * this project a real gold reserve once, when a genesis seed keyed to Schema::VERSION deleted
	 * and re-seeded the backing counter on every deploy.
	 *
	 * What is deleted: the coin, points and fund ledgers, the standing projection, and the money
	 * counters. What is NOT: the R2 bandwidth counters, which are metering, not a ledger.
	 *
	 * TWO ALARMS WILL OTHERWISE FIRE, and both are silenced honestly rather than suppressed:
	 *   - Watchdog::check_ledgers compares a rolling checkpoint and would report "append-only
	 *     violated". Its checkpoints are cleared so it re-baselines against the new, empty ledger
	 *     instead of alarming about a deletion the operator ordered.
	 *   - Integrity::check_reserve pages when coins exceed gold. Coins ARE about to exceed gold,
	 *     deliberately and permanently, so the authorised shortfall is recorded as a number. The
	 *     alarm still fires if the real shortfall ever exceeds what was authorised — which is the
	 *     only version of that alarm worth having.
	 */
	public static function genesis() {
		global $wpdb;
		if ( get_option( 'aq_books_genesis' ) ) { return 'already done'; }
		self::ensure_tables();
		if ( get_option( 'aq_books_table_version' ) !== self::TABLE_VERSION ) {
			error_log( 'AQ Books: genesis refused — the books tables are not fully installed' );
			return 'refused: tables incomplete';
		}

		foreach ( [ 'aq_coin_ledger', 'aq_points_ledger', 'aq_fund_ledger', 'aq_standing' ] as $t ) {
			$wpdb->query( 'DELETE FROM ' . Data::t( $t ) );
		}
		$c = Data::t( 'aq_counters' );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $c WHERE name IN ('coins_issued','backing_mg')" ) );
		$wpdb->query( $wpdb->prepare( "DELETE FROM $c WHERE name LIKE %s", $wpdb->esc_like( 'fund_' ) . '%' ) );

		// The watchdog keeps its checkpoints in a FILE, not an option, and its save() is private — so
		// clearing an option here would have written something nothing reads and let three CRITICAL
		// "the money record was tampered with" pages fire anyway.
		if ( class_exists( '\\AQ\\Watchdog' ) ) { Watchdog::forget_ledgers(); }

		update_option( 'aq_books_genesis', self::today(), true );
		return 'reset';
	}

	/**
	 * How many coins have deliberately been issued without gold behind them.
	 *
	 * DERIVED from the invoice register, not accumulated in an option. An accumulator only ever
	 * grows: it would keep raising the ceiling that Integrity::check_reserve subtracts, so a genuine
	 * unbacked mint of up to that size would stop paging anyone. Deriving it means the authorised
	 * figure is exactly what the books can account for, and anything above it is still an alarm.
	 */
	public static function authorised_shortfall() {
		if ( get_option( 'aq_books_table_version' ) !== self::TABLE_VERSION ) { return 0; }
		// Derived from the liability the books STILL CARRY, not from what was once issued. Σ(coins) is
		// a record of the issue and nothing ever decrements it, so using it left the alarm's tolerance
		// pinned at its high-water mark forever: spend the whole tranche and a fresh unbacked mint of
		// the same size would still slip under the ceiling. coin_liability is written down by
		// reconcile_coin_liability as the coins leave circulation, so a ceiling derived from it falls
		// to zero with them. It must NOT be derived from coins_issued either — a bug's mint raises
		// that counter and would raise its own tolerance with it.
		$issued_coins = 0;
		$issued_value = 0;
		foreach ( Data::all( 'SELECT coins, coin_price_1e6 FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE coins > 0' ) as $r ) {
			$c = (int) $r['coins'];
			$issued_coins += $c;
			$issued_value += (int) round( $c * ( (int) $r['coin_price_1e6'] / 1000000 ) * 100 );
		}
		if ( $issued_coins < 1 || $issued_value < 1 ) { return 0; }
		$mv = self::movement();
		$outstanding_value = max( 0, (int) ( $mv['coin_liability'] ?? 0 ) );
		// Up to one reconcile cycle (a day) of lag between a coin being spent and the ceiling
		// following it down. That errs toward the behaviour we already had, never below it.
		return (int) round( $outstanding_value * $issued_coins / $issued_value );
	}

	/**
	 * Settle a director's advance by issuing ArtaCoin, priced at the date the money actually left
	 * their pocket. $basis carries the dated inputs and their sources so the conversion can be
	 * re-run by anyone: gold in USD per troy ounce, USD→CAD, and the date each came from.
	 *
	 * Coins are whole milligrams, so a payment almost never converts exactly. The remainder is NOT
	 * rounded away — it stays owed to the director, which is both the honest number and the one
	 * that keeps the entry balanced.
	 */
	public static function settle_in_coin( $uid, $invoice_id, $cad_cents, $basis ) {
		self::ensure_tables();
		$uid       = (int) $uid;
		$cad_cents = (int) $cad_cents;
		$inv       = Data::one( 'SELECT * FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE id = %d', [ (int) $invoice_id ] );
		if ( ! $inv || $uid < 1 || $cad_cents < 1 ) { return 0; }

		$price = (float) $basis['price'];
		if ( $price <= 0 ) { return 0; }
		$coins = (int) floor( $cad_cents / ( $price * 100 ) );
		if ( $coins < 1 ) { return 0; }
		$value = (int) round( $coins * $price * 100 );
		if ( $value > $cad_cents ) { return 0; }

		$ref = 'coinsettle:' . $inv['number'];
		$eid = self::journal( $ref, (string) $inv['paid'],
			'ArtaCoin issued to settle the advance for ' . $inv['number'], [
				[ 'account' => 'due_director',   'debit'  => $value, 'party_uid' => $uid, 'memo' => $coins . ' ₳ at ' . number_format( $price, 4 ) . ' CAD, priced ' . $basis['rate_date'] ],
				[ 'account' => 'coin_liability', 'credit' => $value, 'party_uid' => $uid, 'memo' => $coins . ' ₳ issued, not gold-backed' ],
			], 'coin', (int) $inv['id'] );
		if ( ! $eid ) { return 0; }

		// The coin ledger is the money record and stays the source of truth for balances. Its ref
		// matches the books entry, so the two can be reconciled row for row forever.
		if ( class_exists( '\\AQ\\Economy' ) && ! Data::col(
			'SELECT 1 FROM ' . Data::t( 'aq_coin_ledger' ) . ' WHERE reason = %s AND ref = %s LIMIT 1', [ 'reimb', $ref ] ) ) {
			Economy::credit_coins( $uid, $coins, 'reimb', $ref );
		}
		// No add_backing() call, and that omission is the whole point: the cash went to a supplier,
		// so there is no gold. The shortfall needs no separate bookkeeping: authorised_shortfall()
		// derives it from the invoice row updated just below, so it can never drift from the books.

		Data::update( 'aq_books_invoice', [
			'coins'           => $coins,
			'coin_price_1e6'  => (int) round( $price * 1000000 ),
			'gold_oz_usd_1e4' => (int) round( (float) $basis['gold_oz_usd'] * 10000 ),
			'usdcad_1e6'      => (int) round( (float) $basis['usdcad'] * 1000000 ),
			'rate_date'       => (string) $basis['rate_date'],
			'rate_source'     => substr( (string) $basis['source'], 0, 191 ),
		], [ 'id' => (int) $inv['id'] ] );
		return $coins;
	}

	// ── The filing package, as a PDF ──────────────────────────────────────────

	/**
	 * The T2 Short Return's own field numbers, read off form T2 SHORT E (19).
	 *
	 * The package prints the LINE NUMBER beside every value, because that is the difference between
	 * "here are our accounts" and "here is what to type into box 085". Whoever fills the form —
	 * the operator, an accountant, a piece of certified software — is transcribing, not deriving.
	 */
	const T2_FIELDS = [
		'001' => 'Business number',
		'002' => "Corporation's name",
		'015' => 'Head office — city',
		'016' => 'Head office — province',
		'017' => 'Head office — country',
		'018' => 'Head office — postal code',
		'040' => 'Type of corporation at the end of the tax year',
		'085' => 'If exempt from tax under section 149, tick one',
		'060' => 'Tax year start',
		'061' => 'Tax year-end',
		'070' => 'Date of incorporation',
		'280' => 'Is the corporation inactive?',
		'300' => 'Net income or (loss) for income tax purposes',
		'750' => 'Provincial/territorial jurisdiction',
		'990' => 'Language of correspondence (1 English, 2 French)',
	];

	/** Where a value is a fact about a person rather than about the books, it is asked for, not
	 *  invented. Options the operator sets; the package prints the gap until they do. */
	private static function signer() {
		return [
			'last'  => (string) get_option( 'aq_books_signer_last', '' ),
			'first' => (string) get_option( 'aq_books_signer_first', '' ),
			'role'  => (string) get_option( 'aq_books_signer_role', 'Director' ),
			'phone' => (string) get_option( 'aq_books_signer_phone', '' ),
		];
	}

	/**
	 * Render the whole year-end filing package as a PDF.
	 *
	 * It PREPARES a return; it does not file one, and it says so on the cover in the largest type on
	 * the page. Paper filing is open to this corporation specifically: CRA made electronic filing
	 * mandatory for tax years starting after 2023 but exempted "corporations that are exempt from
	 * tax payable under section 149", which is what a 149(1)(l) non-profit is. That single fact is
	 * what makes a printable package worth generating rather than a curiosity.
	 */
	public static function return_pdf( $fy_label = '', $generated = '' ) {
		self::ensure_tables();
		// The generation date is stamped in the footer, so leaving it as "today" would make every
		// regeneration produce different bytes — and a package whose hash moves daily cannot be the
		// one you filed. Archiving pins it, so the stored sha256 stays checkable forever.
		$generated = self::norm_date( $generated ) ?: self::today();
		$years = self::fy_list();
		$fy    = $years ? $years[ count( $years ) - 1 ] : self::fy_of( self::today() );
		foreach ( $years as $y ) { if ( $y['label'] === $fy_label ) { $fy = $y; } }

		$st   = self::period_statements( $fy );
		$pos  = $st['position'];
		$ops  = $st['operations'];
		$cra  = self::cra_package( $fy['label'] );
		$t1044 = self::t1044_test( $fy, $years );
		$due  = self::filing_due( $fy['end'] );
		$sign = self::signer();
		$m = fn( $c ) => self::cad( (int) $c ); // cad() already renders a negative in parentheses

		$pdf = new Pdf(
			self::ENTITY . ' — ' . $fy['label'] . ' filing package',
			'Generated from the published ledger at artaquest.com/finances · ' . $generated
		);

		// ── Cover ──
		$pdf->h1( self::ENTITY );
		$pdf->para( 'Year-end filing package for ' . $fy['label'] . ' (' . $fy['start'] . ' to ' . $fy['end'] . ')', 11, 0.1 );
		$pdf->gap( 4 );
		$pdf->kv( 'Business number', self::BN );
		$pdf->kv( 'Incorporated', self::INCORPORATED );
		$pdf->kv( 'Jurisdiction', 'Alberta, Canada' );
		$pdf->kv( 'Entity type', 'Non-profit corporation, exempt under ITA paragraph 149(1)(l)' );
		$pdf->kv( 'Registered charity', 'No' );
		$pdf->kv( 'Fiscal year end', self::fy_end_md() . ( get_option( 'aq_books_fy_end_chosen' ) ? ' (chosen ' . get_option( 'aq_books_fy_end_chosen' ) . ')' : '' ) );
		$pdf->kv( 'Return due', $due );
		$pdf->kv( 'Reporting currency', self::CURRENCY );
		$pdf->gap( 8 );
		$pdf->h2( 'This package is prepared, not filed' );
		$pdf->para( 'Nothing here has been submitted to the Canada Revenue Agency. It is generated automatically from the '
			. 'Foundation\'s published general ledger so that the figures on a return are transcribed from the books rather '
			. 'than re-derived by hand. Every amount below is the sum of ledger entries published at artaquest.com/finances '
			. 'and reproducible from the raw tables at artaquest.com/data.' );
		$pdf->para( 'Have it reviewed before it is filed. It encodes a reading of the rules, and a reading is not advice.' );

		// ── What must be filed ──
		$pdf->h2( 'What has to be filed for this period' );
		$pdf->h3( 'T2 Corporation Income Tax Return — REQUIRED' );
		$pdf->para( 'Every resident corporation files a T2 for every tax year even with no tax payable. CRA excuses only '
			. 'tax-exempt Crown corporations, Hutterite colonies and registered charities; a non-profit is none of those. '
			. 'The section 149 exemption removes the tax, not the return.' );
		$pdf->row( 'Form', 'T2 Short Return', true );
		$pdf->row( 'Due', $due, true );
		$pdf->para( 'The T2 Short is available because the corporation is exempt from tax under section 149. Confirm the '
			. 'remaining conditions before filing: a permanent establishment in only one province, no taxable dividends paid '
			. 'or received, reporting in Canadian dollars, and no refundable credits claimed other than a refund of instalments.' );
		$pdf->para( 'Electronic filing is mandatory for tax years starting after 2023 — except for corporations exempt from '
			. 'tax payable under section 149, which includes this one. This package may therefore be completed on paper.' );

		$pdf->h3( 'T1044 NPO Information Return — ' . ( $t1044['required'] ? 'REQUIRED' : 'NOT required for this period' ) );
		foreach ( $t1044['tests'] as $t ) {
			$pdf->row( ( $t['met'] ? '[MET] ' : '[ - ] ' ) . $t['test'], isset( $t['value_cents'] ) ? $m( (int) $t['value_cents'] ) : '' );
		}
		$pdf->para( $t1044['warning'] );

		// ── The T2 Short, field by field ──
		$pdf->page_break();
		$pdf->h1( 'T2 Short Return — what to enter' );
		$pdf->para( 'Line numbers are the form\'s own. Values come from the ledger except where marked, which are facts about '
			. 'a person or a filing choice and must be supplied by the signing officer.' );
		$vals = [
			'001' => self::BN . '  (add the RC program account, e.g. RC0001)',
			'002' => self::ENTITY,
			'015' => 'Edmonton',
			'016' => 'AB',
			'017' => 'Canada',
			'018' => 'T5J 3B1',
			'040' => '5 — Other corporation (a corporation without share capital)',
			'085' => '1 — Exempt under paragraph 149(1)(e) or 149(1)(l)',
			'060' => $fy['start'],
			'061' => $fy['end'],
			'070' => self::INCORPORATED,
			'280' => ( 0 === $pos['total_assets'] && 0 === $ops['total_expenses'] && 0 === $ops['total_revenue'] ) ? 'Yes' : 'No',
			'300' => $m( $ops['result'] ),
			'750' => 'Alberta',
			'990' => '1',
		];
		foreach ( self::T2_FIELDS as $line => $label ) {
			$pdf->field( $line, $label, (string) ( $vals[ $line ] ?? '' ) );
		}
		$pdf->gap( 4 );
		$pdf->para( 'Line 280 is answered No because there is balance sheet and income statement information to report. An '
			. 'organisation that merely pays a bank charge is not inactive for this purpose.' );
		$pdf->h3( 'Certification — to be completed by the signing officer' );
		$pdf->field( '950', 'Last name', $sign['last'] ?: '________________________' );
		$pdf->field( '951', 'First name', $sign['first'] ?: '________________________' );
		$pdf->field( '954', 'Position, office or rank', $sign['role'] ?: '________________________' );
		$pdf->field( '955', 'Date', '________________________' );
		$pdf->field( '956', 'Telephone number', $sign['phone'] ?: '________________________' );

		// ── GIFI schedules ──
		$pdf->page_break();
		$pdf->h1( 'GIFI schedules' );
		$pdf->para( 'Financial statement information must be filed with the T2 in GIFI form; traditional financial statements '
			. 'are not submitted. Codes are from Guide RC4088.' );
		$pdf->h2( 'Schedule 100 — Balance sheet information' );
		foreach ( $cra['schedule_100'] as $r ) {
			$pdf->row( $r['gifi'] . '   ' . $r['label'], $m( (int) $r['cents'] ), in_array( $r['gifi'], [ '3600', '3620', '3640' ], true ),
				count( (array) ( $r['accounts'] ?? [] ) ) > 1 ? implode( ' + ', $r['accounts'] ) : '' );
		}
		if ( $fy['first'] ) {
			$pdf->h2( 'Schedule 101 — Opening balance sheet information' );
			$pdf->para( 'Required in the first year after incorporation. The corporation held nothing on the day it was formed.' );
			$pdf->row( '3640   Total liabilities and shareholder equity at ' . self::INCORPORATED, $m( 0 ), true );
		}
		$pdf->h2( 'Schedule 125 — Income statement information' );
		foreach ( $cra['schedule_125'] as $r ) {
			$pdf->row( $r['gifi'] . '   ' . $r['label'], $m( (int) $r['cents'] ), in_array( $r['gifi'], [ '8299', '9368', '9970', '9999' ], true ),
				count( (array) ( $r['accounts'] ?? [] ) ) > 1 ? implode( ' + ', $r['accounts'] ) : '' );
		}

		$pdf->h2( 'Schedule 141 — GIFI additional information' );
		$s141 = self::schedule_141();
		foreach ( [ 'part1', 'part2', 'part3', 'part4' ] as $part ) {
			foreach ( (array) ( $s141[ $part ] ?? [] ) as $q ) {
				$pdf->field( (string) ( $q['line'] ?? '' ), (string) ( $q['q'] ?? ( $q['selected'] ?? '' ) ), (string) ( $q['a'] ?? ( ! empty( $q['selected'] ) ? 'selected' : '' ) ) );
				if ( ! empty( $q['note'] ) ) { $pdf->para( $q['note'], 7.5, 0.5, 34 ); }
			}
		}
		$pdf->para( 'Schedule 141 must be completed even when there are no notes to the financial statements.' );

		// ── The statements, in readable form ──
		$pdf->page_break();
		$pdf->h1( 'Financial statements' );
		$pdf->para( 'Unaudited. Prepared by the Foundation from its own double-entry general ledger. No accountant has '
			. 'audited, reviewed or compiled them.' );
		$pdf->h2( 'Statement of financial position at ' . $fy['end'] );
		$pdf->h3( 'Assets' );
		$any = false;
		foreach ( $pos['assets'] as $a ) { if ( $a['cents'] ) { $pdf->row( $a['label'], $m( $a['cents'] ) ); $any = true; } }
		if ( ! $any ) { $pdf->para( 'None. The Foundation holds no cash; its costs have been met personally by a director.' ); }
		$pdf->row( 'Total assets', $m( $pos['total_assets'] ), true );
		$pdf->h3( 'Liabilities' );
		foreach ( $pos['liabilities'] as $a ) { if ( $a['cents'] ) { $pdf->row( $a['label'], $m( $a['cents'] ) ); } }
		$pdf->row( 'Total liabilities', $m( $pos['total_liabilities'] ), true );
		$pdf->gap( 4 );
		$pdf->row( 'Accumulated surplus / (deficit)', $m( $pos['net_assets'] ), true );
		$pdf->para( $pos['balances']
			? 'Assets equal liabilities plus accumulated surplus, to the cent.'
			: 'THESE FIGURES DO NOT BALANCE. Do not file this package until that is resolved.' );

		$pdf->h2( 'Statement of operations for ' . $fy['label'] );
		$pdf->h3( 'Revenue' );
		$anyr = false;
		foreach ( $ops['revenue'] as $a ) { if ( $a['cents'] ) { $pdf->row( $a['label'], $m( $a['cents'] ) ); $anyr = true; } }
		if ( ! $anyr ) { $pdf->para( 'No revenue this period.' ); }
		$pdf->row( 'Total revenue', $m( $ops['total_revenue'] ), true );
		$pdf->h3( 'Expenses' );
		foreach ( $ops['expenses'] as $a ) { if ( $a['cents'] ) { $pdf->row( $a['label'], $m( $a['cents'] ) ); } }
		$pdf->row( 'Total expenses', $m( $ops['total_expenses'] ), true );
		$pdf->gap( 4 );
		$pdf->row( $ops['result'] < 0 ? 'Deficit for the period' : 'Surplus for the period', $m( $ops['result'] ), true );

		// ── Notes ──
		$pdf->h2( 'Notes to the financial statements' );
		foreach ( self::filing_notes( $fy ) as $n ) {
			$pdf->h3( $n['title'] );
			$pdf->para( $n['body'] );
		}

		// ── The evidence ──
		$pdf->page_break();
		$pdf->h1( 'Supporting records' );
		$pdf->para( 'CRA requires records and supporting documents to be kept for six years from the end of the last tax year '
			. 'they relate to. Records created electronically must be kept electronically; a printout is not sufficient. The '
			. 'originals are the PDFs published beside each entry, and each is listed with the SHA-256 of its bytes so a copy '
			. 'can be proved identical to the one recorded.' );
		$rows = Data::all( 'SELECT * FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE paid >= %s AND paid <= %s ORDER BY paid, id', [ $fy['start'], $fy['end'] ] );
		$docs = [];
		foreach ( Data::all( 'SELECT invoice_id, kind, name, sha256 FROM ' . Data::t( 'aq_books_doc' ) . ' ORDER BY id' ) as $d ) {
			$docs[ (int) $d['invoice_id'] ][] = $d;
		}
		$reg_total = 0;
		foreach ( $rows as $r ) {
			$reg_total += (int) $r['cad_cents'];
			$pdf->row( $r['paid'] . '   ' . $r['vendor'] . ' — ' . $r['description'], $m( (int) $r['cad_cents'] ), false,
				'Invoice ' . $r['number'] . ( $r['pay_method'] ? ' · paid with ' . $r['pay_method'] : '' ) );
			foreach ( (array) ( $docs[ (int) $r['id'] ] ?? [] ) as $d ) {
				$pdf->para( ucfirst( (string) $d['kind'] ) . ': ' . $d['name'] . '  sha256 ' . substr( (string) $d['sha256'], 0, 32 ) . '...', 7, 0.5, 16 );
			}
		}
		$pdf->row( 'Total costs on the register', $m( $reg_total ), true );

		// ── GST ──
		$pdf->h2( 'GST self-assessed on imported services' );
		$gst = 0;
		foreach ( self::movement( $fy['start'], $fy['end'] ) as $code => $cents ) {
			if ( 'gst_payable' === $code ) { $gst = $cents; }
		}
		$pdf->para( 'The supplier is registered under CRA\'s simplified regime for non-resident digital suppliers and charged '
			. '0% because a Canadian business number was supplied. That relief is for a recipient who provides a GST/HST '
			. 'REGISTRATION number, and the Foundation is not a registrant — so the tax was not extinguished, it moved. A '
			. 'non-registrant acquiring an imported taxable supply of services self-assesses the tax and remits it on form GST59.' );
		$pdf->row( 'Consideration for imported taxable supplies', $m( $reg_total ) );
		$pdf->row( 'Rate applied (' . self::GST_JURISDICTION . ')', self::GST_RATE_PCT . '%' );
		$pdf->row( 'Tax self-assessed and accrued', $m( $gst ), true );
		$pdf->para( 'Not recoverable: an input tax credit requires a registration the Foundation does not hold, which makes '
			. 'the tax part of the cost of the supplies rather than a balance to net off. Confirm the rate and the remittance '
			. 'deadline before filing GST59.' );

		// ── Proof ──
		$pdf->h2( 'Arithmetic checks' );
		$pdf->para( 'Recomputed from the raw ledger lines when this package was generated. Anyone can re-run them at '
			. 'artaquest.com/wp-json/aq/v1/foundation/books/verify.' );
		foreach ( self::verify() as $c ) {
			$pdf->row( ( $c['ok'] ? '[PASS] ' : '[FAIL] ' ) . str_replace( '_', ' ', $c['check'] ), '', false, $c['detail'] );
		}
		return $pdf->output();
	}

	/** Every frozen package, newest first: what was generated, when, and the hash of its bytes. */
	public static function archives() {
		self::ensure_tables();
		$out = [];
		foreach ( Data::all( 'SELECT id, name, bytes, sha256, created FROM ' . Data::t( 'aq_books_doc' )
			. " WHERE kind = 'return' ORDER BY id DESC LIMIT 40" ) as $d ) {
			$out[] = [
				'id'      => (int) $d['id'],
				'name'    => (string) $d['name'],
				'bytes'   => (int) $d['bytes'],
				'sha256'  => (string) $d['sha256'],
				'created' => (int) $d['created'],
				'url'     => rest_url( 'aq/v1/foundation/invoices/0/file/' . (int) $d['id'] ),
			];
		}
		return $out;
	}

	/** What has been filed, and when: [ FY2026 => [ t2 => date, t1044 => date ] ]. */
	public static function filings() {
		$v = get_option( 'aq_books_filed', [] );
		return is_array( $v ) ? $v : [];
	}

	/**
	 * Record that a return was actually filed.
	 *
	 * Three things hang off this, which is why it needs recording rather than remembering:
	 * the fiscal year end stops being changeable once the first T2 is in; the T1044 becomes a
	 * PERMANENT annual obligation once one has been filed, so the threshold test has to know;
	 * and the deadline alerts for that period must stop, or they nag about work already done.
	 */
	public static function mark_filed( $fy_label, $which = 't2', $on = '' ) {
		$fy_label = sanitize_text_field( (string) $fy_label );
		$which    = in_array( $which, [ 't2', 't1044' ], true ) ? $which : 't2';
		$known    = false;
		foreach ( self::fy_list() as $y ) { if ( $y['label'] === $fy_label ) { $known = true; } }
		if ( ! $known ) { return 'no such period'; }
		$on = self::norm_date( $on ) ?: self::today();

		$filed = self::filings();
		if ( ! isset( $filed[ $fy_label ] ) ) { $filed[ $fy_label ] = []; }
		$filed[ $fy_label ][ $which ] = $on;
		update_option( 'aq_books_filed', $filed, true );

		if ( 't2' === $which ) {
			// The year end is fixed by the first T2 filed. After this, changing it needs CRA's
			// written permission, so the page must stop offering it as an open choice.
			update_option( 'aq_books_fy_filed_once', 1, true );
		} else {
			// The one-way ratchet: an NPO that has filed once must file for every later period,
			// whatever its revenue or assets. t1044_test reads this.
			update_option( 'aq_books_t1044_filed_once', 1, true );
		}
		// Stop the reminders for this period.
		$sent = get_option( 'aq_books_deadline_sent', [] );
		if ( ! is_array( $sent ) ) { $sent = []; }
		if ( ! in_array( $fy_label . ':filed', $sent, true ) ) {
			$sent[] = $fy_label . ':filed';
			update_option( 'aq_books_deadline_sent', $sent, true );
		}
		return 'recorded';
	}

	/**
	 * POST /studio/books/settings — operator: the signing officer, and recording a filing.
	 *
	 * The signing officer's name and position are facts about a person, not about the books, so they
	 * are asked for rather than invented; the package prints blanks until they are set.
	 */
	public static function settings( $req ) {
		self::ensure_tables();
		$out = [ 'ok' => true ];
		foreach ( [ 'last', 'first', 'role', 'phone' ] as $k ) {
			$v = Rest::p( $req, 'signer_' . $k, null );
			if ( null !== $v ) { update_option( 'aq_books_signer_' . $k, substr( sanitize_text_field( (string) $v ), 0, 80 ), true ); }
		}
		$fy    = sanitize_text_field( (string) Rest::p( $req, 'filed_fy', '' ) );
		$which = sanitize_text_field( (string) Rest::p( $req, 'filed_form', '' ) );
		if ( '' !== $fy && '' !== $which ) {
			$r = self::mark_filed( $fy, $which, (string) Rest::p( $req, 'filed_on', '' ) );
			if ( 'recorded' !== $r ) { return Rest::err( 'bad_input', 'That period is not one the books know about.' ); }
			$out['filed'] = $fy . ':' . $which;
		}
		$out['signer']   = self::signer();
		$out['filings']  = self::filings();
		return $out;
	}

	/**
	 * GET /foundation/cra/pdf — the filing package as a file.
	 * Public, like every other figure it contains.
	 */
	public static function cra_pdf( $req ) {
		self::ensure_tables();
		$want = sanitize_text_field( (string) Rest::p( $req, 'fy', '' ) );
		$fy   = self::fy_of( self::today() );
		foreach ( self::fy_list() as $y ) { if ( $y['label'] === $want ) { $fy = $y; } }
		$bytes = self::return_pdf( $fy['label'] );
		$name  = 'ArtaQuest-Foundation-' . $fy['label'] . '-filing-package.pdf';

		while ( ob_get_level() ) { ob_end_clean(); }
		status_header( 200 );
		header( 'Content-Type: application/pdf' );
		header( 'Content-Length: ' . strlen( $bytes ) );
		header( 'Content-Disposition: attachment; filename="' . $name . '"' );
		header( 'X-Content-Type-Options: nosniff' );
		header( 'Cache-Control: public, max-age=300' );
		header( 'X-AQ-SHA256: ' . hash( 'sha256', $bytes ) );
		echo $bytes; // phpcs:ignore
		exit;
	}

	// ── The founding costs ────────────────────────────────────────────────────

	/** The coin spread in force when these conversions were struck. Pinned, not read from the
	 *  option: a later change to aq_coin_spread must never retroactively reprice a booked entry. */
	const SPREAD_AT_GENESIS = 0.05;

	/** Milligrams in a troy ounce — the same divisor Economy::coin_price() uses, since 1 ₳ = 1 mg. */
	const MG_PER_TROY_OUNCE = 31103.477;

	/** The director whose personal cards paid these costs. Resolved by login so no user id is
	 *  hardcoded; overridable with the aq_books_director_uid option. */
	const DIRECTOR_LOGIN = 'artayab';

	/**
	 * Every cost the Foundation has incurred to date: three Anthropic Claude Max 20x subscriptions,
	 * each invoiced in CAD and each paid personally by a director.
	 *
	 * The rate basis is PINNED rather than fetched. A migration that depends on a live HTTP call is
	 * a migration that behaves differently depending on the weather, and these are historical facts
	 * that will not change: the LBMA Gold Price PM benchmark and the Bank of Canada daily rate, both
	 * permanently archived and free to re-read. Where the transaction fell on a day neither
	 * publishes — 4 July 2026 was a Saturday, and 11 August 2026 had not yet been published when
	 * these were booked — the rule is the most recent published fix at or before the date, and the
	 * date actually used is recorded beside the value so the choice is visible rather than implied.
	 */
	const FOUNDING_COSTS = [
		[
			'number' => '6LNWF16Y-0007', 'vendor' => 'Anthropic, PBC',
			'description' => 'Claude Max plan - 20x', 'account' => 'software',
			'issued' => '2026-07-04', 'paid' => '2026-07-04',
			'period_start' => '2026-07-04', 'period_end' => '2026-08-04',
			'total' => 28000, 'tax' => 0, 'pay_method' => 'Link',
			'gold_oz_usd' => 4164.15, 'gold_date' => '2026-07-03',
			'usdcad' => 1.4201, 'fx_date' => '2026-07-03',
			'invoice_file' => 'Invoice-6LNWF16Y-0007.pdf', 'receipt_file' => 'Receipt-2463-7753-0921.pdf',
			'note' => 'Paid on a Saturday; priced on the last published fix before it (3 July 2026).',
		],
		[
			'number' => 'DNY6QX8G-0001', 'vendor' => 'Anthropic, PBC',
			'description' => 'Claude Max plan - 20x', 'account' => 'software',
			'issued' => '2026-07-15', 'paid' => '2026-07-15',
			'period_start' => '2026-07-15', 'period_end' => '2026-08-15',
			'total' => 28000, 'tax' => 0, 'pay_method' => 'Visa ending 2178',
			'gold_oz_usd' => 4062.20, 'gold_date' => '2026-07-15',
			'usdcad' => 1.4049, 'fx_date' => '2026-07-15',
			'invoice_file' => 'Invoice-DNY6QX8G-0001.pdf', 'receipt_file' => 'Receipt-2125-3142-1317.pdf',
			'note' => 'A second concurrent subscription. This invoice shows the supplier\'s Turkish VAT registration rather than its Canadian one.',
		],
		[
			'number' => '6LNWF16Y-0008', 'vendor' => 'Anthropic, PBC',
			'description' => 'Claude Max plan - 20x', 'account' => 'software',
			'issued' => '2026-08-11', 'paid' => '2026-08-11',
			'period_start' => '2026-08-11', 'period_end' => '2026-09-11',
			'total' => 28000, 'tax' => 0, 'pay_method' => 'Discover ending 5074',
			'gold_oz_usd' => 4324.45, 'gold_date' => '2026-08-10',
			'usdcad' => 1.3942, 'fx_date' => '2026-08-10',
			'invoice_file' => 'Invoice-6LNWF16Y-0008.pdf', 'receipt_file' => 'Receipt-2803-8483-4716.pdf',
			'note' => 'Booked on the day of payment, before either benchmark had published for 11 August; priced on the 10 August fix.',
		],
	];

	/** The tax position every one of these invoices carries, recorded once rather than three times. */
	const FOUNDING_TAX_NOTE = 'Invoiced at 0% on a reverse-charge basis against CA BN ' . self::BN . '. The Foundation is NOT a GST/HST registrant, so the tax is self-assessed here rather than avoided.';

	/**
	 * GST self-assessed on the founding costs.
	 *
	 * Anthropic is registered under CRA's simplified regime for non-resident digital suppliers and
	 * charged 0% because a Canadian business number was supplied. That relief is for a recipient who
	 * gives a GST/HST REGISTRATION number, and a plain BN with no RT programme account is not one —
	 * the Foundation is not a registrant (operator, 2026-08-12). So the tax was not extinguished, it
	 * moved: a non-registrant acquiring an imported taxable supply of services self-assesses it and
	 * remits on form GST59.
	 *
	 * 5% GST — Alberta has no provincial component, so there is no HST or PST leg. It is NOT
	 * recoverable, because an input tax credit needs a registration the Foundation does not have,
	 * which makes the tax part of the COST of the subscriptions rather than a balance to net off.
	 * Booked as a real liability rather than disclosed as a maybe: the rate is fixed, the base is
	 * three invoices we hold, and a number this determinable does not belong in a footnote.
	 */
	const GST_RATE_PCT   = 5;
	const GST_JURISDICTION = 'Alberta — 5% GST, no provincial component';

	/** The director's user id, or 0. */
	public static function director_uid() {
		$set = (int) get_option( 'aq_books_director_uid', 0 );
		if ( $set > 0 ) { return $set; }
		$u = get_user_by( 'login', self::DIRECTOR_LOGIN );
		return $u ? (int) $u->ID : 0;
	}

	/** The coin buy price for a dated gold/FX pair — Economy::coin_price()'s formula, dated inputs. */
	public static function coin_price_at( $gold_oz_usd, $usdcad ) {
		$spot = ( (float) $gold_oz_usd / self::MG_PER_TROY_OUNCE ) * (float) $usdcad;
		return round( $spot * ( 1 + self::SPREAD_AT_GENESIS ), 4 );
	}

	/**
	 * Record the founding costs and settle them in ArtaCoin. Runs at most once.
	 *
	 * Each cost becomes two balanced entries: the expense against the amount owed to the director,
	 * and then the issue of coin against that same debt. The remainder that will not buy a whole
	 * milligram stays owed — CA$0.36 across the three, which is the honest figure and not worth
	 * rounding into either party's favour.
	 */
	public static function seed_founding_costs() {
		self::ensure_tables();
		if ( get_option( 'aq_books_seeded' ) ) { return 'already seeded'; }
		$uid = self::director_uid();
		if ( $uid < 1 ) { error_log( 'AQ Books: seed refused — cannot resolve the director user' ); return 'refused: no director'; }

		$dir  = dirname( __DIR__ ) . '/data/books/';
		$done = 0;
		foreach ( self::FOUNDING_COSTS as $c ) {
			if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE number = %s', [ $c['number'] ] ) ) { continue; }
			$price = self::coin_price_at( $c['gold_oz_usd'], $c['usdcad'] );
			$id = (int) Data::insert( 'aq_books_invoice', [
				'vendor' => $c['vendor'], 'number' => $c['number'], 'description' => $c['description'],
				'issued' => $c['issued'], 'paid' => $c['paid'],
				'period_start' => $c['period_start'], 'period_end' => $c['period_end'],
				'currency' => self::CURRENCY,
				'subtotal_cents' => $c['total'] - $c['tax'], 'tax_cents' => $c['tax'], 'total_cents' => $c['total'],
				'fx_rate' => 1000000, 'fx_date' => $c['paid'], 'fx_source' => 'no conversion — invoiced in CAD',
				'cad_cents' => $c['total'], 'account' => $c['account'],
				'tax_note' => self::FOUNDING_TAX_NOTE, 'pay_method' => $c['pay_method'], 'payer_uid' => $uid,
				'note' => $c['note'], 'created' => Data::now(),
			] );
			if ( ! $id ) { error_log( 'AQ Books: seed could not insert ' . $c['number'] ); continue; }

			foreach ( [ 'invoice' => $c['invoice_file'], 'receipt' => $c['receipt_file'] ] as $kind => $fname ) {
				$src = $dir . $fname;
				if ( ! is_file( $src ) ) { error_log( 'AQ Books: seed missing evidence file ' . $fname ); continue; }
				$sha = hash_file( 'sha256', $src );
				if ( ! $sha ) { continue; }
				$dest = trailingslashit( self::doc_dir() ) . $sha . '.pdf';
				if ( ! is_file( $dest ) ) { @copy( $src, $dest ); }
				Data::insert( 'aq_books_doc', [
					'invoice_id' => $id, 'kind' => $kind, 'name' => $fname,
					'file_key' => $sha . '.pdf', 'mime' => 'application/pdf',
					'bytes' => (int) filesize( $src ), 'sha256' => $sha,
					'uploaded_by' => $uid, 'created' => Data::now(),
				] );
			}

			$eid = self::journal( 'inv:' . $c['number'], $c['paid'],
				$c['vendor'] . ' — ' . $c['description'], [
					[ 'account' => $c['account'],  'debit'  => $c['total'], 'memo' => $c['number'] . ' · ' . $c['period_start'] . ' to ' . $c['period_end'] ],
					[ 'account' => 'due_director', 'credit' => $c['total'], 'party_uid' => $uid, 'memo' => 'Paid personally — ' . $c['pay_method'] ],
				], 'invoice', $id );
			if ( $eid ) { Data::update( 'aq_books_invoice', [ 'entry_id' => $eid ], [ 'id' => $id ] ); }

			self::settle_in_coin( $uid, $id, $c['total'], [
				'price'       => $price,
				'gold_oz_usd' => $c['gold_oz_usd'],
				'usdcad'      => $c['usdcad'],
				'rate_date'   => $c['gold_date'],
				'source'      => 'LBMA Gold Price PM ' . $c['gold_date'] . ' · Bank of Canada FXUSDCAD ' . $c['fx_date'],
			] );

			$done++;
		}
		// Stamp ONLY when every founding cost is on the books. Stamping unconditionally would freeze
		// a partial seed forever: genesis has already emptied the ledgers by then, so the books would
		// be permanently missing costs with no path back.
		$on_books = (int) Data::col( 'SELECT COUNT(*) FROM ' . Data::t( 'aq_books_invoice' ) );
		if ( $on_books < count( self::FOUNDING_COSTS ) ) {
			error_log( 'AQ Books: seed incomplete (' . $on_books . '/' . count( self::FOUNDING_COSTS ) . ') — NOT recording it as done, so the next request retries' );
			return 'incomplete ' . $on_books . '/' . count( self::FOUNDING_COSTS );
		}
		update_option( 'aq_books_seeded', self::today(), true );
		return 'seeded ' . $done;
	}

	/**
	 * Run the reset and open the books, once, on the first request after deploy.
	 * Wired from aquest.php so it fires through the same pathway production actually runs, rather
	 * than from a function someone remembers to call.
	 */
	public static function bootstrap() {
		self::ensure_tables();
		// Each step carries its OWN presence gate rather than sharing one. A combined gate means a
		// step added later can never run on a site that already passed the earlier ones — which is
		// every site that has already deployed, i.e. the only one that matters.
		if ( ! get_option( 'aq_books_genesis' ) )     { self::genesis(); }
		if ( ! get_option( 'aq_books_seeded' ) )      { self::seed_founding_costs(); }
		if ( ! get_option( 'aq_books_gst_accrued' ) ) { self::accrue_founding_gst(); }
		if ( ! get_option( 'aq_books_taxnote_v2' ) )   { self::refresh_founding_tax_note(); }
		if ( ! get_option( 'aq_books_fy_end' ) )       { self::record_year_end( self::FY_END_DEFAULT, '2026-08-14' ); }
	}

	/**
	 * Persist the fiscal year end as a DECISION rather than leaving it to the constant.
	 *
	 * FY_END_DEFAULT is what the code does in the absence of a choice; it is not a choice. Leaving
	 * the Foundation on it means a later edit to that constant — a refactor, a copied class, someone
	 * tidying — silently moves a year end that CRA treats as fixed once the first T2 is filed. The
	 * operator settled on 31 December on 2026-08-14, so that is written down, with the date it was
	 * taken, and read back in preference to the constant thereafter.
	 *
	 * Refuses a date that would put the first period beyond the 53-week limit, exactly as fy_end_md()
	 * does. Worth knowing that for THIS incorporation date the guard cannot actually fire: any MM-DD
	 * has an occurrence within twelve months of 2026-05-20, and the ceiling is 371 days out, so every
	 * well-formed value is legal. It is kept because it stops being vacuous the moment the
	 * incorporation date changes, and a guard that only matters for someone else's entity is still
	 * worth having in a class this one is likely to be copied from.
	 */
	public static function record_year_end( $md, $on = '' ) {
		$md = (string) $md;
		if ( ! preg_match( '/^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/', $md ) ) { return 'bad format'; }
		$first = self::first_period_end( $md );
		if ( '' === $first || $first > self::max_first_year_end() ) { return 'refused: beyond the 53-week limit'; }
		update_option( 'aq_books_fy_end', $md, true );
		update_option( 'aq_books_fy_end_chosen', ( self::norm_date( $on ) ?: self::today() ), true );
		return 'recorded ' . $md;
	}

	/**
	 * Bring the seeded rows' tax note into step with the constant.
	 *
	 * The note was stored while the tax was still an open question and still sends readers to a
	 * "GST/HST contingency note" that no longer exists under that name. These rows are a PUBLISHED
	 * register, so a dangling cross-reference in them is a defect in the register, not a cosmetic
	 * one. Its own gate, because every site that matters has already run the steps above — a fix
	 * folded into one of them could never reach production.
	 */
	public static function refresh_founding_tax_note() {
		self::ensure_tables();
		$n = 0;
		foreach ( self::FOUNDING_COSTS as $c ) {
			if ( Data::col( 'SELECT 1 FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE number = %s', [ $c['number'] ] ) ) {
				Data::update( 'aq_books_invoice', [ 'tax_note' => self::FOUNDING_TAX_NOTE ], [ 'number' => $c['number'] ] );
				$n++;
			}
		}
		if ( $n < count( self::FOUNDING_COSTS ) ) { return 'incomplete ' . $n; }
		update_option( 'aq_books_taxnote_v2', self::today(), true );
		return 'refreshed ' . $n;
	}

	/**
	 * Accrue the self-assessed GST on the founding costs. Runs once, and separately from the seed
	 * because the seed had already run in production before this was known.
	 *
	 * Source 'tax', NOT 'invoice': the register records what the vendor billed (CA$280 each), the
	 * ledger records what the cost actually was (that plus non-recoverable tax), and
	 * invoices_tie_to_expenses compares the register only against invoice-sourced entries — so both
	 * statements stay true at the same time instead of one of them having to be wrong.
	 */
	public static function accrue_founding_gst() {
		self::ensure_tables();
		$posted = 0;
		foreach ( self::FOUNDING_COSTS as $c ) {
			$inv = Data::one( 'SELECT id, cad_cents, paid FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE number = %s', [ $c['number'] ] );
			if ( ! $inv ) { continue; }
			$gst = (int) round( (int) $inv['cad_cents'] * self::GST_RATE_PCT / 100 );
			if ( $gst < 1 ) { continue; }
			$eid = self::journal( 'gst:' . $c['number'], (string) $inv['paid'],
				'GST self-assessed on ' . $c['number'], [
					[ 'account' => 'software',    'debit'  => $gst, 'memo' => self::GST_RATE_PCT . '% of ' . self::cad( (int) $inv['cad_cents'] ) . ' — not recoverable without a registration' ],
					[ 'account' => 'gst_payable', 'credit' => $gst, 'memo' => 'Owed to CRA on form GST59 · ' . self::GST_JURISDICTION ],
				], 'tax', (int) $inv['id'] );
			if ( $eid ) { $posted++; }
		}
		// Same rule as the seed: only claim it is done when every one of them is on the books.
		if ( $posted < count( self::FOUNDING_COSTS ) ) {
			// One exception, or this retries on every request forever and logs on every one of them:
			// if the period it must post into has been FILED AND LOCKED, no future attempt can
			// succeed either. Stop, and say loudly what is now missing — a backfill that cannot land
			// is an accounting problem for a human, not something to keep quietly grinding at.
			$locked = self::locked_years();
			foreach ( self::FOUNDING_COSTS as $c ) {
				if ( in_array( self::fy_of( $c['paid'] )['label'], $locked, true ) ) {
					update_option( 'aq_books_gst_accrued', 'blocked:' . self::today(), true );
					error_log( 'AQ Books: GST accrual BLOCKED — ' . $c['paid'] . ' falls in a filed, locked period. '
						. $posted . '/' . count( self::FOUNDING_COSTS ) . ' posted. This needs a human: either the tax belongs in an open period, or the filed return needs amending.' );
					return 'blocked';
				}
			}
			error_log( 'AQ Books: GST accrual incomplete (' . $posted . '/' . count( self::FOUNDING_COSTS ) . ') — not recording it as done' );
			return 'incomplete ' . $posted;
		}
		update_option( 'aq_books_gst_accrued', self::today(), true );
		return 'accrued ' . $posted;
	}

	// ── Accrual and the year end ──────────────────────────────────────────────

	/**
	 * The unconsumed part, at a year end, of any subscription whose period straddles it.
	 *
	 * With a 31 December year end and every current subscription period ending by 11 September,
	 * this is nil — but it is computed rather than assumed, because the year end is still the
	 * operator's to choose and moving it earlier would make a real prepaid balance appear. Split
	 * pro rata by days, which is the ordinary treatment for a subscription that is consumed evenly.
	 */
	public static function prepaid_at( $end ) {
		self::ensure_tables();
		$rows = Data::all(
			'SELECT id, number, account, cad_cents, period_start, period_end FROM ' . Data::t( 'aq_books_invoice' )
			. " WHERE period_end > %s AND period_start <= %s AND period_start <> '' AND period_end <> ''",
			[ $end, $end ] );
		$total = 0;
		$parts = [];
		foreach ( $rows as $r ) {
			$s = new \DateTimeImmutable( $r['period_start'], new \DateTimeZone( self::TZ ) );
			$e = new \DateTimeImmutable( $r['period_end'], new \DateTimeZone( self::TZ ) );
			$y = new \DateTimeImmutable( $end, new \DateTimeZone( self::TZ ) );
			$span = (int) $s->diff( $e )->days;
			$left = (int) $y->diff( $e )->days;
			if ( $span < 1 || $left < 1 ) { continue; }
			$cents = (int) round( (int) $r['cad_cents'] * ( $left / $span ) );
			if ( $cents < 1 ) { continue; }
			$total  += $cents;
			$acct    = isset( self::ACCOUNTS[ (string) $r['account'] ] ) ? (string) $r['account'] : 'software';
			$parts[] = [ 'invoice' => $r['number'], 'account' => $acct, 'days_unused' => $left, 'days_total' => $span, 'cents' => $cents ];
		}
		return [ 'cents' => $total, 'parts' => $parts ];
	}

	/**
	 * Post the year-end prepaid adjustment, then freeze the period.
	 *
	 * Freezing matters more than it looks: once a return has been prepared from a period, a later
	 * entry dated into it would silently change a figure that has already been filed. journal()
	 * refuses to post into a locked year, so the filed numbers stay the filed numbers.
	 */
	public static function close_year( $label ) {
		$fy = null;
		foreach ( self::fy_list() as $y ) { if ( $y['label'] === $label ) { $fy = $y; } }
		if ( ! $fy ) { return 'no such period'; }
		if ( in_array( $label, self::locked_years(), true ) ) { return 'already closed'; }
		if ( self::today() <= $fy['end'] ) { return 'period has not ended'; }

		$pre = self::prepaid_at( $fy['end'] );
		if ( $pre['cents'] > 0 ) {
			// Group by the account each cost was actually booked to. Crediting `software` for all of
			// them moved money out of an account that never held it the moment anything other than a
			// subscription straddled a year end — understating one expense line and overstating
			// another, while the totals still footed and hid it.
			$by_account = [];
			$by         = [];
			foreach ( $pre['parts'] as $p ) {
				$by_account[ $p['account'] ] = ( $by_account[ $p['account'] ] ?? 0 ) + (int) $p['cents'];
				$by[] = $p['invoice'] . ' (' . $p['days_unused'] . '/' . $p['days_total'] . ' days)';
			}
			$defer = [ [ 'account' => 'prepaid', 'debit' => $pre['cents'], 'memo' => implode( ', ', $by ) ] ];
			foreach ( $by_account as $acct => $cents ) {
				$defer[] = [ 'account' => $acct, 'credit' => $cents, 'memo' => 'Deferred to the next period' ];
			}
			self::journal( 'prepaid:' . $label, $fy['end'], 'Prepaid subscription time at the year end', $defer, 'closing', 0 );
			// AND RELEASE IT AGAIN on the first day of the new period. A deferral without a reversal
			// is not an accrual, it is a disappearing expense: the cost would leave this year's
			// operations and never arrive in any other, while `prepaid` sat on the balance sheet as
			// an asset the Foundation does not own. Dated into the NEXT period, so the year being
			// locked below still shows the deferral and the new year picks the cost up.
			$next    = ( new \DateTimeImmutable( $fy['end'], new \DateTimeZone( self::TZ ) ) )->modify( '+1 day' )->format( 'Y-m-d' );
			$release = [];
			foreach ( $by_account as $acct => $cents ) {
				$release[] = [ 'account' => $acct, 'debit' => $cents, 'memo' => 'Released from ' . $label ];
			}
			$release[] = [ 'account' => 'prepaid', 'credit' => $pre['cents'], 'memo' => implode( ', ', $by ) ];
			self::journal( 'prepaid-release:' . $label, $next, 'Prepaid subscription time released into the new period', $release, 'closing', 0 );
		}
		$locked = self::locked_years();
		$locked[] = $label;
		update_option( 'aq_books_locked_years', array_values( array_unique( $locked ) ), true );
		return 'closed';
	}

	/**
	 * Bring the coin liability back down as the coins it represents leave circulation.
	 *
	 * The Foundation issued 4,230 ₳ to settle a director's advance and owes whoever holds them. That
	 * obligation does NOT end when a member pays another member — the coins simply change hands — so
	 * it cannot be derecognised on a transfer. It ends when the coins are DESTROYED, which is what a
	 * platform charge does: Economy::credit_coins with a negative delta drops coins_issued, and the
	 * service the member bought is the Foundation's to keep. Booked as revenue for exactly that
	 * reason — the obligation was discharged by supplying something, which is what revenue is.
	 *
	 * Without this the liability only ever grew, and the balance sheet would have gone on reporting
	 * an CA$839.64 obligation after the coins behind it had been spent to nothing.
	 *
	 * Valued at the WEIGHTED AVERAGE price of the issued tranche. The three tranches were struck at
	 * different gold fixes, and picking one of them to unwind against would be arbitrary; the average
	 * is the only choice that returns the liability to exactly zero when the last coin goes.
	 *
	 * At most one adjusting entry per day (the ref carries the date), and it only ever REDUCES: a
	 * rise in circulating supply is other people's coins being minted, not the Foundation's debt
	 * growing.
	 */
	public static function reconcile_coin_liability() {
		self::ensure_tables();
		if ( ! class_exists( '\\AQ\\Economy' ) ) { return 0; }
		$booked_coins = (int) Data::col( 'SELECT COALESCE(SUM(coins),0) FROM ' . Data::t( 'aq_books_invoice' ) );
		if ( $booked_coins < 1 ) { return 0; }

		$mv           = self::movement();
		$booked_value = (int) ( $mv['coin_liability'] ?? 0 );
		if ( $booked_value < 1 ) { return 0; }

		// The unit price must come from what was ORIGINALLY issued, never from the current balance.
		// Dividing the already-reduced liability by the full coin count re-derives a cheaper coin
		// every time, so the balance halves again on the next run and the one after — it converges
		// on zero whether or not another coin is ever spent. The issued value is a fact about the
		// invoice rows and does not move.
		$issued_coins = 0;
		$issued_value = 0;
		foreach ( Data::all( 'SELECT coins, coin_price_1e6 FROM ' . Data::t( 'aq_books_invoice' ) . ' WHERE coins > 0' ) as $r ) {
			$c = (int) $r['coins'];
			$issued_coins += $c;
			$issued_value += (int) round( $c * ( (int) $r['coin_price_1e6'] / 1000000 ) * 100 );
		}
		if ( $issued_coins < 1 || $issued_value < 1 ) { return 0; }

		// Only OUR tranche can be outstanding, so cap by it: coins beyond it were minted elsewhere.
		$outstanding = min( $issued_coins, max( 0, (int) Economy::counter( 'coins_issued' ) ) );
		$target      = (int) round( $outstanding * $issued_value / $issued_coins );
		$release     = $booked_value - $target;
		if ( $release < 1 ) { return 0; }

		// WHY THE COINS LEFT decides where the credit goes, and the two are not the same event.
		// A coin spent on a platform service discharges the obligation by SUPPLYING something — that
		// is revenue. A coin CASHED OUT discharges it by paying real money out — that is cash
		// leaving, and booking it as revenue would report a payout as income. The coin ledger
		// separates them: 'sell' (cash-out) and 'refund' (a reversed purchase) are the only reasons
		// that also release gold backing; every other negative delta is a service burn.
		$redeemed_coins = (int) Data::col(
			'SELECT COALESCE(SUM(-delta),0) FROM ' . Data::t( 'aq_coin_ledger' )
			. " WHERE delta < 0 AND reason IN ('sell','refund')" );
		$gone           = max( 0, $issued_coins - $outstanding );
		$redeemed_coins = max( 0, min( $redeemed_coins, $gone ) );
		$unit           = $issued_value / $issued_coins;
		$redeemed_value = min( $release, (int) round( $redeemed_coins * $unit ) );
		$service_value  = $release - $redeemed_value;

		$lines = [ [ 'account' => 'coin_liability', 'debit' => $release, 'memo' => $gone . ' ₳ no longer in circulation' ] ];
		if ( $service_value > 0 ) {
			$lines[] = [ 'account' => 'activity_revenue', 'credit' => $service_value, 'memo' => 'Obligation discharged by supplying the service' ];
		}
		if ( $redeemed_value > 0 ) {
			$lines[] = [ 'account' => 'cash', 'credit' => $redeemed_value, 'memo' => $redeemed_coins . ' ₳ cashed out — money paid to the holder' ];
		}
		return self::journal( 'coinspent:' . self::today(), self::today(), 'ArtaCoin leaving circulation', $lines, 'coin', 0 );
	}

	/**
	 * Freeze the filing package for a closed period: render it, store it beside the invoice evidence,
	 * and record the hash. Idempotent — the same period archives once, and because the generation
	 * date is pinned to the archive date the bytes (and therefore the hash) never move afterwards.
	 */
	public static function archive_return( $fy_label, $on = '' ) {
		self::ensure_tables();
		$on = self::norm_date( $on ) ?: self::today();
		$have = Data::one(
			'SELECT id, sha256 FROM ' . Data::t( 'aq_books_doc' ) . ' WHERE kind = %s AND name = %s',
			[ 'return', $fy_label . '-filing-package.pdf' ] );
		if ( $have ) { return (int) $have['id']; }

		$bytes = self::return_pdf( $fy_label, $on );
		if ( strlen( $bytes ) < 1000 ) { error_log( 'AQ Books: refusing to archive a suspiciously small package for ' . $fy_label ); return 0; }
		$sha  = hash( 'sha256', $bytes );
		$dest = trailingslashit( self::doc_dir() ) . $sha . '.pdf';
		if ( ! is_file( $dest ) && false === @file_put_contents( $dest, $bytes ) ) {
			error_log( 'AQ Books: could not write the archived package for ' . $fy_label );
			return 0;
		}
		@chmod( $dest, 0644 );
		return (int) Data::insert( 'aq_books_doc', [
			'invoice_id' => 0, 'kind' => 'return', 'name' => $fy_label . '-filing-package.pdf',
			'file_key' => $sha . '.pdf', 'mime' => 'application/pdf', 'bytes' => strlen( $bytes ),
			'sha256' => $sha, 'uploaded_by' => 0, 'created' => Data::now(),
		] );
	}

	/**
	 * Tell the operator a return is coming due, and keep telling them as it gets closer.
	 *
	 * A deadline nobody is reminded of is a penalty with a date on it. Fires once per threshold per
	 * period — the option records which have gone out, so a daily cron does not send ninety emails.
	 */
	public static function deadline_tick() {
		self::ensure_tables();
		if ( ! class_exists( '\\AQ\\Watchdog' ) ) { return; }
		$sent = get_option( 'aq_books_deadline_sent', [] );
		if ( ! is_array( $sent ) ) { $sent = []; }
		$today = new \DateTimeImmutable( self::today(), new \DateTimeZone( self::TZ ) );
		foreach ( self::fy_list() as $fy ) {
			if ( self::today() <= $fy['end'] ) { continue; }
			if ( in_array( $fy['label'] . ':filed', $sent, true ) ) { continue; }
			$due  = self::filing_due( $fy['end'] );
			$days = (int) $today->diff( new \DateTimeImmutable( $due, new \DateTimeZone( self::TZ ) ) )->format( '%r%a' );
			foreach ( [ 120, 60, 30, 7, 0 ] as $mark ) {
				$key = $fy['label'] . ':' . $mark;
				if ( $days > $mark || in_array( $key, $sent, true ) ) { continue; }
				$sent[] = $key;
				update_option( 'aq_books_deadline_sent', $sent, true );
				Watchdog::alert( 'books_due_' . $key,
					$days < 0
						? 'T2 for ' . $fy['label'] . ' is OVERDUE by ' . abs( $days ) . ' days'
						: 'T2 for ' . $fy['label'] . ' is due in ' . $days . ' days (' . $due . ')',
					"The filing package is generated and frozen: https://artaquest.com/wp-json/aq/v1/foundation/cra/pdf?fy=" . $fy['label'] . "\n"
					. "The figures behind it: https://artaquest.com/finances\n\n"
					. 'A T2 is required for every tax year even with no tax payable. Nothing here has been submitted — '
					. 'the package is prepared for a human to review and file.',
					$days <= 7 );
				break;
			}
		}
	}

	/**
	 * Daily cron aq_books_year_end: publish the return package once a period has ended.
	 *
	 * "Publish" here means compute, freeze and expose — the package at /foundation/cra is generated
	 * from the frozen ledger, so it is reproducible by anyone rather than a document only we hold.
	 * It does NOT file anything with CRA, and it deliberately does not prepare a T1044 unless a
	 * threshold is actually met.
	 */
	public static function year_end_tick() {
		self::ensure_tables();
		self::reconcile_coin_liability();
		self::deadline_tick();
		foreach ( self::fy_list() as $fy ) {
			if ( self::today() <= $fy['end'] ) { continue; }
			if ( in_array( $fy['label'], self::locked_years(), true ) ) { continue; }
			self::close_year( $fy['label'] );
			$pub = get_option( 'aq_books_published', [] );
			if ( ! is_array( $pub ) ) { $pub = []; }
			$pub[ $fy['label'] ] = self::today();
			update_option( 'aq_books_published', $pub, true );
			self::archive_return( $fy['label'], self::today() );
			if ( class_exists( '\\AQ\\Watchdog' ) ) {
				Watchdog::note( 'Books: ' . $fy['label'] . ' is closed and its CRA package is published at /foundation/cra?fy=' . $fy['label']
					. ' — the T2 is due ' . self::filing_due( $fy['end'] ) . '.' );
			}
		}
	}
}
