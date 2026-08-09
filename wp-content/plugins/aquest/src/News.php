<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * ArtaNews — automated objective-data journalism (operator order 2026-07-25:
 * "objective data driven news only, reliable and citable and SEO optimized … a robust realtime
 * explosion or fire detector from satellite data … an automated ArtaNews page that reports
 * SEO-optimized and citable pages of what is detected and what it could likely be, a scientific
 * report … fully automated pipeline of detection and reporting and publication").
 *
 * THE CONTRACT — what makes this journalism instead of a feed:
 *   1. Every story starts as a NUMBER crossing a threshold in a public instrument feed. No
 *      editorial selection, no aggregation of other outlets' opinions, nothing a human chose.
 *   2. The report states MEASURED facts (sensor, UTC timestamp, coordinates, radiative power,
 *      magnitude, sigma) separately from INFERENCE ("consistent with…"), and never asserts a cause.
 *      A satellite sees radiant heat; it does not see an explosion. The prose must survive that
 *      distinction or the platform is publishing fiction.
 *   3. Every page carries its provenance — instrument, product, query, retrieval time — so any
 *      reader can re-run the query and reproduce the claim. That is what "citable" means here.
 *
 * THE PIPELINE (all off the request path, each stage its own cron):
 *   detect  → poll each source, threshold, cluster, dedupe → aq_news_events
 *   report  → the relay writes the scientific report from the event's OWN numbers → aq_news_articles
 *   serve   → GET news/… ; the theme renders the page + NewsArticle JSON-LD for search engines
 *
 * ══ THE TWO-TIER RULE (operator 2026-07-25: "detection signals all instruments focused, then
 * during research you could rely on human reporting") ══
 *
 * TIER 1 — DETECTION: INSTRUMENTS ONLY. A story may be created ONLY by a physical measurement
 * crossing a threshold: a radiometer, a seismometer, the global routing table, a settlement price.
 * No wire service, no social post, no conflict database, no press release can bring a story into
 * existence here. This is the platform's guarantee against amplifying a rumour, a propaganda claim
 * or a fabrication: if no instrument saw it, ArtaQuest does not report it. It also means the
 * platform cannot be manipulated by flooding the information space — you cannot fake a seismometer.
 *
 * TIER 2 — RESEARCH: HUMAN REPORTING PERMITTED, ONLY AS CONTEXT. Once an instrument has established
 * that something physically happened, human sources (wire copy, humanitarian situation reports,
 * official statements) may be consulted to say what is KNOWN about that location or event — and
 * they are always attributed and labelled as reported-by-humans, never merged into the measured
 * record. Research can never promote itself into a detection: it cannot start a story, raise a
 * confidence tier, or supply a number that the instruments did not measure.
 *
 * Concretely: GDELT, ACLED, ReliefWeb, IAEA statements and news wires are RESEARCH sources and are
 * barred from the DETECTORS registry below. FIRMS, USGS, EMSC, IODA, RIPEstat and market settlement
 * prices are DETECTION sources. The registry is the enforcement point — if it is not an instrument,
 * it does not belong in it.
 *
 * SOURCE OF RECORD: github.com/ArtaQuest/artanews — the engine, its contract, and the evidence
 * behind every threshold in this file (the summed-power error, the nine-fold energy bracket,
 * the 14% radiative fraction, the Middle East blindness, the 82-83% flare contamination
 * measured against MODIS). This copy and that repo can DRIFT: there is no automated check
 * yet, so sync deliberately when either changes, and treat the repo as the explanation.
 *
 * DETECTOR CONTRACT — a new monitor is one method returning a list of candidate events:
 *   [ 'ekey' => stable id, 'ts' => unix, 'lat','lon' => floats|null, 'severity' => float,
 *     'confidence' => high|medium|low, 'kind' => short noun, 'measures' => [ label => value ],
 *     'source' => [ 'name','url','retrieved' ] ]
 * …registered in DETECTORS. Everything else (geocoding, dedupe, headline, storage, publication,
 * SEO) is handled once, here.
 */
final class News {

	/** DETECTION registry — INSTRUMENTS ONLY (see the two-tier rule above). Every entry must be a
	 *  physical measurement: radiometry, seismology, network reachability, or a settled market
	 *  price. Human-reported sources belong in RESEARCH, never here. */
	// ORDER IS LOAD-BEARING: seismic runs FIRST so the thermal detector's corroboration lookup
	// (seismic_near) can see THIS tick's blasts, not the previous tick's. Heat + ground motion at
	// the same place and minute is the strongest signature the platform can measure.
	const DETECTORS = [
		'quake'   => [ 'label' => 'Seismic event',             'fn' => 'detect_quake', 'svg' => 'seismic_svg' ],
		'thermal' => [ 'label' => 'Satellite thermal anomaly', 'fn' => 'detect_thermal', 'svg' => 'extent_svg' ],
		'netloss' => [ 'label' => 'Internet connectivity loss', 'fn' => 'detect_netloss', 'svg' => '' ], // no figure yet — see detection_svg()
		'blackout' => [ 'label' => 'National traffic collapse',  'fn' => 'detect_blackout', 'svg' => '' ], // no figure yet — see detection_svg()
		'price'   => [ 'label' => 'Commodity price move',      'fn' => 'detect_price', 'svg' => '' ], // no figure yet — see detection_svg()
		'claude'  => [ 'label' => 'Claude service disruption', 'fn' => 'detect_claude', 'svg' => '' ], // no figure yet — see detection_svg()
	];

	/**
	 * THE ONE ADMITTED EXCEPTION TO "INSTRUMENTS ONLY", stated openly rather than smuggled in.
	 *
	 * Every other detector reads an instrument that is INDEPENDENT of whatever it measures: a
	 * seismometer does not work for the earthquake, and the global routing table does not work for
	 * the government that switched the internet off. A vendor status page is different — the party
	 * being measured is also the party doing the measuring, which is exactly the arrangement the
	 * two-tier rule exists to keep out.
	 *
	 * It is admitted here for one specific reason: a service outage has no adversarial incentive. A
	 * state may wish to hide a blackout and an army may wish to deny a strike, but a cloud provider
	 * gains nothing by inventing its own downtime, and its status page is machine-generated from its
	 * own monitoring rather than written by a press office. The failure mode is UNDER-reporting, not
	 * fabrication — and under-reporting costs us a story we never had, while fabrication would cost
	 * the platform its guarantee.
	 *
	 * Two rules keep it honest. We read the STRUCTURED endpoint (component status enums and incident
	 * impact enums), never the human-written incident prose, so nothing a press office phrases can
	 * change what we record. And the reading is labelled 'operator-reported' in its confidence, so it
	 * can never be mistaken on the page for something we measured ourselves.
	 */
	const CLAUDE_STATUS_URL = 'https://status.anthropic.com/api/v2/summary.json';
	/** Statuspage component enums → a severity on the same 0-100 scale the connectivity detectors use. */
	const CLAUDE_SEVERITY = [
		'major_outage'         => 100.0,
		'partial_outage'       => 60.0,
		'degraded_performance' => 30.0,
	];
	/** Incident impact enums → severity, used when an incident is open without a degraded component. */
	const CLAUDE_IMPACT = [ 'critical' => 100.0, 'major' => 70.0, 'minor' => 30.0 ];
	const CLAUDE_MIN_SEVERITY = 30.0;   // degraded performance is the floor — 'operational' is not news

	// ── conflict-sensitive monitoring (operator 2026-07-25: "every public available signal
	// worldwide, especially Iran, that could be affected by war") ─────────────────────────────
	// War does not announce itself in a feed — it shows up as PHYSICS: infrastructure radiating
	// heat, ground shaking from munitions, a country's routes vanishing from the global routing
	// table, energy repricing supply risk. Each instrument below is public, keyless and scientific,
	// and each is reported for WHAT IT MEASURED. The platform never names a perpetrator: a
	// satellite sees radiant heat, a seismometer sees ground motion, BGP sees withdrawn prefixes.
	// Attribution is precisely where automated conflict reporting does real harm, so it is barred
	// by construction, not by editorial restraint.
	//
	// WATCHLIST — regions monitored with a lower trigger, because a signal there carries more
	// information. Iran first, per the operator. This does NOT bias what is true; it decides how
	// much evidence is needed before a measurement is worth a page.
	const WATCH = [
		'IR' => 'Iran', 'IL' => 'Israel', 'PS' => 'Palestine', 'LB' => 'Lebanon', 'SY' => 'Syria',
		'IQ' => 'Iraq', 'YE' => 'Yemen', 'UA' => 'Ukraine', 'RU' => 'Russia', 'SD' => 'Sudan',
		'MM' => 'Myanmar', 'PK' => 'Pakistan', 'AF' => 'Afghanistan', 'LY' => 'Libya', 'ML' => 'Mali',
	];

	// Rough boxes for the watched conflict regions. Used ONLY to decide which FRP floor a pixel is
	// tested against — never to label anything. The exact country still comes from the geocoder at
	// ingest, so a generous box costs at most a closer look, never a wrong dateline.
	// [ minlat, maxlat, minlon, maxlon ]
	const WATCH_BOX = [
		[ 25.0, 40.0, 44.0, 63.5 ],  // Iran
		[ 29.4, 33.4, 34.2, 35.9 ],  // Israel / Palestine
		[ 33.0, 34.7, 35.1, 36.6 ],  // Lebanon
		[ 32.3, 37.3, 35.7, 42.4 ],  // Syria
		[ 29.0, 37.4, 38.8, 48.6 ],  // Iraq
		[ 12.1, 19.0, 42.3, 54.5 ],  // Yemen
		[ 44.4, 52.4, 22.1, 40.2 ],  // Ukraine
		[  8.7, 22.2, 21.8, 38.6 ],  // Sudan
		[  9.5, 37.5, 60.5, 75.2 ],  // Afghanistan / Pakistan
		[ 19.5, 33.2,  9.3, 25.2 ],  // Libya
		[  9.9, 25.1, -12.3, 4.3 ],  // Mali
		[  9.5, 28.6, 92.2, 101.2 ], // Myanmar
	];

	// ── the flagship: satellite fire / explosion detection ────────────────────────────────────
	// SOURCE: NASA FIRMS VIIRS S-NPP 375 m active-fire product, global 24 h CSV. Keyless (the
	// /api/ routes need a MAP_KEY; this bulk file does not — verified 2026-07-25, 8.9 MB).
	// Columns: latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,
	// version,bright_ti5,frp,daynight. `frp` is Fire Radiative Power in megawatts — the physical
	// quantity that separates a bonfire from a refinery blast.
	//
	// WHAT THE INSTRUMENT ACTUALLY PROVES: a 375 m pixel radiated more heat than its neighbours at
	// a given instant. It does NOT prove combustion type, cause, or casualties. Everything below is
	// a discriminator over that one measurement plus its history, and the wording downstream is
	// bounded accordingly.
	//
	// DISCRIMINATION (why this is not just "a fire happened"):
	//   · GAS FLARES + steel mills + power plants recur at the SAME pixel almost nightly. We keep a
	//     persistence census (aq_news_cells): any cell seen on ≥ PERSIST_DAYS distinct days is a
	//     known industrial heat source and is never news. This is the single biggest false-positive
	//     killer and it improves by itself the longer the platform runs.
	//   · WILDFIRES are large, spreading, multi-overpass clusters, usually in vegetation away from
	//     towns. Large area + growth over days ⇒ classified 'wildfire', reported as such.
	//   · A SUDDEN, COMPACT, VERY HIGH-FRP anomaly with no history at that location, close to a
	//     populated place, is what the operator means by "explosion". We report it as a
	//     high-intensity thermal anomaly and say plainly what that is consistent with.
	// TWO polar orbiters, not one. A strike burns for minutes to an hour; one satellite gives ~2
	// overpasses a day, so a brief fire is missed more often than caught. NOAA-20 carries the same
	// VIIRS instrument and its bulk CSV is equally keyless. (Phasing note: NOAA-20 has flown a
	// half-orbit from NOAA-21 since April 2024, with S-NPP a quarter-orbit between them — the old
	// "~50 minutes from S-NPP" figure is out of date. Mid-latitudes get 3-4 looks a day, NASA FIRMS FAQ.)
	// (verified 2026-07-26: HTTP 200, 95,425 rows, identical columns). Together they roughly double
	// the temporal coverage, which is the single biggest sensitivity gain available for free.
	const FIRMS_FEEDS = [
		[ 'S-NPP',   'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv' ],
		[ 'NOAA-20', 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv' ],
	];
	const FIRMS_URL     = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv';
	const PRICE_MIN_OBS = 18;     // monthly observations needed before a sigma means anything
	const PRICE_WINDOW  = 120;    // 10 y of months — recent regime, not sixty years of it
	const PRICE_SIGMA   = 4.0;    // how far past its own normal a move must sit to be news
	const REVISE_PCT    = 0.25;   // a published page is re-issued when its measurement moves this much
	const DRIFT_KM      = 25.0;   // same detector, this close, this recent ⇒ the same ongoing event
	// BLAST FILTERING IS GEOGRAPHIC, NOT A MAGNITUDE FLOOR — measured against the live catalogue.
	// All 207 blasts USGS classified in the past month were NORTH AMERICAN (California, Oklahoma,
	// Washington, Canada), with the top sites recurring 9–14 times each: routine industry, not news.
	// ZERO were in any WATCH country. So a flat magnitude floor is the wrong instrument — at M2.5 it
	// passed 1/month (feature dead), and at M1.5 it passed 42/month of Oklahoma quarry work dressed
	// as conflict reporting. Inside a watched country there is NO floor, because a small blast in
	// Iran or Ukraine IS the signal; everywhere else only a genuinely large explosion qualifies.
	//
	// HONEST LIMITATION: this leg will usually produce nothing, and that is the correct output —
	// USGS blast CLASSIFICATION is dominated by North American regional networks, so it carries very
	// little conflict-zone coverage. It is a high-value, low-volume path, not a steady feed.
	const BLAST_MIN_MAG = 4.0;    // outside the watchlist only a large explosion is news
	// AN EARTHQUAKE FLOOR AND AN EXPLOSION FLOOR ARE NOT THE SAME NUMBER, and for a long time one
	// constant answered both questions. `BLAST_MIN_MAG` is named for what it is: the bar a
	// CLASSIFIED explosion must clear, and M4.0 is enormous for one (every blast in the live USGS
	// catalogue over a week was M0.18–M1.77). Applied to ordinary earthquakes the same 4.0 means
	// something entirely different — roughly 130 a day worldwide, which is weather, not news.
	// Both detector legs therefore carried a hard-coded 5.5 for earthquakes while newsworthy()
	// tested against BLAST_MIN_MAG, so the two disagreed by 1.5 magnitudes and the gate's quake
	// branch was unreachable below 5.5. Naming the second floor is what stops them drifting again.
	const QUAKE_MIN_MAG = 5.5;    // an ORDINARY earthquake is news at this size, worldwide
	const ISOLATION_KM  = 25.0;   // no other cluster within this range ⇒ genuinely isolated
	const MAX_HOT       = 6000;   // hot pixels clustered per tick — O(n²) guard on a severe fire day
	const CENSUS_TTL    = 15552000; // 180 d — a cell unseen for a season stops being evidence
	const ENERGY_MAX_GAP = 43200; // 12 h — a longer gap between sightings is not interpolable
	const TI4_SAT       = 367.0;  // band I-4 saturation — at/above this the reading is a floor
	// THE DETECTOR WAS STRUCTURALLY BLIND TO THE MIDDLE EAST. Measured on the live global file
	// 2026-07-26: 1,898 pixels fell inside the watched conflict boxes and NOT ONE reached 80 MW —
	// Iran's hottest pixel was 60.7 MW, Iraq's 79.2. An 80 MW floor is calibrated for WILDFIRE
	// energy (hundreds to thousands of MW); a burning building, vehicle or fuel store after a
	// strike radiates 5–50 MW. So every story the platform produced was a North American or
	// African wildfire, by construction, no matter what was happening in a conflict zone.
	//
	// Inside a watched box the floor drops to 15 MW: measured, that is 81 pixels → 33 clusters a
	// day across all eight regions — a workable volume. It is ONLY a sensitivity change: the
	// persistence census (essential here — Iran and Iraq are full of gas flares, which is exactly
	// why they carry 890 and 643 pixels), the isolation test and the no-history test all still
	// apply, and nothing about how an event is WORDED changes.
	const PIXEL_KEEP      = 1.0;  // MW — per-pixel noise floor ONLY; never a reported-quantity term
	const FRP_MIN_WATCH   = 15.0; // MW inside a watched conflict box — building/vehicle scale
	const FRP_STRONG_WATCH = 50.0; // MW — the high-intensity tier, at conflict-zone scale
	const FRP_MIN       = 80.0;   // MW — a candidate must out-radiate ordinary agricultural burning
	const FRP_STRONG    = 400.0;  // MW — cluster total at/above this is a major-energy release
	const CLUSTER_KM    = 1.5;    // pixels within this radius are one event (VIIRS pixel ≈ 375 m)
	// COUNTED IN ACQUISITION DATES, NOT CALENDAR DAYS. The 24 h FIRMS file spans two UTC dates, so
	// one tick can add two to a cell that burned across midnight. Keying the census on each pixel's
	// own acq_date fixed a real double-count, but it also halved what this threshold MEANT: at 3 it
	// was suppressing after ~1.5 calendar days, which is a wildfire's second morning, not a flare.
	// 6 acquisition dates restores the original ~3-calendar-day intent.
	const PERSIST_DAYS  = 6;      // distinct ACQ dates before a cell counts as chronic industrial heat
	const MAX_EVENTS    = 12;     // published events per detector per tick — a hard flood stop
	// `severity` is always the MEASURED quantity and is what a page renders. Queue ordering uses
	// `rank` — a separate field that is never shown. They were once the same field, and a blast's
	// ranking floor (max(6.0,·)) got printed as its magnitude: a M2.6 quarry blast published as
	// "M6.0 earthquake". A number shown to a reader may never double as a sort key.
	const NEAR_KM       = 20.0;   // within this the town IS the locality
	const BEARING_KM    = 60.0;   // beyond this the town is noise — name the country instead
	const REPORT_BATCH  = 3;      // reports written per tick — bounds relay wait AND the publication rate

	/** The 6-hourly detection tick (cron aq_news_detect, via Cron::guard). */
	public static function detect_tick() {
		foreach ( self::DETECTORS as $key => $d ) {
			try {
				$t0   = microtime( true );
				$rows = call_user_func( [ __CLASS__, $d['fn'] ] );
				Extra::src_health( 'news:' . $key, (bool) $rows, ( microtime( true ) - $t0 ) * 1000, count( (array) $rows ) );
				self::ingest( $key, (array) $rows );
			} catch ( \Throwable $e ) {
				Extra::src_health( 'news:' . $key, false, 0, 0, $e->getMessage() );
			}
		}
	}

	/** Candidate events → aq_news_events (new rows, or an update to a live one). */
	private static function ingest( $detector, $rows ) {
		if ( ! $rows ) { return; }
		// GEOCODE BEFORE RANKING AND TRUNCATION. The watchlist bonus depends on the country, and the
		// country is only known after geocoding — so applying it AFTER the MAX_EVENTS slice let it
		// reorder the survivors while having no say in who survived. Watched-region events are
		// low-FRP by nature (15–320 MW) and wildfires run 700–1,200 MW, so every slot went to a
		// wildfire and the conflict-zone events were discarded before the bonus could count. That is
		// exactly backwards, and it silently reverted the Middle East coverage a tick earlier.
		foreach ( $rows as $i => $r ) {
			$place = [ 'place' => '', 'country' => '', 'km' => 0.0 ];
			if ( isset( $r['lat'], $r['lon'] ) && null !== $r['lat'] ) {
				$place = self::nearest_place( (float) $r['lat'], (float) $r['lon'] );
			} elseif ( ! empty( $r['place'] ) || ! empty( $r['country'] ) ) {
				$place = [ 'place' => (string) ( $r['place'] ?? '' ), 'country' => (string) ( $r['country'] ?? '' ), 'km' => 0.0 ];
			}
			$rows[ $i ]['_place'] = $place;
			$rows[ $i ]['_rank']  = (float) ( $r['rank'] ?? $r['severity'] ?? 0 )
				+ ( in_array( $place['country'], self::WATCH, true ) ? self::WATCH_RANK_BONUS : 0 );
		}
		usort( $rows, static fn( $a, $b ) => $b['_rank'] <=> $a['_rank'] );
		$rows = array_slice( $rows, 0, self::MAX_EVENTS );
		foreach ( $rows as $r ) {
			$ekey = $detector . ':' . (string) ( $r['ekey'] ?? '' );
			if ( ':' === substr( $ekey, -1 ) ) { continue; }
			$place = $r['_place'];
			$head  = self::headline( $detector, $r, $place );
			$have  = Data::one( 'SELECT id, revisions, status, severity FROM ' . Data::t( 'aq_news_events' ) . ' WHERE ekey = %s', [ $ekey ] );
			// A fire's FRP-weighted centroid moves as the fire moves, so a key derived from it is NOT a
			// stable identity: one fire drifting across a 0.01° boundary minted a second page for a story
			// already published. Fall back to PROXIMITY — a live event of the same kind, close in space
			// and recent in time, is the same event whatever its centroid happened to round to.
			if ( ! $have && isset( $r['lat'], $r['lon'] ) && null !== $r['lat'] && ( $r['lat'] || $r['lon'] ) ) {
				$have = self::live_near( $detector, (float) $r['lat'], (float) $r['lon'], (int) ( $r['ts'] ?? time() ) );
			}
			$data = [
				'last_ts'    => (int) ( $r['ts'] ?? time() ),
				'lat'        => isset( $r['lat'] ) ? (float) $r['lat'] : 0,
				'lon'        => isset( $r['lon'] ) ? (float) $r['lon'] : 0,
				'place'      => $place['place'],
				'country'    => $place['country'],
				'place_km'   => (float) ( $place['km'] ?? 0 ),
				'headline'   => $head,
				'severity'   => (float) ( $r['severity'] ?? 0 ),
				'energy_mj'     => (float) ( $r['energy'][1] ?? 0 ),   // the MID estimate; the bracket is in measures
				'pixels'        => wp_json_encode( array_slice( (array) ( $r['px'] ?? [] ), 0, 4000 ) ),
				'energy_span_s' => (int) ( $r['energy'][3] ?? 0 ),
				'rank_score' => (float) $r['_rank'],
				'confidence' => (string) ( $r['confidence'] ?? 'medium' ),
				'measures'   => wp_json_encode( [ 'kind' => $r['kind'] ?? '', 'measures' => $r['measures'] ?? [], 'source' => $r['source'] ?? [] ] ),
			];
			if ( $have ) {
				// The same fire/quake seen again: refresh its numbers, never publish a second page. If it has
				// ALREADY been published and the measurement has moved materially, flag it for RE-reporting —
				// otherwise the live event drifts away from the frozen page and the page quietly becomes wrong.
				$data['revisions'] = (int) $have['revisions'] + 1;
				$was   = (float) ( $have['severity'] ?? 0 );
				$isnow = (float) ( $r['severity'] ?? 0 );
				$moved = $was > 0 && ( abs( $isnow - $was ) / $was ) > self::REVISE_PCT;
				if ( 'published' === (string) ( $have['status'] ?? '' ) && $moved ) { $data['status'] = 'revised'; }
				Data::update( 'aq_news_events', $data, [ 'id' => (int) $have['id'] ] );
			} else {
				Data::insert( 'aq_news_events', $data + [
					'detector' => $detector, 'ekey' => $ekey, 'first_ts' => (int) ( $r['ts'] ?? time() ),
					'status' => 'new', 'created' => Data::now(),
				] );
			}
		}
	}

	// ── reporting + publication ───────────────────────────────────────────────────────────────

	/**
	 * The reporting tick (cron aq_news_report): take the most significant unreported events and
	 * write each one a scientific report. The relay is asked to explain ONLY the numbers it is
	 * handed — it is given no freedom to introduce a fact, a cause, or a casualty.
	 *
	 * NOTHING HERE PUBLISHES (operator 2026-07-27: "instead of auto publish, send confirmation
	 * email to author, just like any other publication. nothing gets published automatically").
	 * Every row is written as 'pending' and waits for the author's emailed yes. ArtaNews had been
	 * the ONE surface on this platform that published itself, which contradicted the rule every
	 * other surface obeys — the author's inbox is the mint. A detector may WRITE a story; only a
	 * human can publish one.
	 *
	 * This also retires a problem I could not otherwise solve: unscheduling the cron was never a
	 * durable pause, because the plugin re-registers its crons on every load, so any deploy by any
	 * agent silently re-armed publication. Now it does not matter how often the cron runs — it has
	 * no power to publish. The gate is in the code, not in the schedule.
	 */
	public static function report_tick() {
		$rows = Data::all(
			'SELECT * FROM ' . Data::t( 'aq_news_events' ) . " WHERE status IN ('new','revised') ORDER BY rank_score DESC LIMIT %d",
			[ self::REPORT_BATCH ]
		);
		$minted = []; // raw secrets exist ONLY in this local, only for this call
		foreach ( $rows as $ev ) {
			try {
				// The measured report is DETERMINISTIC PHP and always produces text. The relay only adds
				// an optional, labelled context block — a busy or dead relay must never be able to
				// suppress a story about a measurement that actually happened.
				$art = self::write_report( $ev );
				if ( ! $art ) { $art = self::measured_report( $ev ); }
				if ( ! $art ) { continue; }
				$slug = self::slug( $ev );
				$now  = time();
				// A revision REPLACES the story in place — same slug, same URL, incremented revision — so a
				// correction is visible rather than becoming a second, contradictory page. It NEVER changes
				// status: an already-published story stays published (the author said yes to it), a pending
				// one stays pending. This path cannot promote anything.
				$prev = Data::one( 'SELECT id, revision FROM ' . Data::t( 'aq_news_articles' ) . ' WHERE event_id = %d', [ (int) $ev['id'] ] );
				if ( $prev ) {
					Data::update( 'aq_news_articles', [
						'title'    => (string) $ev['headline'], 'summary' => $art['summary'], 'body' => $art['body'],
						'sources'  => wp_json_encode( $art['sources'] ),
						'revision' => (int) $prev['revision'] + 1, 'updated' => $now,
					], [ 'id' => (int) $prev['id'] ] );
					Data::update( 'aq_news_events', [ 'status' => 'reported' ], [ 'id' => (int) $ev['id'] ] );
					continue;
				}
				// The single-use secret is minted INLINE. The RAW goes into the author's email and nowhere
				// else — not the DB (which is PUBLIC), not a log, not a return value. Only sha256(raw|slug)
				// is stored, so nothing on this server can reconstruct a working link after the send.
				$raw = bin2hex( random_bytes( 20 ) );
				$aid = Data::insert( 'aq_news_articles', [
					'event_id' => (int) $ev['id'], 'slug' => $slug,
					'title'    => (string) $ev['headline'],
					'summary'  => $art['summary'], 'body' => $art['body'],
					'sources'  => wp_json_encode( $art['sources'] ),
					'revision' => 1, 'status' => 'pending',   // ← the whole point: pending, never published
					'published' => 0, 'updated' => $now, 'created' => $now,
					'author_token' => hash( 'sha256', $raw . '|' . $slug ),
				] );
				// Only advance the event if the article row really exists. Marking on a failed insert (a
				// slug collision, say) destroyed the story permanently and silently — never retried.
				if ( ! $aid ) { continue; }
				// 'reported' — a story now EXISTS and is waiting on the author. It is NOT public.
				Data::update( 'aq_news_events', [ 'status' => 'reported' ], [ 'id' => (int) $ev['id'] ] );
				$minted[] = [ 'slug' => $slug, 'title' => (string) $ev['headline'], 'raw' => $raw,
					'summary' => (string) $art['summary'] ];
			} catch ( \Throwable $e ) { /* one bad event never stalls the queue */ }
		}
		if ( $minted ) { self::author_confirm_email( $minted ); }
	}

	/**
	 * THE PUBLICATION DECISION'S FRONT DOOR — one digest email to the author's registered address.
	 *
	 * One email per reporting tick, not one per story: a tick can mint a dozen, and a dozen mails an
	 * hour trains a person to stop reading them, which would defeat the gate more thoroughly than
	 * having no gate. Each story still carries its OWN single-use secret, so the author confirms
	 * them one at a time and confirming one says nothing about the others.
	 */
	private static function author_confirm_email( $minted ) {
		$uid = self::author_uid();
		$au  = $uid ? get_userdata( $uid ) : null;
		if ( ! $au || ! is_email( (string) $au->user_email ) ) { return; }
		$lines = [];
		foreach ( $minted as $m ) {
			$url = add_query_arg(
				[ 'action' => 'aq_news_confirm', 'slug' => $m['slug'], 'k' => $m['raw'] ],
				admin_url( 'admin-post.php' ) );
			$lines[] = '• ' . $m['title'] . "\n  " . mb_substr( $m['summary'], 0, 180 ) . "\n  Review & publish: " . $url;
		}
		Mailer::send( 'news_confirm', (string) $au->user_email, [
			'count' => (string) count( $minted ),
			'items' => implode( "\n\n", $lines ),
		] );
		Notify::push( $uid, 'artadev',
			count( $minted ) . ' ArtaNews report(s) are waiting for your decision — confirm links were emailed to your registered address. Nothing publishes until you say so.',
			'', '/news/', 'newscnf:' . (int) ( time() / HOUR_IN_SECONDS ) );
	}

	/**
	 * The account ArtaNews posts as: ARTABOT, never a human.
	 *
	 * This used to resolve to the founder's login — a leftover from the retired email-confirm gate,
	 * where a human WAS the author being asked to confirm. Under full automation that is wrong
	 * twice over: it would attribute unattended machine output to a person, and it would put those
	 * posts behind the publish-guard that (correctly) still applies to human authors.
	 */
	private static function author_uid() {
		$bot = (int) get_option( 'aq_artabot_uid', 0 );
		if ( $bot && get_userdata( $bot ) ) { return $bot; }
		$admins = get_users( [ 'role' => 'administrator', 'number' => 1, 'fields' => 'ID', 'orderby' => 'ID' ] );
		return $admins ? (int) $admins[0] : 0;
	}

	/** True iff $raw is the secret emailed to the author for THIS story. */
	private static function confirm_token_ok( $row, $raw ) {
		$stored = (string) ( $row['author_token'] ?? '' );
		if ( '' === $stored || ! is_string( $raw ) || ! preg_match( '/^[0-9a-f]{40}$/', $raw ) ) { return false; }
		return hash_equals( $stored, hash( 'sha256', $raw . '|' . (string) $row['slug'] ) );
	}

	/**
	 * THE ONE PUBLICATION PATH. $raw is the single-use secret from the author's emailed link —
	 * without it this refuses, unconditionally. There is no session, API-token, CLI or admin
	 * substitute: a publication that did not pass through the author's inbox cannot happen, and
	 * that includes anything I or any other agent can run on this server.
	 */
	public static function author_confirm( $slug, $act, $raw = '' ) {
		$slug = sanitize_title( (string) $slug );
		$row  = Data::one( 'SELECT id, slug, title, status, author_token FROM ' . Data::t( 'aq_news_articles' ) . ' WHERE slug = %s', [ $slug ] );
		if ( ! $row ) { return 'no such report'; }
		if ( 'pending' !== (string) $row['status'] ) { return 'not pending (status: ' . $row['status'] . ')'; }
		if ( ! self::confirm_token_ok( $row, $raw ) ) {
			return 'refused: the confirmation secret is missing, spent, or does not match the emailed link';
		}
		if ( 'discard' === $act ) {
			$won = Data::update( 'aq_news_articles',
				[ 'status' => 'discarded', 'author_token' => '', 'updated' => time() ],
				[ 'id' => (int) $row['id'], 'status' => 'pending', 'author_token' => (string) $row['author_token'] ] );
			return $won ? 'discarded — this report will not be published' : 'lost the race — already handled';
		}
		// The secret is SPENT ATOMICALLY with the publish flip: the WHERE clause carries both the
		// pending status and the exact token, so a double-click or a concurrent request loses cleanly
		// and the same secret can never publish twice.
		$now = time();
		$won = Data::update( 'aq_news_articles',
			[ 'status' => 'published', 'published' => $now, 'updated' => $now, 'author_token' => '' ],
			[ 'id' => (int) $row['id'], 'status' => 'pending', 'author_token' => (string) $row['author_token'] ] );
		if ( ! $won ) { return 'lost the race — already handled'; }
		return 'published: ' . home_url( '/news/' . $row['slug'] . '/' );
	}

	/**
	 * admin-post.php endpoint (action aq_news_confirm, nopriv — the emailed secret IS the
	 * authentication). GET renders a review page and changes NOTHING, so a mail scanner that
	 * prefetches the link cannot publish; only the explicit POST acts.
	 */
	public static function confirm_http() {
		$slug = sanitize_title( (string) ( $_REQUEST['slug'] ?? '' ) );
		$raw  = preg_replace( '/[^0-9a-f]/', '', (string) ( $_REQUEST['k'] ?? '' ) );
		$act  = ( 'discard' === ( $_REQUEST['act'] ?? '' ) ) ? 'discard' : 'publish';
		if ( 'POST' === strtoupper( (string) ( $_SERVER['REQUEST_METHOD'] ?? 'GET' ) ) ) {
			$msg = self::author_confirm( $slug, $act, $raw );
			wp_die( esc_html( $msg ), 'ArtaNews', [ 'response' => 200 ] );
		}
		$row = Data::one( 'SELECT slug, title, summary, body, status FROM ' . Data::t( 'aq_news_articles' ) . ' WHERE slug = %s', [ $slug ] );
		$ok  = $row && 'pending' === (string) $row['status'];
		$b   = $ok ? json_decode( (string) $row['body'], true ) : [];
		$post = esc_url( add_query_arg( [ 'action' => 'aq_news_confirm', 'slug' => $slug, 'k' => $raw ], admin_url( 'admin-post.php' ) ) );
		$html = '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">'
			. '<title>Publish this report?</title>'
			. '<style>body{font:16px/1.6 system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem;background:#06121E;color:#e9eef5}'
			. 'h1{font-size:1.35rem}.m{background:#0C1E32;padding:1rem;border-radius:8px}'
			. 'button{font:inherit;padding:.7rem 1.2rem;border:0;border-radius:6px;cursor:pointer}'
			. '.p{background:#E8B923;color:#06121E;font-weight:700}.d{background:#22354a;color:#e9eef5;margin-left:.5rem}</style>';
		if ( ! $ok ) {
			$html .= '<h1>Nothing to decide</h1><p>This report is not pending — it may already have been published or discarded.</p>';
		} else {
			$html .= '<h1>' . esc_html( (string) $row['title'] ) . '</h1>'
				. '<p>' . esc_html( (string) $row['summary'] ) . '</p>'
				. '<div class="m"><p>' . esc_html( (string) ( $b['measured'] ?? '' ) ) . '</p>'
				. ( ! empty( $b['possible'] ) ? '<p>' . esc_html( (string) $b['possible'] ) . '</p>' : '' )
				. '<p>' . esc_html( (string) ( $b['unknown'] ?? '' ) ) . '</p><ul>';
			foreach ( (array) ( $b['measures'] ?? [] ) as $k => $v ) {
				$html .= '<li><b>' . esc_html( (string) $k ) . ':</b> ' . esc_html( is_scalar( $v ) ? (string) $v : wp_json_encode( $v ) ) . '</li>';
			}
			$html .= '</ul></div>'
				. '<p>Publishing lists this report publicly at <code>/news/' . esc_html( $slug ) . '/</code>. Nothing has happened yet — this page only shows you what the instruments recorded.</p>'
				. '<form method="post" action="' . $post . '"><button class="p" name="act" value="publish">Publish this report</button>'
				. '<button class="d" name="act" value="discard">Discard it</button></form>';
		}
		wp_die( $html, 'ArtaNews', [ 'response' => 200 ] );
	}

	/** One event → { summary, body, sources }, or null when the relay can't be reached. */
	private static function write_report( $ev ) {
		$meta = json_decode( (string) $ev['measures'], true );
		$meas = (array) ( $meta['measures'] ?? [] );
		$src  = (array) ( $meta['source'] ?? [] );
		$kind = (string) ( $meta['kind'] ?? '' );
		if ( ! $meas ) { return null; }

		$facts = '';
		foreach ( $meas as $k => $v ) { $facts .= "- {$k}: {$v}\n"; }
		$where = trim( (string) $ev['place'] . ( $ev['country'] ? ', ' . $ev['country'] : '' ) );
		$pkm   = (float) ( $ev['place_km'] ?? 0 );
		$ctx   = "DETECTION TYPE: {$kind}\n"
			. ( $where ? 'NEAREST POPULATED PLACE: ' . $where . ' (nearest ≥15,000-person settlement, '
				. number_format( $pkm, 1 ) . " km from the measured coordinates — the event is NOT in this town unless that distance is small)\n" : '' )
			. ( (float) $ev['lat'] || (float) $ev['lon'] ? 'COORDINATES: ' . $ev['lat'] . ', ' . $ev['lon'] . "\n" : '' )
			. "INSTRUMENT/SOURCE: " . (string) ( $src['name'] ?? '' ) . "\n"
			. "MEASUREMENTS:\n{$facts}";

		// The prompt is the editorial policy. It is deliberately restrictive: the model may only
		// interpret the numbers above, must keep measurement and inference in separate sections,
		// and is told in plain terms what the instrument cannot see.
		$sys = 'You are a scientific data journalist for ArtaQuest. You are given ONLY instrument measurements. '
			. 'Write a short, factual report for a general audience of any background. '
			. 'ABSOLUTE RULES: (1) Use ONLY the numbers given — never invent, estimate, or add a figure, place, casualty, cause, or named party. '
			. '(2) Never assert WHY something happened. A satellite measures radiated heat; it cannot see an explosion, a strike, an accident or an arsonist. A seismometer measures ground motion; it cannot see damage. '
			. '(3) Keep MEASURED fact and INFERENCE strictly separate, and mark inference with hedged language ("consistent with", "typically associated with", "cannot be determined from this data alone"). '
			. '(4) Plain English, no jargon without a plain-word gloss, British spelling, no hype, no emojis, no markdown headings. '
			. 'OUTPUT strict JSON only: {"summary": "one sentence, max 30 words, saying what was measured and where", '
			. '"what_was_measured": "2-3 sentences describing the measurement and the instrument in plain words", '
			. '"what_it_could_be": "2-4 sentences on what phenomena are CONSISTENT with these numbers, and what is ruled in or out, all hedged", '
			. '"what_is_unknown": "1-2 sentences stating plainly what this data cannot establish"}';
		$res = Relay::ask( [ [ 'role' => 'user', 'content' => $ctx ] ], $sys, Assistant::MODEL, 1200, 'low' );
		if ( ! is_array( $res ) || empty( $res['text'] ) ) { return null; }
		$txt = trim( (string) $res['text'] );
		if ( preg_match( '/\{.*\}/s', $txt, $m ) ) { $txt = $m[0]; }
		$j = json_decode( $txt, true );
		if ( ! is_array( $j ) || empty( $j['summary'] ) ) { return null; }

		$body = [
			'measured' => trim( wp_strip_all_tags( (string) ( $j['what_was_measured'] ?? '' ) ) ),
			'possible' => trim( wp_strip_all_tags( (string) ( $j['what_it_could_be'] ?? '' ) ) ),
			'unknown'  => trim( wp_strip_all_tags( (string) ( $j['what_is_unknown'] ?? '' ) ) ),
			'measures' => $meas,
		];
		// The prompt is an instruction, not a guarantee. Check the OUTPUT: every figure in the prose
		// must trace to a measurement we handed it, and no sentence may assert a cause. On failure we
		// return null and the deterministic report publishes instead — the story is never lost.
		$prose = $j['summary'] . ' ' . $body['measured'] . ' ' . $body['possible'] . ' ' . $body['unknown'];
		if ( ! self::prose_ok( $prose, $meas, $ctx ) ) { return null; }
		return [
			'summary' => mb_substr( trim( wp_strip_all_tags( (string) $j['summary'] ) ), 0, 480 ),
			'body'    => wp_json_encode( $body ),
			'sources' => [ $src + [ 'retrieved_iso' => gmdate( 'c', (int) ( $src['retrieved'] ?? time() ) ) ] ],
		];
	}

	/**
	 * The DETERMINISTIC report — pure PHP, no relay, no model. Every sentence is assembled from the
	 * event's own measurements, so this can never invent a number and can never fail to exist. It is
	 * what publishes when the relay is busy or down: a measurement that happened gets a page.
	 */
	private static function measured_report( $ev ) {
		$meta = json_decode( (string) $ev['measures'], true );
		$meas = (array) ( $meta['measures'] ?? [] );
		$src  = (array) ( $meta['source'] ?? [] );
		$kind = (string) ( $meta['kind'] ?? 'measurement' );
		if ( ! $meas ) { return null; }
		$where = self::place_phrase( (string) $ev['place'], (string) $ev['country'], $ev['place_km'] ?? 0, ', ' );
		$inst  = (string) ( $src['name'] ?? 'a public instrument feed' );
		// A satellite measures radiated heat; 'wildfire' is OUR classification of that measurement.
		// The lede must therefore say a signature was measured and that we classified it — never that
		// the classification itself was observed.
		$prep  = self::place_prep( (string) $ev['place'], $ev['place_km'] ?? 0 );
		$sum   = 'A signature classified as ' . self::indefinite_article( $kind ) . ' ' . $kind
			. ( $where ? ' was measured ' . trim( $prep . ' ' . $where ) : ' was measured' )
			. ' on ' . gmdate( 'j F Y', (int) $ev['first_ts'] ) . ' at ' . gmdate( 'H:i', (int) $ev['first_ts'] ) . ' UTC by ' . $inst . '.';
		return [
			'summary' => mb_substr( $sum, 0, 480 ),
			'body'    => wp_json_encode( [
				'measured' => 'This report is generated directly from the instrument record. ' . $inst
					. ' recorded the values listed below' . ( $where ? ( 'near' === $prep ? ' at coordinates nearest to ' : ' at coordinates ' . ( 'in' === $prep ? 'in ' : '' ) ) . $where : '' ) . '. '
					. 'The classification above is derived from those values by a fixed rule, not observed directly.',
				'possible' => '',   // inference requires the relay; silence is correct, invention is not
				'unknown'  => 'These figures describe what an instrument measured. They do not establish the cause of the event, who was involved, or any consequence on the ground.',
				'measures' => $meas,
			] ),
			'sources' => [ $src + [ 'retrieved_iso' => gmdate( 'c', (int) ( $src['retrieved'] ?? time() ) ) ] ],
		];
	}

	/** A stable, readable, unique slug: "heat-signature-tehran-iran-20260725-1a2b". */
	private static function slug( $ev ) {
		// sanitize_title() PERCENT-ENCODES non-ASCII, so "Al Ḩasakah" became
		// 'al-%e1%b8%a9asakah' — and the route regex is [a-z0-9-]+, which cannot match '%'. Every
		// article about a place with a diacritic was a permanent 404 AT ITS OWN URL, which is most of
		// the Middle East, Ukraine and North Africa. The list endpoint hid it completely.
		// remove_accents() first folds Ḩ→H, then anything still outside the route's alphabet is
		// replaced rather than encoded, so the slug is reachable by construction.
		$base = sanitize_title( remove_accents( (string) $ev['headline'] ) );
		$base = strtolower( rawurldecode( $base ) );
		$base = preg_replace( '/[^a-z0-9]+/', '-', $base );
		$base = trim( (string) preg_replace( '/-+/', '-', $base ), '-' );
		$base = $base ?: 'detection';
		return mb_substr( $base, 0, 90 ) . '-' . gmdate( 'Ymd', (int) $ev['first_ts'] ) . '-' . substr( md5( (string) $ev['ekey'] ), 0, 4 );
	}

	// ── public read API ───────────────────────────────────────────────────────────────────────

	/** GET news — the published feed, newest first. */
	const FEED_MAX_AGE = 1209600;   // 14 d — a detection older than this has stopped being news

	/**
	 * IS THIS DETECTION WORTH SHOWING? Severity means a different physical thing in every detector —
	 * megawatts of radiated power, percent below a country's own normal connectivity, moment
	 * magnitude, standard deviations of a settlement price, a status enum — so there is no single
	 * number to threshold on and never was. These are the SAME floors the retired posting stage
	 * applied before it published anything; they moved here, unchanged, when the card stopped being
	 * fed by posts (operator 2026-07-31). Without them the card shows every routine agricultural
	 * burn the satellite sees.
	 */
	private static function newsworthy( $r ) {
		$watched  = in_array( (string) $r['country'], self::WATCH, true );
		$sev      = (float) $r['severity'];
		switch ( (string) $r['detector'] ) {
			case 'thermal':
				return $sev >= ( $watched ? self::ARTANEWS_MIN_WATCH : self::ARTANEWS_MIN_FRP );
			case 'netloss':
			case 'blackout':
				return $sev >= ( $watched ? self::ARTANEWS_MIN_DROP_WATCH : self::ARTANEWS_MIN_DROP );
			case 'quake':
				// A classified explosion and an ordinary earthquake are not the same story and do not
				// share a floor — see QUAKE_MIN_MAG. `kind` is the detector's own classification,
				// carried inside `measures` because the ledger has no column for it.
				return $sev >= ( self::is_blast_row( $r ) ? self::BLAST_MIN_MAG : self::QUAKE_MIN_MAG );
			case 'price':
				return $sev >= self::PRICE_SIGMA;
			case 'claude':
				return $sev >= self::CLAUDE_MIN_SEVERITY;
		}
		return false;   // an unregistered detector shows nothing rather than everything
	}

	/**
	 * Was this seismic row classified as an EXPLOSION by the network that solved it? The ledger
	 * stores no column for it — `kind` travels inside the `measures` JSON — so both the stored blob
	 * and an in-flight detector row have to answer, and this is the single place that knows how.
	 * Unparseable or absent ⇒ FALSE, which applies the HIGHER earthquake floor: failing to
	 * recognise a blast hides one story, whereas guessing "blast" publishes ordinary earthquakes as
	 * explosions. Only one of those two mistakes is a false claim about the world.
	 */
	private static function is_blast_row( $r ) {
		if ( isset( $r['blast'] ) ) { return (bool) $r['blast']; }
		$m = $r['measures'] ?? '';
		if ( is_string( $m ) ) { $m = json_decode( $m, true ); }
		$kind = is_array( $m ) ? (string) ( $m['kind'] ?? '' ) : '';
		return false !== strpos( $kind, 'explosion' );
	}

	/**
	 * PURGE THE POSTS ARTANEWS ALREADY PUBLISHED — wp-cli only, never a route (operator 2026-07-31,
	 * who chose deletion over unpublishing having been told it is irreversible and orphans any DOI).
	 *
	 *     studio wp eval 'print_r( AQ\News::purge_artabot_posts() );'          # DRY RUN, changes nothing
	 *     studio wp eval 'print_r( AQ\News::purge_artabot_posts( false ) );'   # actually delete
	 *
	 * TARGETING IS NARROW ON PURPOSE. It deletes only notebooks that are BOTH authored by ArtaBot AND
	 * carry the exact headline of a row in the detection ledger. ArtaBot is a member with other
	 * reasons to hold work, and "everything ArtaBot ever wrote" is not what was asked for — so a
	 * notebook that does not match a detection is left alone and reported separately, where it can be
	 * seen rather than silently swept up.
	 *
	 * Dry run by default. It returns the same shape either way, so the counts can be read before
	 * anything is destroyed — this codebase has a standing rule about verifying before deleting.
	 */
	public static function purge_artabot_posts( $dry = true ) {
		global $wpdb;
		$bot = (int) get_option( 'aq_artabot_uid', 0 );
		if ( ! $bot ) { return [ 'error' => 'no artabot user' ]; }
		$nb  = Data::t( 'aq_notebooks' );
		$ev  = Data::t( 'aq_news_events' );
		$hit = $wpdb->get_results( $wpdb->prepare(
			"SELECT n.id, n.slug, n.title, n.status, n.doi FROM $nb n WHERE n.author_id = %d"
			. " AND EXISTS ( SELECT 1 FROM $ev e WHERE e.headline = n.title )", $bot ), ARRAY_A );
		$keep = (int) $wpdb->get_var( $wpdb->prepare(
			"SELECT COUNT(*) FROM $nb n WHERE n.author_id = %d"
			. " AND NOT EXISTS ( SELECT 1 FROM $ev e WHERE e.headline = n.title )", $bot ) );
		$dois = 0;
		foreach ( (array) $hit as $r ) { if ( ! empty( $r['doi'] ) ) { $dois++; } }
		$out = [
			'dry_run' => (bool) $dry, 'artabot_uid' => $bot,
			'matched_detections' => count( (array) $hit ), 'with_doi' => $dois,
			'kept_other_artabot_work' => $keep,
			'sample' => array_map( static function ( $r ) {
				return '#' . $r['id'] . ' [' . $r['status'] . '] ' . mb_substr( (string) $r['title'], 0, 70 );
			}, array_slice( (array) $hit, 0, 10 ) ),
		];
		if ( $dry || ! $hit ) { return $out; }
		$ids = array_map( static function ( $r ) { return (int) $r['id']; }, (array) $hit );
		$in  = implode( ',', array_map( 'intval', $ids ) );
		// Take the post rows and hearts with them; leaving those behind would show orphaned counts and
		// a feed post pointing at a notebook that no longer exists.
		// nb_id, NOT notebook_id — aq_posts is declared in Notebook.php, not Schema.php, and the wrong
		// column name here would have deleted nothing while reporting success.
		$wpdb->query( "DELETE FROM " . Data::t( 'aq_posts' ) . " WHERE nb_id IN ($in)" );
		$wpdb->query( "DELETE FROM " . Data::t( 'aq_votes' ) . " WHERE target_type = 'notebook' AND target_id IN ($in)" );
		$wpdb->query( "DELETE FROM $nb WHERE id IN ($in)" );
		// The ledger keeps every detection — only the PUBLICATION is withdrawn. Clear the watermark so
		// the rows stop claiming a post that no longer exists.
		$wpdb->query( "UPDATE $ev SET posted = 0 WHERE posted = 1" );
		$out['deleted'] = count( $ids );
		return $out;
	}

	/**
	 * THE MEASUREMENT, RENDERED WITH ITS UNITS. `severity` is a bare double whose meaning changes
	 * completely between detectors — megawatts, percent, moment magnitude, sigma, a status score —
	 * so the units belong here, next to the detector that owns them, and never in the SPA, which
	 * would have to duplicate this knowledge and would drift from it.
	 */
	private static function measure_label( $r ) {
		$sev = (float) $r['severity'];
		switch ( (string) $r['detector'] ) {
			case 'thermal':  return number_format( $sev, 0 ) . ' MW radiated';
			case 'netloss':
			case 'blackout': return number_format( $sev, 0 ) . '% below normal';
			case 'quake':    return 'M' . number_format( $sev, 1 );
			case 'price':    return number_format( $sev, 1 ) . 'σ move';
			case 'claude':   return $sev >= 100 ? 'major outage' : ( $sev >= 60 ? 'partial outage' : 'degraded' );
		}
		return '';
	}

	/**
	 * GET /news — the detections themselves, straight from the instrument ledger.
	 *
	 * THIS READS aq_news_events DIRECTLY (operator 2026-07-31: disaster signals belong in the rail
	 * card "like any other news and not posted"). It used to read ArtaBot's published notebooks,
	 * which coupled the card to the posting cron: the rail could only show what had been posted, so
	 * switching the posting off would have silently emptied it. The card is now the primary surface
	 * for a detection rather than a pointer to one, and it carries no link, because with nothing
	 * posted there is no page to link to — the measurement travels in the row itself.
	 *
	 * Ordered by RECENCY, not by rank: this is a news rail, and the loudest event of the fortnight
	 * should not sit at the top of it for a fortnight.
	 */
	public static function feed( $req = null ) {
		$limit = max( 1, min( 50, (int) ( is_object( $req ) ? ( $req->get_param( 'limit' ) ?: 20 ) : 20 ) ) );
		$rows  = Data::all(
			'SELECT id, ekey, detector, headline, place, country, place_km, severity, confidence,'
			. ' lat, lon, energy_mj, first_ts, last_ts, measures'
			. ' FROM ' . Data::t( 'aq_news_events' )
			. ' WHERE last_ts >= %d AND headline <> %s'
			. ' ORDER BY last_ts DESC LIMIT %d',
			// Over-fetch: the per-detector floors below cannot be expressed in SQL, so filter in PHP
			// and still return a full card.
			[ time() - self::FEED_MAX_AGE, '', (int) $limit * 12 ] );
		// ROUND-ROBIN ACROSS DETECTORS, recency preserved inside each (the same grammar "Today's News"
		// uses to interleave newsrooms). Straight recency lets ONE instrument own the card: seismic
		// events are far more frequent than national outages, so a purely time-ordered list showed
		// four earthquakes and hid the other four detectors entirely. Bucket by detector, then take
		// one from each in turn — the reader sees the breadth of what is being watched, and a quiet
		// detector still gets its line.
		$buckets = [];
		foreach ( (array) $rows as $r ) {
			if ( ! self::newsworthy( $r ) ) { continue; }
			$buckets[ (string) $r['detector'] ][] = $r;
		}
		$ordered = [];
		while ( $buckets ) {
			foreach ( array_keys( $buckets ) as $d ) {
				$ordered[] = array_shift( $buckets[ $d ] );
				if ( ! $buckets[ $d ] ) { unset( $buckets[ $d ] ); }
				if ( count( $ordered ) >= $limit ) { break 2; }
			}
		}
		$out = [];
		foreach ( $ordered as $r ) {
			$out[] = [
				'id'    => (int) $r['id'],
				'ekey'  => (string) $r['ekey'],
				// The rail had nothing to link to: the feed omitted the very key its own pages are
				// addressed by, so every card was a dead end.
				'slug'  => self::event_slug( $r ),
				'url'   => '/news/' . self::event_slug( $r ) . '/',
				'title' => (string) $r['headline'],
				'observed'  => (int) $r['first_ts'],
				'updated'   => (int) $r['last_ts'],
				'detector'  => (string) ( self::DETECTORS[ (string) $r['detector'] ]['label'] ?? $r['detector'] ),
				'detector_key' => (string) $r['detector'],
				'measure' => self::measure_label( $r ),
				// `place` MUST agree with the headline. The headline drops a town once it is further than
				// BEARING_KM away, because naming a settlement 61 km from the measurement is a claim the
				// coordinates do not support — but the raw column was still emitted here, so the rail
				// printed 'Major heat signature, Russia (972 MW)' over the subtitle '972 MW · Yasnyy',
				// reinstating in the second line exactly the claim the first line had withdrawn.
				// Beyond that distance the country is the honest unit, so that is what ships.
				'place' => ( (float) ( $r['place_km'] ?? 0 ) <= self::BEARING_KM && '' !== (string) ( $r['place'] ?? '' ) )
					? (string) $r['place'] : (string) ( $r['country'] ?? '' ),
				// The full tiered phrase, so a surface can render the location without re-deriving the rule.
				'place_label' => self::place_phrase( (string) ( $r['place'] ?? '' ), (string) ( $r['country'] ?? '' ),
					$r['place_km'] ?? 0, ', ' ),
				'country' => (string) ( $r['country'] ?? '' ),
				'place_km' => (float) ( $r['place_km'] ?? 0 ),
				'severity' => (float) ( $r['severity'] ?? 0 ),
				'energy_mj' => (float) ( $r['energy_mj'] ?? 0 ),
				'confidence' => (string) ( $r['confidence'] ?? '' ),
				'lat' => (float) ( $r['lat'] ?? 0 ), 'lon' => (float) ( $r['lon'] ?? 0 ),
			];
		}
		return [ 'items' => $out ];
	}

	/** GET news/(?P<slug>…) — one report, with its measurements and provenance. */
	/**
	 * GET news/{slug} — ONE detection, with everything a page needs to stand on its own.
	 *
	 * Reads aq_news_events, not the retired aq_news_articles table. Returns the measurement, its
	 * provenance, and the inline animated SVG — so the page is a primary source: a reader can see
	 * what the instrument recorded, when, and how far it extended, without trusting our summary.
	 */
	public static function article( $req ) {
		$slug = sanitize_title( (string) $req->get_param( 'slug' ) );
		if ( '' === $slug ) { return Rest::err( 'not_found', 'No such report', 404 ); }
		// The slug carries the event id as its trailing -e<N> segment, so the lookup is exact rather
		// than a title match that drifts when a headline is regenerated.
		$id = preg_match( '/-e(\d+)$/', $slug, $m ) ? (int) $m[1] : 0;
		$row = $id
			? Data::one( 'SELECT * FROM ' . Data::t( 'aq_news_events' ) . ' WHERE id = %d', [ $id ] )
			: Data::one( 'SELECT * FROM ' . Data::t( 'aq_news_events' ) . ' WHERE ekey = %s', [ $slug ] );
		if ( ! $row ) { return Rest::err( 'not_found', 'No such report', 404 ); }
		$meta = json_decode( (string) $row['measures'], true );
		$meas = (array) ( $meta['measures'] ?? [] );
		$src  = (array) ( $meta['source'] ?? [] );
		$km   = (float) ( $row['place_km'] ?? 0 );
		return [
			'slug'      => self::event_slug( $row ),
			'id'        => (int) $row['id'],
			'title'     => (string) $row['headline'],
			// The dek answers the question a search brings someone here with, in one sentence.
			'summary'   => self::event_dek( $row, $src ),
			'detector'  => (string) ( self::DETECTORS[ (string) $row['detector'] ]['label'] ?? $row['detector'] ),
			'kind'      => (string) ( $meta['kind'] ?? '' ),
			'measures'  => $meas,
			'source'    => $src + [ 'retrieved_iso' => gmdate( 'c', (int) ( $src['retrieved'] ?? time() ) ) ],
			'place'     => ( $km <= self::BEARING_KM && '' !== (string) $row['place'] ) ? (string) $row['place'] : (string) $row['country'],
			'place_label' => self::place_phrase( (string) $row['place'], (string) $row['country'], $km, ', ' ),
			'country'   => (string) $row['country'],
			'place_km'  => $km,
			'lat'       => (float) $row['lat'], 'lon' => (float) $row['lon'],
			'severity'  => (float) $row['severity'],
			'energy_mj' => (float) ( $row['energy_mj'] ?? 0 ),
			'confidence'=> (string) $row['confidence'],
			'observed'  => (int) $row['first_ts'], 'updated' => (int) $row['last_ts'],
			// The visualisation ships WITH the data: inline SVG, so the page needs no second request
			// and a crawler reads the measurements as text.
			'svg'       => self::detection_svg( $row ),
			// The locator answers WHERE; `svg` answers WHAT and HOW MUCH. Separate fields so a page can
			// lay them out together under one visualisation heading.
			'map'       => self::locator_svg( $row['lat'] ?? 0, $row['lon'] ?? 0 ),
			// TIER 2 — human reporting, attributed, and structurally separate from every measured field
			// above it. Read from cache only: rendering a page must never call an outside service.
			'context'   => self::social_context( (int) $row['id'] ),
			// Stated on every page, not implied: an instrument measured energy, nothing more.
			'unknown'   => 'These figures describe what an instrument measured. They do not establish the'
				. ' cause of the event, who was involved, or any consequence on the ground.',
		];
	}

	/**
	 * ─── TIER 2 ────────────────────────────────────────────────────────────────────────────────
	 * REDDIT AS CONTEXT, NEVER AS A DETECTOR (operator asked for Reddit, 2026-08-09).
	 *
	 * A Reddit post cannot start a story here and this code gives it no way to. The two-tier rule
	 * is the platform's whole immunity to information flooding — *you cannot fake a seismometer* —
	 * and you can fake a Reddit post in about four seconds. Anything social that could create a
	 * detection would hand any account holder the power to manufacture ArtaQuest news. So social
	 * material enters exactly where human reporting already enters: as ATTRIBUTED CONTEXT hung off
	 * a detection an instrument already made, which can never raise a confidence tier and can never
	 * supply a number. Every constraint in ARTANEWS.md §2 (the juxtaposition trap) applies unchanged.
	 *
	 * ⚠️ THE MATCH IS BY PLACE NAME, NOT BY POSITION, and the payload says so on every panel. Reddit's
	 * search endpoint answers 429 to unauthenticated clients without exception (measured 2026-08-09),
	 * so there is no way to ask "what was posted near this coordinate" — only "what did these
	 * subreddits post recently", filtered by the place name appearing in the title. That is a much
	 * weaker claim than the geolocated distance a wire citation carries, and printing it next to a
	 * measurement without saying so is precisely the trap: a post mentioning a country is not a
	 * report about a spot in it, and layout alone would assert that it is.
	 *
	 * Measured limits, all live 2026-08-09, none of them worked around: plain subreddit RSS is the
	 * only keyless surface left (`/r/<sub>/new/.rss`); it answers 429 to roughly half of requests
	 * even spaced 30 s apart; and a subreddit can be silently dead — r/earthquake's newest post was
	 * two years old. So this fails soft everywhere, records its health, and a detection with no
	 * context renders exactly as it did before: the measurement, alone, which is the whole story.
	 */
	const REDDIT_SUBS   = [ 'worldnews', 'news', 'CredibleDefense', 'geopolitics', 'TropicalWeather' ];
	const REDDIT_CACHE  = 'aq_news_social';  // one option holding id => refs; capped, never a per-view fetch
	const REDDIT_MAX    = 4;                 // references shown per detection
	const REDDIT_TTL    = 43200;             // 12 h — context ages out rather than going stale forever

	/** Cached Tier-2 references for one detection. Reads only — never fetches. */
	public static function social_context( $event_id ) {
		$all = get_option( self::REDDIT_CACHE, [] );
		$hit = is_array( $all ) ? ( $all[ (int) $event_id ] ?? null ) : null;
		if ( ! is_array( $hit ) || ( (int) ( $hit['fetched'] ?? 0 ) + self::REDDIT_TTL ) < time() ) { return []; }
		return [
			// NEVER "causes" — the heading is what was posted, in what period, and nothing more.
			'heading'  => 'What was posted about this area and period',
			'caveat'   => 'These posts are not evidence of a connection to this measurement, and no link'
				. ' has been established. They were matched because the place name appears in the title —'
				. ' not by position, so a post may be about somewhere else entirely in the same country.',
			'refs'     => array_values( (array) ( $hit['refs'] ?? [] ) ),
			'fetched'  => (int) $hit['fetched'],
		];
	}

	/**
	 * Populate that cache (cron aq_news_social). ONE pass over the allow-list per tick, not one per
	 * event: the feeds are the same whoever is asking, and hitting Reddit once per detection would
	 * both waste the rate limit this barely fits inside and scale with the news, which is backwards.
	 * Nothing here can create, promote, revise or rank a detection — it only ever writes an option.
	 */
	public static function social_tick() {
		$posts = [];
		foreach ( self::REDDIT_SUBS as $sub ) {
			$t0  = microtime( true );
			$got = self::reddit_feed( $sub );
			// A dead or throttled subreddit is recorded, not hidden: half of these calls are expected
			// to fail, and a source that starts failing ALWAYS is the thing worth seeing in health.
			Extra::src_health( 'news:reddit:' . $sub, (bool) $got, ( microtime( true ) - $t0 ) * 1000, count( $got ) );
			$posts = array_merge( $posts, $got );
		}
		if ( ! $posts ) { return; }
		// Only live, newsworthy detections get context — matching against the whole ledger would
		// attach today's headlines to months-old events, which is the juxtaposition trap with a
		// time axis instead of a distance one.
		$rows = Data::all(
			'SELECT id, place, country, first_ts, last_ts, detector, severity, measures FROM ' . Data::t( 'aq_news_events' )
			. ' WHERE last_ts > %d ORDER BY rank_score DESC LIMIT %d',
			[ time() - self::FEED_MAX_AGE, self::MAX_EVENTS ]
		);
		$out = [];
		foreach ( (array) $rows as $r ) {
			if ( ! self::newsworthy( $r ) ) { continue; }
			$refs = self::match_posts( $posts, $r );
			if ( $refs ) { $out[ (int) $r['id'] ] = [ 'fetched' => time(), 'refs' => $refs ]; }
		}
		update_option( self::REDDIT_CACHE, $out, false );
	}

	/** One subreddit's recent posts via the last keyless surface: plain Atom. [] on any failure. */
	private static function reddit_feed( $sub ) {
		$xml = self::fetch( 'https://www.reddit.com/r/' . rawurlencode( $sub ) . '/new/.rss', 15 );
		if ( ! $xml ) { return []; }
		// libxml is told to keep its errors to itself: a 429 body or a truncated read is an ordinary
		// outcome here, not something to raise into a PHP warning on a cron tick.
		$prev = libxml_use_internal_errors( true );
		$feed = simplexml_load_string( $xml );
		libxml_clear_errors();
		libxml_use_internal_errors( $prev );
		if ( ! $feed || ! isset( $feed->entry ) ) { return []; }
		$out = [];
		foreach ( $feed->entry as $e ) {
			$ts = strtotime( (string) $e->updated );
			// Stale is worse than absent: r/earthquake's newest post was two years old when this was
			// written, and an ancient thread printed beside a measurement from this morning reads as
			// contemporaneous. Anything older than the feed window is simply not context for it.
			if ( ! $ts || $ts < time() - self::FEED_MAX_AGE ) { continue; }
			$out[] = [
				'source'    => 'reddit',
				'community' => 'r/' . $sub,
				'title'     => trim( (string) $e->title ),
				'url'       => (string) ( $e->link['href'] ?? '' ),
				'posted'    => $ts,
				'posted_iso'=> gmdate( 'c', $ts ),
			];
		}
		return $out;
	}

	/**
	 * Which of those posts name this detection's place, inside its window? Deliberately narrow, and
	 * deliberately dumb: a whole-word match on the settlement or country, never a fuzzy or semantic
	 * one. A loose matcher here does not produce more context, it produces confident-looking
	 * coincidence — and the juxtaposition trap is a layout problem, so the cheapest fix is to
	 * attach less. `preg_quote` matters: place names really do contain regex metacharacters.
	 */
	private static function match_posts( $posts, $ev ) {
		// A SETTLEMENT MATCH AND A COUNTRY MATCH ARE NOT THE SAME EVIDENCE, and collapsing them was
		// the first thing this got wrong in testing: a detection in Russia drew "Russia Hit Odesa
		// with 11 Missiles" — a post about a city in UKRAINE, matched on the country name, printed
		// beside a measurement a thousand kilometres away. The blanket caveat covers it, but a
		// reader reads references one at a time, so each one carries its own strength and the
		// stronger kind sorts first. Country-level matches stay because for most of this ledger the
		// country is all there is — they are just never allowed to look like more than they are.
		$names = [];
		$place = trim( (string) ( $ev['place'] ?? '' ) );
		$ctry  = trim( (string) ( $ev['country'] ?? '' ) );
		if ( '' !== $place ) { $names[] = [ $place, 'settlement' ]; }
		if ( '' !== $ctry && 0 !== strcasecmp( $ctry, $place ) ) { $names[] = [ $ctry, 'country' ]; }
		if ( ! $names ) { return []; }
		$from = (int) $ev['first_ts'] - 86400;   // a day either side: reporting lags a measurement,
		$to   = (int) $ev['last_ts'] + 86400;    // and a warning can precede one
		$hits = [];
		foreach ( $posts as $p ) {
			if ( $p['posted'] < $from || $p['posted'] > $to ) { continue; }
			foreach ( $names as list( $n, $kind ) ) {
				if ( mb_strlen( $n ) < 4 ) { continue; }   // 3-letter tokens match half the language
				if ( preg_match( '/\b' . preg_quote( $n, '/' ) . '\b/iu', $p['title'] ) ) {
					$hits[] = $p + [
						'matched_name' => $n,
						'match_kind'   => $kind,
						'match_note'   => 'settlement' === $kind
							? 'mentions ' . $n . ', the nearest settlement to the measurement'
							: 'mentions ' . $n . ' only — the country, not the location measured',
					];
					break;
				}
			}
		}
		// Strongest first, then most recent, and only then truncated — so a country-level match can
		// never displace a settlement-level one just by arriving earlier in the feed.
		usort( $hits, static function ( $a, $b ) {
			$rank = static fn( $h ) => 'settlement' === $h['match_kind'] ? 0 : 1;
			return [ $rank( $a ), -$a['posted'] ] <=> [ $rank( $b ), -$b['posted'] ];
		} );
		return array_slice( $hits, 0, self::REDDIT_MAX );
	}

	/** A stable, readable, route-safe slug that pins the exact event: …-e<id>. */
	public static function event_slug( $row ) {
		$b = sanitize_title( remove_accents( (string) $row['headline'] ) );
		$b = trim( (string) preg_replace( '/-+/', '-', preg_replace( '/[^a-z0-9]+/', '-', strtolower( rawurldecode( $b ) ) ) ), '-' );
		return mb_substr( $b ?: 'detection', 0, 90 ) . '-e' . (int) $row['id'];
	}

	/**
	 * 'a' or 'an' for a detector's `kind` noun.
	 *
	 * Every seismic page read "A signature classified as a earthquake". The kind comes from the
	 * detector, so the article cannot be baked into the surrounding prose — it has to be chosen per
	 * kind, in one place BOTH deks call, or the two sentences drift apart the moment a detector is
	 * added.
	 *
	 * A plain vowel test, deliberately. The kinds the six detectors emit are a closed set — wildfire,
	 * thermal anomaly, earthquake, seismically recorded explosion, internet connectivity loss,
	 * national internet traffic collapse, price jump/drop, service disruption — and it decides all of
	 * them correctly. An earlier version carried silent-h and long-u tables that no producible input
	 * could reach: dead branches a later reader would have to diff against the detector list to know
	 * were inert. If a kind ever needs 'an hour' or 'a one-off', handle it here and say so.
	 */
	private static function indefinite_article( $noun ) {
		$n = strtolower( trim( (string) $noun ) );
		return ( '' !== $n && false !== strpos( 'aeiou', $n[0] ) ) ? 'an' : 'a';
	}

	/** One sentence: what was measured, where, when, by what. */
	private static function event_dek( $row, $src ) {
		$where = self::place_phrase( (string) $row['place'], (string) $row['country'], $row['place_km'] ?? 0, ', ' );
		$prep  = self::place_prep( (string) $row['place'], $row['place_km'] ?? 0 );
		$kind  = (string) ( json_decode( (string) $row['measures'], true )['kind'] ?? 'measurement' );
		return 'A signature classified as ' . self::indefinite_article( $kind ) . ' ' . $kind
			. ( $where ? ' was measured ' . trim( $prep . ' ' . $where ) : ' was measured' )
			. ' on ' . gmdate( 'j F Y', (int) $row['first_ts'] ) . ' at ' . gmdate( 'H:i', (int) $row['first_ts'] )
			. ' UTC by ' . (string) ( $src['name'] ?? 'a public instrument feed' ) . '.';
	}

	private static function shape( $r ) {
		return [
			'slug' => $r['slug'], 'title' => $r['title'], 'summary' => $r['summary'],
			'published' => (int) $r['published'], 'detector' => $r['detector'],
			'place' => $r['place'], 'country' => $r['country'], 'place_km' => (float) ( $r['place_km'] ?? 0 ),
			'confidence' => $r['confidence'], 'severity' => (float) $r['severity'],
			'lat' => (float) $r['lat'], 'lon' => (float) $r['lon'],
		];
	}

	// ── ArtaNews newsworthiness floors (posting RETIRED 2026-07-31) ────────────────────────────
	/**
	 * THE POSTING LOOP IS GONE (operator 2026-07-31: disaster signals belong "in the bottom card like
	 * any other news and not posted — so not posted under ArtaBot's account").
	 *
	 * What used to live here: artanews_tick() picked the loudest unposted detection, artanews_post()
	 * built a reproducible notebook, ran it on Kaggle and published it as a submission authored by
	 * ArtaBot, and artanews_ipynb() wrote that notebook. All three are removed — recoverable from git
	 * history if the decision is ever revisited.
	 *
	 * WHAT THAT COST, said plainly rather than left for someone to discover: a posted notebook was a
	 * citable, reproducible page, and the ArtaNews contract at the top of this file promises exactly
	 * that. A rail row is not a page and cannot be cited. The detections are still recorded in full in
	 * aq_news_events with their measurements and provenance, and the public Data explorer serves that
	 * table, so the evidence remains inspectable by a stranger — but it is no longer a permanent URL.
	 *
	 * The FLOORS below survived the removal because they were never about posting: they are the
	 * newsworthiness bar for the whole system, and feed()'s newsworthy() now applies them so the card
	 * shows what the posting stage used to select.
	 */
	// SET FROM THE BACKTEST (1,513 detections replayed over 8 days, 2026-07-22..29), not from
	// intuition. Cross-checked against MODIS — a DIFFERENT sensor on DIFFERENT satellites — the
	// independent-confirmation rate climbs with energy: 67% at 100-500 MW, 82% at 500-1k,
	// 86% at 2-5k, and 94% above 5,000 MW. At 500 MW the detector produced 176 events a day,
	// which is a firehose whose median story is an ordinary wildfire.
	const ARTANEWS_MIN_FRP   = 8000.0; // MW — global: the 94%-confirmed tail, ~1 post/day
	const ARTANEWS_MIN_WATCH = 300.0;  // MW inside a watched box, where the census does the rest
	const ARTANEWS_MIN_DROP       = 50.0; // % below a country's own normal connectivity
	const ARTANEWS_MIN_DROP_WATCH = 25.0; // …lower inside a watched country, where it carries more

	/**
	 * WHERE ON EARTH — a locator map, drawn offline from a bundled outline.
	 *
	 * The detail figures plot latitude and longitude, which tells a reader the shape of an event but
	 * not its place: a dot cloud at longitude 59.89 is not a location to anyone. This draws the
	 * coastline and marks the measurement on it.
	 *
	 * NO TILE SERVER, deliberately. A slippy map would mean an external request from a page whose
	 * whole claim is that it is self-contained and reproducible — and the site's CSP blocks outbound
	 * hosts anyway. data/world-outline.json is Natural Earth 110 m land, Douglas-Peucker simplified
	 * to 50 rings and 903 points (11.8 KB, public domain), which is coarse for a continent and ample
	 * for "which part of the world is this".
	 *
	 * Equirectangular, because the job is orientation rather than area or distance — and a projection
	 * that distorts area would be the wrong one to put beside measured quantities.
	 */
	public static function locator_svg( $lat, $lon, $w = 640, $h = 320 ) {
		$lat = (float) $lat; $lon = (float) $lon;
		if ( ( 0.0 === $lat && 0.0 === $lon ) || $lat < -90 || $lat > 90 || $lon < -180 || $lon > 180 ) {
			return '';   // no coordinate: country-level events (netloss, price) have nothing to mark
		}
		static $rings = null;
		if ( null === $rings ) {
			$f = AQ_DIR . '/data/world-outline.json';
			$rings = is_readable( $f ) ? ( json_decode( (string) file_get_contents( $f ), true ) ?: [] ) : [];
		}
		if ( ! $rings ) { return ''; }
		$x = static fn( $lo ) => ( ( $lo + 180.0 ) / 360.0 ) * $w;
		$y = static fn( $la ) => ( ( 90.0 - $la ) / 180.0 ) * $h;
		$o = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $w . ' ' . $h . '" role="img" '
			. 'font-family="system-ui,sans-serif" '
			. 'aria-label="' . esc_attr( 'World locator: ' . number_format( abs( $lat ), 2 ) . ( $lat >= 0 ? '°N ' : '°S ' )
				. number_format( abs( $lon ), 2 ) . ( $lon >= 0 ? '°E' : '°W' ) ) . '" '
			. 'style="width:100%;height:auto;background:#06121E;border-radius:10px">';
		$o .= '<title>Where on Earth this was measured</title>';
		$o .= '<desc>' . esc_html( 'Coastlines from Natural Earth 110 m (public domain), equirectangular. '
			. 'The marker is the measured coordinate.' ) . '</desc>';
		// equator and prime meridian, so the marker can be read against something
		$o .= '<line x1="0" y1="' . round( $y( 0 ), 1 ) . '" x2="' . $w . '" y2="' . round( $y( 0 ), 1 )
			. '" stroke="#1b2b3d" stroke-width="1"/>'
			. '<line x1="' . round( $x( 0 ), 1 ) . '" y1="0" x2="' . round( $x( 0 ), 1 ) . '" y2="' . $h
			. '" stroke="#1b2b3d" stroke-width="1"/>';
		$d = '';
		foreach ( $rings as $ring ) {
			$first = true;
			foreach ( $ring as $pt ) {
				$d .= ( $first ? 'M' : 'L' ) . round( $x( (float) $pt[0] ), 1 ) . ' ' . round( $y( (float) $pt[1] ), 1 ) . ' ';
				$first = false;
			}
			$d .= 'Z ';
		}
		$o .= '<path d="' . trim( $d ) . '" fill="#16283a" stroke="#2b4157" stroke-width=".7"/>';
		$mx = round( $x( $lon ), 1 ); $my = round( $y( $lat ), 1 );
		// a ping, so the eye finds it on a busy outline
		$o .= '<circle cx="' . $mx . '" cy="' . $my . '" r="5" fill="none" stroke="#E8B923" stroke-width="1.6">'
			. '<animate attributeName="r" values="5;17;5" dur="2.8s" repeatCount="indefinite"/>'
			. '<animate attributeName="opacity" values="1;0;1" dur="2.8s" repeatCount="indefinite"/></circle>'
			. '<circle cx="' . $mx . '" cy="' . $my . '" r="3.6" fill="#E8B923" stroke="#06121E" stroke-width="1"/>';
		// the coordinate as real text — the point of the figure, and indexable
		$o .= '<text x="14" y="' . ( $h - 14 ) . '" fill="#8fa3b8" font-size="12">'
			. esc_html( number_format( abs( $lat ), 2 ) . ( $lat >= 0 ? '°N ' : '°S ' )
				. number_format( abs( $lon ), 2 ) . ( $lon >= 0 ? '°E' : '°W' ) ) . '</text>';
		return $o . '</svg>';
	}

	/**
	 * THE RIGHT PICTURE FOR THE INSTRUMENT — the registry names it.
	 *
	 * Seismic pages rendered NOTHING: extent_svg() needs the frozen pixel record and a seismic
	 * solution has none, so every quake page was a headline, a table and blank space. The first fix
	 * for that branched on 'quake' and fell through to extent_svg — which is not a default, it is
	 * THERMAL's renderer applied to whatever else arrives. Four of six detectors kept drawing
	 * nothing, silently, with no marker that they did.
	 *
	 * So the renderer sits in DETECTORS beside the detector that owns it, exactly as `fn` already
	 * does. An empty `svg` is a DECLARED absence a reader can grep for, and the next detector author
	 * meets an empty slot and a decision rather than inheriting a blank page.
	 */
	public static function detection_svg( $ev ) {
		$fn = (string) ( self::DETECTORS[ (string) ( $ev['detector'] ?? '' ) ]['svg'] ?? '' );
		return ( '' !== $fn && method_exists( __CLASS__, $fn ) ) ? self::$fn( $ev ) : '';
	}

	/**
	 * A DEPTH CROSS-SECTION of a seismic solution: the surface, and the hypocentre beneath it at the
	 * measured depth, sized by magnitude.
	 *
	 * WHAT IT DELIBERATELY DOES NOT DRAW: any circle around the epicentre. A shaking or damage radius
	 * is MODELLED, not measured — it needs ground conditions, attenuation and a magnitude-distance
	 * relation this platform has not computed. Drawing one would put a fabricated quantity on the
	 * page, which is the same line the thermal view holds when it refuses to call its extent a blast
	 * radius. Depth and magnitude are measured; that is what appears.
	 */
	private static function seismic_svg( $ev, $w = 640, $h = 340 ) {
		$mag = (float) ( $ev['severity'] ?? 0 );
		if ( $mag <= 0 ) { return ''; }
		$meta = json_decode( (string) ( $ev['measures'] ?? '' ), true );
		$meas = (array) ( $meta['measures'] ?? [] );
		// Depth is a measured column on the solution; parse it rather than guessing. WITHOUT IT THERE
		// IS NO FIGURE: $depth defaulting to 0 would plant the hypocentre exactly on the surface line
		// and label it '0.0 km deep' — a fabricated measurement on a page whose entire discipline is
		// drawing only what was measured. A renderer must own its own preconditions.
		$depth = 0.0;
		if ( preg_match( '/([0-9]+(?:\.[0-9]+)?)/', (string) ( $meas['Depth'] ?? '' ), $dm ) ) { $depth = (float) $dm[1]; }
		if ( $depth <= 0 ) { return ''; }
		// Named for WHAT IT ESCAPES. extent_svg() below binds $esc to esc_attr(), so a line copied
		// between these two builders would silently change escaping context.
		$txt = static fn( $x ) => esc_html( (string) $x );
		// Scale: show at least 60 km of crust, or 1.3x the hypocentre, so a deep event still fits.
		$span   = max( 60.0, $depth * 1.3 );
		$surf   = 62.0;                       // y of the surface line
		$floor  = $h - 54.0;                  // y of the deepest gridline
		$ykm    = static fn( $km ) => $surf + ( $floor - $surf ) * ( $km / $span );
		$cx     = $w / 2;
		$cy     = round( $ykm( $depth ), 1 );
		// Marker area tracks RADIATED ENERGY, which rises ~10^1.5 per magnitude unit — so the dot
		// grows the way the energy does, not the way the number does.
		$r      = round( max( 5.0, min( 34.0, 3.2 * pow( 10, 0.25 * ( $mag - 3.0 ) ) ) ), 1 );
		$o  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $w . ' ' . $h . '" role="img" '
			. 'font-family="system-ui,sans-serif" '
			. 'aria-label="' . esc_attr( 'Depth cross-section: M' . number_format( $mag, 1 )
				. ' at ' . number_format( $depth, 1 ) . ' km depth' ) . '" '
			. 'style="width:100%;height:auto;background:#06121E;border-radius:10px">';
		$o .= '<title>' . $txt( (string) ( $ev['headline'] ?? 'Seismic event' ) ) . '</title>';
		$o .= '<desc>' . $txt( 'Cross-section through the crust. The marker is the hypocentre at its '
			. 'measured depth, sized by magnitude. No shaking or damage radius is drawn: that would be '
			. 'modelled, not measured.' ) . '</desc>';
		// depth gridlines, labelled — the numbers are the point of the figure
		$step = $span > 240 ? 100 : ( $span > 120 ? 50 : ( $span > 60 ? 25 : 10 ) );
		for ( $d = $step; $d <= $span; $d += $step ) {
			$y = round( $ykm( $d ), 1 );
			$o .= '<line x1="58" y1="' . $y . '" x2="' . ( $w - 18 ) . '" y2="' . $y . '" stroke="#22354a" stroke-width="1"/>'
				. '<text x="50" y="' . ( $y + 4 ) . '" fill="#8fa3b8" font-size="11" text-anchor="end" '
				. '>' . (int) $d . ' km</text>';
		}
		// the surface
		$o .= '<line x1="58" y1="' . $surf . '" x2="' . ( $w - 18 ) . '" y2="' . $surf . '" stroke="#E8B923" stroke-width="2"/>'
			. '<text x="58" y="' . ( $surf - 10 ) . '" fill="#E8B923" font-size="12" '
			. '>surface</text>';
		// epicentre tick on the surface, and the vertical to the hypocentre
		$o .= '<line x1="' . $cx . '" y1="' . ( $surf - 7 ) . '" x2="' . $cx . '" y2="' . $cy
			. '" stroke="#1746DC" stroke-width="1.4" stroke-dasharray="4 4"/>';
		// the hypocentre, pulsing once per cycle so it reads as an event rather than a dot
		$o .= '<circle cx="' . $cx . '" cy="' . $cy . '" r="' . $r . '" fill="#E8B923" opacity=".28">'
			. '<animate attributeName="r" values="' . $r . ';' . round( $r * 1.9, 1 ) . ';' . $r
			. '" dur="2.6s" repeatCount="indefinite"/>'
			. '<animate attributeName="opacity" values=".28;0;.28" dur="2.6s" repeatCount="indefinite"/></circle>';
		$o .= '<circle cx="' . $cx . '" cy="' . $cy . '" r="' . round( max( 4.0, $r * 0.42 ), 1 )
			. '" fill="#E8B923" stroke="#06121E" stroke-width="1.5"/>';
		// the measurements, as real text
		$o .= '<text x="' . ( $cx + $r + 14 ) . '" y="' . ( $cy + 5 ) . '" fill="#e9eef5" '
			. 'font-size="14">M' . number_format( $mag, 1 )
			. ' · ' . number_format( $depth, 1 ) . ' km deep</text>';
		$foot = trim( (string) ( $meas['Network region'] ?? '' ) );
		if ( '' !== $foot ) {
			$o .= '<text x="20" y="' . ( $h - 18 ) . '" fill="#8fa3b8" font-size="12" '
				. '>' . $txt( mb_substr( $foot, 0, 68 ) ) . '</text>';
		}
		$felt = (int) ( $meas['Felt reports'] ?? 0 );
		if ( $felt > 0 ) {
			$o .= '<text x="' . ( $w - 18 ) . '" y="' . ( $h - 18 ) . '" fill="#8fa3b8" font-size="12" '
				. 'text-anchor="end">' . (int) $felt
				. ' felt report' . ( 1 === $felt ? '' : 's' ) . '</text>';
		}
		return $o . '</svg>';
	}

	/**
	 * INLINE ANIMATED SVG of the detection — the measured radiant extent over time and space.
	 *
	 * SVG rather than a raster because this is a NEWS page: the markup IS the visualisation, so a
	 * crawler reads coordinates, timestamps and power values as text instead of an opaque image, and
	 * it renders with no request, no script and no layout shift.
	 *
	 * It animates with SMIL (<animate>) keyed to the real acquisition times, so the circle grows only
	 * when the instrument actually saw it grow. It is NOT a blast radius and the caption says so: a
	 * radiometer records where heat was radiating, not a shock front, and nothing here establishes
	 * that anything exploded.
	 */
	private static function extent_svg( $ev, $w = 640, $h = 460 ) {
		$px = json_decode( (string) ( $ev['pixels'] ?? '[]' ), true );
		if ( ! is_array( $px ) || ! $px ) { return ''; }
		// [ lat, lon, frp, ts, sat ]
		$times = [];
		foreach ( $px as $p ) { $times[ (int) ( $p[3] ?? 0 ) ] = true; }
		$times = array_keys( $times ); sort( $times );
		if ( ! $times ) { return ''; }
		$las = array_column( $px, 0 ); $los = array_column( $px, 1 );
		$la0 = min( $las ); $la1 = max( $las ); $lo0 = min( $los ); $lo1 = max( $los );
		$pad = max( 0.01, ( $la1 - $la0 ) * 0.3, ( $lo1 - $lo0 ) * 0.3 );
		$la0 -= $pad; $la1 += $pad; $lo0 -= $pad; $lo1 += $pad;
		$sx = static fn( $lon ) => ( $lo1 - $lo0 ) > 0 ? ( ( $lon - $lo0 ) / ( $lo1 - $lo0 ) ) * $w : $w / 2;
		$sy = static fn( $lat ) => ( $la1 - $la0 ) > 0 ? $h - ( ( $lat - $la0 ) / ( $la1 - $la0 ) ) * $h : $h / 2;
		// Per-frame: power-weighted centre, extent to the furthest pixel, total power.
		$frames = [];
		foreach ( $times as $t ) {
			$f = array_values( array_filter( $px, static fn( $p ) => (int) ( $p[3] ?? 0 ) === $t ) );
			$wt = 0.0; $cla = 0.0; $clo = 0.0;
			foreach ( $f as $p ) { $wt += (float) $p[2]; $cla += (float) $p[0] * (float) $p[2]; $clo += (float) $p[1] * (float) $p[2]; }
			if ( $wt <= 0 ) { continue; }
			$cla /= $wt; $clo /= $wt;
			$rad = 0.0;
			foreach ( $f as $p ) { $rad = max( $rad, self::km( $cla, $clo, (float) $p[0], (float) $p[1] ) ); }
			$frames[] = [ 'ts' => $t, 'lat' => $cla, 'lon' => $clo, 'km' => $rad, 'mw' => $wt, 'n' => count( $f ), 'px' => $f ];
		}
		if ( ! $frames ) { return ''; }
		$dur  = max( 2, count( $frames ) ) * 1.4;
		$keys = [];
		foreach ( $frames as $i => $_ ) { $keys[] = round( $i / max( 1, count( $frames ) - 1 ), 4 ); }
		$kt = implode( ';', $keys );
		// degrees-per-km at this latitude, so the circle is drawn to scale
		$dpk = 1 / 111.0;
		$cxs = []; $cys = []; $rs = [];
		foreach ( $frames as $f ) {
			$cxs[] = round( $sx( $f['lon'] ), 1 );
			$cys[] = round( $sy( $f['lat'] ), 1 );
			$rpx   = ( $lo1 - $lo0 ) > 0 ? ( $f['km'] * $dpk / ( $lo1 - $lo0 ) ) * $w : 4;
			$rs[]  = round( max( 3, $rpx ), 1 );
		}
		$esc = static fn( $x ) => esc_attr( (string) $x );
		$o  = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' . $w . ' ' . $h . '" role="img" '
			. 'aria-label="' . $esc( 'Measured radiant extent over ' . count( $frames ) . ' satellite passes' ) . '" '
			. 'style="width:100%;height:auto;background:#06121E;border-radius:10px">';
		$o .= '<title>' . esc_html( (string) $ev['headline'] ) . '</title>';
		$o .= '<desc>' . esc_html( 'Each hot pixel the instrument recorded, with the power-weighted centre and '
			. 'the distance to the furthest pixel at each pass. An observed extent, not a blast radius.' ) . '</desc>';
		// every pixel, faint — the full record stays visible under the animation
		foreach ( $px as $p ) {
			$o .= '<circle cx="' . round( $sx( (float) $p[1] ), 1 ) . '" cy="' . round( $sy( (float) $p[0] ), 1 )
				. '" r="2" fill="#26384d"/>';
		}
		// the active pass
		foreach ( $frames as $i => $f ) {
			$vis = array_fill( 0, count( $frames ), '0' ); $vis[ $i ] = '1';
			foreach ( $f['px'] as $p ) {
				$r = max( 2.5, min( 11, 2.5 + 0.5 * sqrt( max( 0.0, (float) $p[2] ) ) ) );
				$o .= '<circle cx="' . round( $sx( (float) $p[1] ), 1 ) . '" cy="' . round( $sy( (float) $p[0] ), 1 )
					. '" r="' . $r . '" fill="#E8B923" opacity="0">'
					. '<animate attributeName="opacity" values="' . implode( ';', $vis ) . '" keyTimes="' . $kt
					. '" dur="' . $dur . 's" repeatCount="indefinite" calcMode="discrete"/></circle>';
			}
		}
		// the measured extent circle, growing with the real observations
		$o .= '<circle fill="none" stroke="#E8B923" stroke-width="1.6" stroke-dasharray="5 4" opacity=".9">'
			. '<animate attributeName="cx" values="' . implode( ';', $cxs ) . '" keyTimes="' . $kt . '" dur="' . $dur . 's" repeatCount="indefinite"/>'
			. '<animate attributeName="cy" values="' . implode( ';', $cys ) . '" keyTimes="' . $kt . '" dur="' . $dur . 's" repeatCount="indefinite"/>'
			. '<animate attributeName="r"  values="' . implode( ';', $rs )  . '" keyTimes="' . $kt . '" dur="' . $dur . 's" repeatCount="indefinite"/></circle>';
		// per-pass caption — real text, so it is indexable and readable without the animation
		foreach ( $frames as $i => $f ) {
			$vis = array_fill( 0, count( $frames ), '0' ); $vis[ $i ] = '1';
			$lbl = gmdate( 'Y-m-d H:i', (int) $f['ts'] ) . ' UTC · ' . number_format( $f['mw'], 0 ) . ' MW · extent '
				. number_format( $f['km'], 2 ) . ' km · ' . (int) $f['n'] . ' pixels';
			$o .= '<text x="12" y="' . ( $h - 14 ) . '" fill="#e9eef5" font-size="13" '
				. 'font-family="system-ui,sans-serif" opacity="0">' . esc_html( $lbl )
				. '<animate attributeName="opacity" values="' . implode( ';', $vis ) . '" keyTimes="' . $kt
				. '" dur="' . $dur . 's" repeatCount="indefinite" calcMode="discrete"/></text>';
		}
		return $o . '</svg>';
	}

	// ── detectors ─────────────────────────────────────────────────────────────────────────────

	/** FIRMS VIIRS → clustered high-energy thermal anomalies, chronic industrial sources removed. */
	public static function detect_thermal() {
		$now    = time();
		$hot    = [];
		$census = [];   // cell|acq_date → peak FRP seen this pass (see census_record)
		$feeds  = 0;
		// Both orbiters feed ONE hot set and ONE census. Clustering afterwards merges any pixel the two
		// satellites both saw, so double coverage improves timing without double-counting an event.
		foreach ( self::FIRMS_FEEDS as $feed ) {
			$csv = self::fetch( $feed[1], 45 );
			if ( '' === $csv ) { Extra::src_health( 'news:thermal:' . $feed[0], false, 0, 0, 'empty' ); continue; }
			$feeds++;
			$head = null;
			// Stream the ~9 MB file, keeping ONLY pixels over their region's floor — the filter runs on
			// the line, so peak memory stays in kilobytes rather than holding 200k rows.
			foreach ( explode( "\n", $csv ) as $line ) {
				$line = trim( $line );
				if ( '' === $line ) { continue; }
				$f = explode( ',', $line );
				if ( null === $head ) { $head = array_flip( $f ); continue; }
				$frp = (float) ( $f[ $head['frp'] ?? 12 ] ?? 0 );
				$lat = (float) ( $f[ $head['latitude'] ?? 0 ] ?? 0 );
				$lon = (float) ( $f[ $head['longitude'] ?? 1 ] ?? 0 );
				// CENSUS FIRST, threshold second: a flare that idles at 4 MW must still be LEARNED, or the
				// night it spikes it looks like a brand-new event. This is why the census cannot be fed
				// from the post-threshold list — and it matters most in Iran and Iraq, where most of the
				// thermal pixels in the whole watchlist are gas flares.
				$plat = round( $lat, 2 );
				$plon = round( $lon, 2 );
				if ( $plat || $plon ) {
					$ckey = $plat . ',' . $plon . '|' . substr( (string) ( $f[ $head['acq_date'] ?? 5 ] ?? '' ), 0, 10 );
					if ( ! isset( $census[ $ckey ] ) || $census[ $ckey ] < $frp ) { $census[ $ckey ] = $frp; }
				}
				// The floor is REGIONAL. 80 MW is wildfire scale and made the detector blind to every
				// conflict zone on the watchlist; 15 MW inside a watched box is building/vehicle scale.
				// A DETECTION TRIGGER, NOT A TERM IN THE REPORTED QUANTITY. This floor used to be applied
				// per pixel BEFORE clustering, so the published "total" was summed from 15 MW upward inside a
				// watch box and from 80 MW upward elsewhere — the same physical fire measured under two
				// different definitions, both fed into one global ranking. The published standard sums over
				// ALL detected fire pixels (Wooster et al. 2005, doi:10.1029/2005JD006318, Fig. 18). Now every
				// detected pixel enters the cluster and the floor is tested against the CLUSTER's peak power,
				// so the quantity means the same thing everywhere.
				$watched = self::in_watch_box( $lat, $lon );
				if ( $frp < self::PIXEL_KEEP ) { continue; } // noise floor only — keeps the sum honest
				$conf = strtolower( (string) ( $f[ $head['confidence'] ?? 8 ] ?? '' ) );
				if ( 'l' === $conf || 'low' === $conf ) { continue; }
				if ( ! $lat && ! $lon ) { continue; }
				$hot[] = [
					'lat' => $lat, 'lon' => $lon, 'frp' => $frp, 'watch' => $watched,
					'ti4' => (float) ( $f[ $head['bright_ti4'] ?? 2 ] ?? 0 ),
					'ts'  => self::firms_ts( (string) ( $f[ $head['acq_date'] ?? 5 ] ?? '' ), (string) ( $f[ $head['acq_time'] ?? 6 ] ?? '' ) ),
					'dn'  => (string) ( $f[ $head['daynight'] ?? 13 ] ?? '' ),
					'sat' => $feed[0],
				];
			}
		}
		if ( ! $feeds || ! $hot ) { return []; }

		// cluster() is O(n²). On a severe fire day the hot set can run to tens of thousands of pixels,
		// which would consume the whole tick and starve the detectors queued behind this one. Bound it
		// to the most energetic pixels — and record the cap, because a silent truncation would read
		// downstream as "this is everything that burned today".
		if ( count( $hot ) > self::MAX_HOT ) {
			// Watched-region pixels are never the ones dropped: they are low-FRP by nature, so a plain
			// sort by energy would discard exactly the conflict signal this cap is meant to protect.
			usort( $hot, static fn( $a, $b ) => ( ( $b['watch'] ? 1e9 : 0 ) + $b['frp'] ) <=> ( ( $a['watch'] ? 1e9 : 0 ) + $a['frp'] ) );
			$dropped = count( $hot ) - self::MAX_HOT;
			$hot     = array_slice( $hot, 0, self::MAX_HOT );
			Extra::src_health( 'news:thermal', true, 0, 0, 'hot-pixel cap: ' . $dropped . ' weakest unwatched pixels not clustered' );
		}

		self::census_record( $census ); // race-free, batched, keyed on each pixel's own acq_date

		$clusters = self::cluster( $hot, self::CLUSTER_KM );
		$out      = [];
		foreach ( $clusters as $ci => $c ) {
			// Test EVERY cell the cluster covers, not just the centroid: a 0.01° cell is ~1.1 km and a
			// cluster spans several, so a chronic flare one cell off the centroid slipped through as news.
			$days = self::census_days_max( $c['cells'] ?? [ round( $c['lat'], 2 ) . ',' . round( $c['lon'], 2 ) ] );
			if ( $days >= self::PERSIST_DAYS ) { continue; } // chronic industrial heat → never news
			// The newsworthiness floor now applies to the CLUSTER's peak power — one definition of the
			// reported quantity everywhere, with only the trigger varying by region.
			$w_box = self::in_watch_box( $c['lat'], $c['lon'] );
			if ( $c['frp'] < ( $w_box ? self::FRP_MIN_WATCH : self::FRP_MIN ) ) { continue; }

			$watched = self::in_watch_box( $c['lat'], $c['lon'] );
			$span_km = $c['span'];
			$kind    = ( $c['n'] >= 12 || $span_km > 6.0 ) ? 'wildfire' : 'thermal anomaly';
			// A wildfire front is also compact and energetic, so FRP alone selected ~60 fire fronts a day
			// into the high-intensity tier. The distinguishing evidence is ISOLATION (nothing else burning
			// nearby) plus NO history at the location — a blast appears where nothing was burning.
			$isolated = self::isolated( $clusters, $c, self::ISOLATION_KM, $ci );
			$strong   = $watched ? self::FRP_STRONG_WATCH : self::FRP_STRONG;
			$intense  = ( 'thermal anomaly' === $kind && $c['frp'] >= $strong && $isolated && $days <= 1 );
			$out[] = [
				// Location-only key: a fire burning across 00:00 UTC is ONE event, not two. Re-detection
				// updates the existing row (see ingest) instead of minting a second page.
				'ekey'       => 'v' . round( $c['lat'], 2 ) . '_' . round( $c['lon'], 2 ),
				'ts'         => $c['ts'],
				'lat'        => $c['lat'],
				'lon'        => $c['lon'],
				'severity'   => $c['frp'],
				'energy'     => self::fire_energy( $c['series'] ?? [] ),
				'px'         => $c['px'] ?? [],
				// Ranking, never rendered: without this, twelve large wildfires fill every tick and the
				// isolated high-intensity anomaly — the whole point of the detector — never publishes.
				// The WATCHED-region bonus is NOT applied here: WATCH_BOX is deliberately generous and
				// overlaps neighbours (the Iran box covers southern Turkmenistan, the Ukraine box covers
				// Moldova), which promoted Turkmen gas flares above Syrian and Iraqi events. ingest() adds
				// it instead, from the GEOCODED country — the only place the true country is known.
				'rank'       => $c['frp'] + ( $intense ? 1000000.0 : 0 ),
				'confidence' => $intense ? 'high' : ( $c['n'] >= 3 ? 'medium' : 'low' ),
				'kind'       => $intense ? 'high-intensity thermal anomaly' : $kind,
				'measures'   => [
					'Fire radiative power (peak overpass)' => round( $c['frp'], 1 ) . ' MW across '
						. (int) ( $c['peak_n'] ?? 0 ) . ' pixels at ' . gmdate( 'Y-m-d H:i', (int) $c['ts'] ) . ' UTC'
						. ' — seen ' . (int) ( $c['looks'] ?? 1 ) . ' time(s) in 24 h. FRP is the RADIATED power a'
						. ' satellite detects, not the fire\'s total heat output; calibration puts the radiated share'
						. ' near 14±3% of available heat yield (Wooster et al. 2005, doi:10.1029/2005JD006318)',
					'Energy released (observed)'  => self::energy_label( self::fire_energy( $c['series'] ?? [] ) ),
					// The I-4 band SATURATES near 367 K, so at the intensities this detector selects for the
					// value is a FLOOR, not a peak. Calling it a temperature overstates what the sensor can see.
					// NOT a fire temperature. NASA's own algorithm document concludes "sub-pixel fire
					// characterization should be avoided in that channel" (VIIRS 375 m Active Fire ATBD v1.0,
					// Dec 2016, sec 2.2), and FRP is retrieved from M13 instead — so this is reported as a
					// channel reading, with its ceiling, and nothing is inferred from it.
					'I-4 channel reading' => ( $c['ti4'] >= self::TI4_SAT
						? 'at the ' . self::TI4_SAT . ' K channel ceiling (saturated — not a fire temperature)'
						: round( $c['ti4'], 1 ) . ' K (I-4 band; not a fire temperature)' ),
					'Hot pixels detected'        => $c['n'],
					'Cluster extent'             => round( $span_km, 1 ) . ' km',
					'Overpass'                   => gmdate( 'Y-m-d H:i', $c['ts'] ) . ' UTC (' . ( 'D' === $c['dn'] ? 'day' : 'night' ) . ')',
					'Satellites'                 => implode( ' + ', $c['sats'] ?? [] ),
					'Prior detections here'      => max( 0, $days - 1 ) . ' acquisition(s) previously observed hot',
					'Seismic event nearby'       => self::seismic_near( $c['lat'], $c['lon'], $c['ts'] ) ?: 'none recorded',
				],
				'source'     => [ 'name' => 'NASA FIRMS · VIIRS 375 m active fire (NRT), S-NPP + NOAA-20',
					'url' => self::FIRMS_FEEDS[0][1], 'retrieved' => $now ],
			];
		}
		return $out;
	}

	/** Is this coordinate inside a watched conflict box? Thresholding only — never a label. */
	private static function in_watch_box( $lat, $lon ) {
		foreach ( self::WATCH_BOX as $b ) {
			if ( $lat >= $b[0] && $lat <= $b[1] && $lon >= $b[2] && $lon <= $b[3] ) { return true; }
		}
		return false;
	}

	/** Upsert this pass's cells: one atomic statement per cell, so concurrent ticks cannot clobber
	 *  each other the way the old shared option blob did. `days` only increments on a NEW UTC day. */
	private static function census_record( $census ) {
		global $wpdb;
		$t = Data::t( 'aq_news_cells' );
		// One statement per cell meant ~99,000 round-trips per tick over ~50,000 cells. Same result,
		// batched: read which cells exist, insert the new ones in bulk, then one guarded UPDATE per
		// (date, chunk). The `last_day <> date` guard still makes a re-run idempotent.
		$by_day = [];
		foreach ( $census as $k => $frp ) {
			$parts = explode( '|', (string) $k );
			$cell  = $parts[0];
			$day   = $parts[1] ?? '';
			if ( '' === $cell || '' === $day ) { continue; }
			$by_day[ $day ][ $cell ] = (float) $frp;
		}
		foreach ( $by_day as $day => $cells ) {
			$all = array_keys( $cells );
			foreach ( array_chunk( $all, 500 ) as $chunk ) {
				$ph    = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
				$have  = $wpdb->get_col( $wpdb->prepare( "SELECT cell FROM {$t} WHERE cell IN ({$ph})", $chunk ) );
				$fresh = array_values( array_diff( $chunk, (array) $have ) );
				if ( $fresh ) {
					$vals = []; $args = []; $seen = time();
					foreach ( $fresh as $c ) {
						$vals[] = '(%s, 0, %s, %d, %f)';
						array_push( $args, $c, '', $seen, (float) $cells[ $c ] );
					}
					$wpdb->query( $wpdb->prepare(
						"INSERT INTO {$t} (cell, days, last_day, first_seen, peak_frp) VALUES " . implode( ',', $vals ), $args ) );
				}
				// Count the day once per cell — the guard is what makes repeated ticks idempotent.
				$wpdb->query( $wpdb->prepare(
					"UPDATE {$t} SET days = days + 1, last_day = %s WHERE last_day <> %s AND cell IN ({$ph})",
					array_merge( [ $day, $day ], $chunk ) ) );
			}
			// peak_frp only matters for cells that are actually energetic; keep it exact for those.
			foreach ( $cells as $c => $frp ) {
				if ( $frp < self::FRP_MIN ) { continue; }
				$wpdb->query( $wpdb->prepare(
					"UPDATE {$t} SET peak_frp = %f WHERE cell = %s AND peak_frp < %f", (float) $frp, $c, (float) $frp ) );
			}
		}
		// Bound the table: a cell no instrument has seen in a season is not evidence about today.
		$wpdb->query( $wpdb->prepare(
			"DELETE FROM {$t} WHERE last_day <> '' AND last_day < %s", gmdate( 'Y-m-d', time() - self::CENSUS_TTL ) ) );
	}

	/** How many distinct days this cell has ever been seen radiating. */
	private static function census_days( $cell ) {
		return (int) Data::col( 'SELECT days FROM ' . Data::t( 'aq_news_cells' ) . ' WHERE cell = %s', [ $cell ] );
	}

	/**
	 * SEISMIC MONITORS — two independent networks (operator 2026-07-25: "it should also use seismic
	 * monitor APIs"). USGS ANSS is authoritative for the Americas; EMSC (seismicportal.eu) has far
	 * denser Europe/Middle East/Asia coverage. Both keyless, both FDSN-standard.
	 *
	 * WHY THIS MATTERS FOR THE EXPLOSION BRIEF: a seismic network does not merely record shaking —
	 * analysts CLASSIFY each solution, and the catalogue carries `type` = earthquake | explosion |
	 * quarry blast | mining explosion | nuclear explosion. That is a human-verified, objective
	 * identification of a blast, which no thermal pixel can give. Verified live 2026-07-25: the USGS
	 * catalogue held 2 events typed `explosion` in the previous 30 days. So an explosion reaches this
	 * platform two ways — seismically confirmed here, or radiantly detected by FIRMS — and when both
	 * fire within CORROBORATE_KM/CORROBORATE_S of each other the report says so explicitly.
	 */
	const WATCH_RANK_BONUS = 100000.0; // a watchlist country outranks raw energy — it is low-FRP by nature
	const OUTAGE_ABS       = 2.0;  // traffic fraction below this = collapse (empirically bimodal)
	const NETLOSS_MIN_BASE = 10.0; // below this the outage ratio is noise, not a measurement
	const FRESH_S        = 172800; // 48 h — older than this is history, not news
	const CORROBORATE_KM = 60.0;   // a seismic solution this close to a thermal anomaly corroborates it
	const CORROBORATE_S  = 7200;   // …within this many seconds

	public static function detect_quake() {
		$now = time();
		$out = [];

		// 1. USGS ANSS — everything M2.5+ in the past day, so NON-earthquake types (explosions,
		//    quarry/mining blasts) are caught at magnitudes far below the damage threshold.
		// all_day, not 2.5_day: quarry/mining blasts are catalogued well below M2.5, and they are the
		// one source that CLASSIFIES an explosion rather than inferring it. The QUAKE_MIN_MAG
		// earthquake floor below still applies — this only stops the feed itself from discarding
		// the blasts first.
		$uurl = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
		$body = json_decode( self::fetch( $uurl, 20 ), true );
		foreach ( (array) ( $body['features'] ?? [] ) as $f ) {
			$p    = is_array( $f['properties'] ?? null ) ? $f['properties'] : [];
			$g    = (array) ( $f['geometry']['coordinates'] ?? [] );
			$mag  = (float) ( $p['mag'] ?? 0 );
			$type = strtolower( (string) ( $p['type'] ?? 'earthquake' ) );
			$blast = ( false !== strpos( $type, 'explosion' ) || false !== strpos( $type, 'blast' ) );
			// Earthquakes need QUAKE_MIN_MAG to be newsworthy; a seismically CONFIRMED explosion is
			// news at any recorded size, because the classification itself is the story.
			if ( ! $blast && $mag < self::QUAKE_MIN_MAG ) { continue; }
			// BLAST NEWSWORTHINESS IS CONTEXTUAL, NOT A MAGNITUDE FLOOR. Verified against the live USGS
			// catalogue 2026-07-26: all 44 blasts classified in the past week were M0.18–M1.77, so ANY
			// floor at M2.5 silently deletes this entire feature — the one instrument that CLASSIFIES a
			// blast instead of inferring it. What separates news from routine is where and what type:
			//   · a quarry/mining shot in an industrial region is routine at any size
			//   · the same signature inside a WATCH country is precisely the signal this platform exists for
			//   · a plain 'explosion' classification is rarer and matters at a lower magnitude
			if ( $blast ) {
				$where   = self::nearest_place( (float) ( $g[1] ?? 0 ), (float) ( $g[0] ?? 0 ) );
				$watched = in_array( $where['country'], self::WATCH, true );
				if ( $mag < ( $watched ? 0.0 : self::BLAST_MIN_MAG ) ) { continue; }
			}
			if ( (int) ( ( $p['time'] ?? 0 ) / 1000 ) < $now - self::FRESH_S ) { continue; } // news, not archaeology
			$out[] = [
				'ekey'       => (string) ( $f['id'] ?? '' ),
				'ts'         => (int) ( ( $p['time'] ?? 0 ) / 1000 ),
				'lat'        => (float) ( $g[1] ?? 0 ),
				'lon'        => (float) ( $g[0] ?? 0 ),
				'severity'   => $mag,                             // THE MEASUREMENT — this is what renders
				'rank'       => $blast ? max( 6.0, $mag ) : $mag, // queue ordering ONLY — never rendered
				'mag'        => $mag,
				'blast'      => $blast,
				'confidence' => 'high', // a located, analyst-reviewed solution is a measurement
				'kind'       => $blast ? 'seismically recorded explosion' : 'earthquake',
				'measures'   => [
					'Event type (network classification)' => (string) ( $p['type'] ?? 'earthquake' ),
					'Magnitude'    => 'M' . number_format( $mag, 1 ) . ' (' . (string) ( $p['magType'] ?? '' ) . ')',
					'Depth'        => round( (float) ( $g[2] ?? 0 ), 1 ) . ' km',
					'Origin time'  => gmdate( 'Y-m-d H:i', (int) ( ( $p['time'] ?? 0 ) / 1000 ) ) . ' UTC',
					'Network region' => (string) ( $p['place'] ?? '' ),
					'Tsunami flag' => ( (int) ( $p['tsunami'] ?? 0 ) ) ? 'yes' : 'no',
					'Felt reports' => (int) ( $p['felt'] ?? 0 ),
					'Reviewed'     => (string) ( $p['status'] ?? '' ),
				],
				'source'     => [ 'name' => 'USGS ANSS Comprehensive Catalog (all magnitudes, past day)', 'url' => $uurl, 'retrieved' => $now ],
			];
		}

		// 2. EMSC — the Euro-Med network, for the regions USGS covers thinly. Deduped against USGS
		//    by proximity so one earthquake never becomes two stories.
		// A time bound is mandatory: without `start` this endpoint returns its whole recent catalogue,
		// so month-old quakes arrive on every tick, outrank today's events and publish as news.
		//
		// FETCH AT THE LOWEST FLOOR ANY ROW COULD QUALIFY UNDER — the per-type floors below decide
		// what is kept. This leg asked the endpoint for M5.5+, which is the EARTHQUAKE floor, so a
		// classified explosion between M4.0 and M5.5 — newsworthy under BLAST_MIN_MAG, and inside a
		// watched region newsworthy at any size at all — could never even be fetched to be judged.
		// A request threshold silently outranks every rule downstream of it: whatever is not asked
		// for cannot be filtered, corroborated or published, and nothing reports the absence.
		// Measured against the live catalogue on 2026-08-09 over this same 48 h window, EMSC at
		// M5.5 returned ZERO events (USGS's largest that day was M5.3, and the endpoint answered
		// 204 No Content); at M4.0 it returned 82, of which 19 were events USGS did not have.
		$eurl = 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=500&minmag='
			. rawurlencode( (string) self::BLAST_MIN_MAG )
			. '&start=' . gmdate( 'Y-m-d\TH:i:s', $now - self::FRESH_S );
		$emsc = json_decode( self::fetch( $eurl, 20 ), true );
		foreach ( (array) ( $emsc['features'] ?? [] ) as $f ) {
			$p   = is_array( $f['properties'] ?? null ) ? $f['properties'] : [];
			$mag = (float) ( $p['mag'] ?? 0 );
			$lat = (float) ( $p['lat'] ?? 0 );
			$lon = (float) ( $p['lon'] ?? 0 );
			$ts  = strtotime( (string) ( $p['time'] ?? '' ) ) ?: $now;
			if ( ! $lat && ! $lon ) { continue; }
			// EMSC CLASSIFIES EXPLOSIONS TOO, and this leg was throwing that away — every row it
			// produced was hard-coded `'blast' => false`, `'kind' => 'earthquake'`, so a catalogued
			// mine or nuclear shot would have been recorded as an ordinary earthquake by the one
			// source type this platform calls "a human-verified, objective identification of a
			// blast, which no thermal pixel can give". EMSC's `evtype` follows the FDSN convention:
			// a leading k (known) or s (suspected), then the class — m mine, x experimental,
			// n nuclear. Nothing else counts as an explosion; ke/se are earthquakes and kr/sr are
			// rockslides. Measured over 30 days EMSC classified no explosion at all (1,991 of 2,000
			// events were plain `ke`) while USGS classified 242 — so this changes nothing today and
			// is exactly why it was easy to get wrong and never notice.
			$evtype = strtolower( (string) ( $p['evtype'] ?? 'ke' ) );
			$eblast = in_array( $evtype, [ 'km', 'sm', 'kx', 'sx', 'kn', 'sn' ], true );
			// Mirror the USGS leg exactly: an ordinary earthquake needs QUAKE_MIN_MAG worldwide; a
			// classified explosion needs BLAST_MIN_MAG, and nothing at all inside a watched box,
			// where a small blast is precisely the signal. Reading both floors from the constants
			// instead of repeating a literal is what let this leg drift 1.5 magnitudes in the first
			// place. A small earthquake in a watched region is an earthquake, not an attack, so the
			// watch-box exemption deliberately applies to blasts only.
			if ( $eblast ) {
				if ( $mag < ( self::in_watch_box( $lat, $lon ) ? 0.0 : self::BLAST_MIN_MAG ) ) { continue; }
			} elseif ( $mag < self::QUAKE_MIN_MAG ) { continue; }
			$dupe = false;
			foreach ( $out as $o ) {
				if ( abs( $o['ts'] - $ts ) < 180 && self::km( $o['lat'], $o['lon'], $lat, $lon ) < 150 ) { $dupe = true; break; }
			}
			if ( $dupe ) { continue; }
			$out[] = [
				'ekey'       => 'emsc_' . (string) ( $p['unid'] ?? ( $ts . '_' . round( $lat, 2 ) ) ),
				'ts'         => $ts,
				'lat'        => $lat, 'lon' => $lon,
				'severity'   => $mag,                              // THE MEASUREMENT — this is what renders
				'rank'       => $eblast ? max( 6.0, $mag ) : $mag, // queue ordering ONLY — never rendered
				'mag'        => $mag,
				'blast'      => $eblast,
				'confidence' => 'high',
				'kind'       => $eblast ? 'seismically recorded explosion' : 'earthquake',
				'measures'   => [
					// The raw FDSN code is kept beside the expansion: it is what the network actually
					// published, and an unrecognised code must show itself rather than be flattened
					// into "earthquake" — which is how the classification got lost before.
					'Event type (network classification)' => self::emsc_evtype_label( $evtype ),
					'Magnitude'    => 'M' . number_format( $mag, 1 ) . ' (' . (string) ( $p['magtype'] ?? '' ) . ')',
					'Depth'        => round( (float) ( $p['depth'] ?? 0 ), 1 ) . ' km',
					'Origin time'  => gmdate( 'Y-m-d H:i', $ts ) . ' UTC',
					'Network region' => (string) ( $p['flynn_region'] ?? '' ),
				],
				'source'     => [ 'name' => 'EMSC · European-Mediterranean Seismological Centre (M'
					. number_format( self::QUAKE_MIN_MAG, 1 ) . '+ earthquakes, classified explosions from M'
					. number_format( self::BLAST_MIN_MAG, 1 ) . ' and from any size inside a watched region)',
					'url' => $eurl, 'retrieved' => $now ],
			];
		}
		return $out;
	}

	/**
	 * EMSC's `evtype` in words. The convention is FDSN's: a leading `k` (known) or `s` (suspected)
	 * followed by the class. An unknown code is returned AS THE RAW CODE rather than guessed at or
	 * flattened to "earthquake" — this field is a network's classification, and the one thing it
	 * must never do is quietly report a category the network did not assign.
	 */
	private static function emsc_evtype_label( $evtype ) {
		$class = [
			'e' => 'earthquake', 'm' => 'mine explosion', 'x' => 'experimental explosion',
			'n' => 'nuclear explosion', 'r' => 'rockslide', 'i' => 'induced event',
			'l' => 'landslide', 'v' => 'volcanic event',
		];
		$evtype = strtolower( (string) $evtype );
		if ( 2 !== strlen( $evtype ) || ! isset( $class[ $evtype[1] ] ) ) {
			return '' === $evtype ? 'not stated' : $evtype . ' (code not recognised)';
		}
		$known = 'k' === $evtype[0];
		if ( ! $known && 's' !== $evtype[0] ) { return $evtype . ' (code not recognised)'; }
		return ( $known ? '' : 'suspected ' ) . $class[ $evtype[1] ] . ' (' . $evtype . ')';
	}

	/**
	 * Cross-corroboration: does a seismic solution sit near this thermal anomaly in space and time?
	 * Heat plus ground motion at the same place and minute is the signature of a large blast, and is
	 * far stronger evidence than either instrument alone — so the finding is recorded as a MEASURED
	 * fact ("a seismic event was also recorded"), never as a claim about cause.
	 */
	private static function seismic_near( $lat, $lon, $ts ) {
		// Every candidate in the window must be distance-tested, not just the temporally nearest one:
		// Data::one() materialises a single row, so the old LIMIT 20 was dead code and a solution 20 km
		// away was thrown out unexamined while the page published "none recorded" as a measured fact.
		$rows = Data::all(
			'SELECT headline, severity, last_ts, lat, lon FROM ' . Data::t( 'aq_news_events' )
			. " WHERE detector = 'quake' AND ABS(last_ts - %d) < %d ORDER BY ABS(last_ts - %d) ASC LIMIT 50",
			[ (int) $ts, self::CORROBORATE_S, (int) $ts ] );
		$best = null; $bd = PHP_FLOAT_MAX;
		foreach ( (array) $rows as $row ) {
			$d = self::km( $lat, $lon, (float) $row['lat'], (float) $row['lon'] );
			if ( $d <= self::CORROBORATE_KM && $d < $bd ) { $bd = $d; $best = $row; }
		}
		if ( ! $best ) { return ''; }
		return 'yes — ' . $best['headline'] . ' recorded ' . round( $bd ) . ' km away within '
			. max( 1, (int) round( abs( (int) $best['last_ts'] - (int) $ts ) / 60 ) ) . ' min';
	}

	/**
	 * INTERNET CONNECTIVITY LOSS — IODA (Georgia Tech), keyless. Three independent planes: BGP
	 * (routes withdrawn from the global table), active probing (hosts stop answering), and darknet
	 * background traffic. A country-level loss is one of the earliest and least deniable signals of
	 * conflict escalation or a deliberate shutdown, and it is measured from OUTSIDE the country,
	 * so it cannot be suppressed locally.
	 *
	 * WHAT IT PROVES: networks stopped being reachable. It does NOT prove who switched them off,
	 * or why — a cut can be a strike, a cable fault, a power failure or a government order, and
	 * the data alone cannot separate those. The report says exactly that.
	 */
	public static function detect_netloss() {
		$from = time() - 2 * DAY_IN_SECONDS;
		// Ask the API for COUNTRY entities. Pulling a mixed 300 and filtering to countries in PHP
		// afterwards meant ~97% of national outage alerts never made it into the window at all.
		$url  = 'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=' . $from . '&until=' . time()
			. '&entityType=country&limit=300';
		$body = json_decode( self::fetch( $url, 20 ), true );
		$out  = [];
		$now  = time();
		foreach ( (array) ( $body['data'] ?? [] ) as $a ) {
			// Only COUNTRY-level losses are news; a single network dropping is routine internet weather.
			$ent = (array) ( $a['entity'] ?? [] );
			if ( 'country' !== (string) ( $ent['type'] ?? '' ) ) { continue; }
			if ( 'normal' === strtolower( (string) ( $a['level'] ?? '' ) ) ) { continue; } // recovery, not loss
			$cc   = strtoupper( (string) ( $ent['code'] ?? '' ) );
			$name = (string) ( $ent['name'] ?? $cc );
			$val  = (float) ( $a['value'] ?? 0 );
			$hist = (float) ( $a['historyValue'] ?? 0 );
			// A ratio off a tiny baseline is noise, not a blackout: 2 → 0 reads as a 100% "drop".
			if ( $hist < self::NETLOSS_MIN_BASE ) { continue; }
			$drop = ( 1 - ( $val / $hist ) ) * 100.0; // % below this country's OWN recent normal
			if ( $drop < ( isset( self::WATCH[ $cc ] ) ? 25.0 : 50.0 ) ) { continue; } // watchlist: lower bar
			$ts = (int) ( $a['time'] ?? $now );
			$out[] = [
				// A per-HOUR key turned one ongoing national blackout into a fresh page every hour. An outage
				// is one continuing event: re-detection must UPDATE it, never republish it.
				'ekey'       => 'net_' . $cc . '_' . (string) ( $a['datasource'] ?? '' ) . '_' . gmdate( 'Ymd', $ts ),
				'ts'         => $ts,
				// No coordinate is measured for a country-level outage, but the COUNTRY is — carry it, or the
				// page publishes an anonymous "Internet connectivity loss" pinned at 0,0 in the Gulf of Guinea.
				'lat'        => null, 'lon' => null,
				'place'      => '', 'country' => $name,
				'severity'   => $drop,                                            // THE MEASUREMENT: % below normal
				'rank'       => $drop + ( isset( self::WATCH[ $cc ] ) ? 25 : 0 ), // watchlist ranks higher
				'confidence' => 'high', // reachability is measured from outside; it is not an inference
				'kind'       => 'internet connectivity loss',
				'measures'   => [
					'Country'            => $name,
					'Connectivity drop'  => round( $drop ) . '% below this country\'s own recent normal',
					'Measurement plane'  => (string) ( $a['datasource'] ?? '' ) . ' (bgp = routes withdrawn from the global routing table; active-probing = hosts stopped answering; darknet = background traffic ceased)',
					// IODA's own level is NOT calibrated to the size of the drop — observed live, it labels a
					// 1.9% dip (9,760 vs 9,953) 'critical'. Printing that word beside our own measured percentage
					// lends the number an authority the source does not intend, so it ships as what it is: the
					// upstream classification, named as theirs.
					'IODA alert class'   => (string) ( $a['level'] ?? '' ) . ' (IODA\'s own label; not scaled to the drop)',
					'Observed'           => gmdate( 'Y-m-d H:i', $ts ) . ' UTC',
					'Measured value'     => round( $val, 2 ) . ' vs recent normal ' . round( $hist, 2 ),
				],
				'source'     => [ 'name' => 'IODA · Internet Outage Detection and Analysis (Georgia Tech)', 'url' => $url, 'retrieved' => $now ],
			];
		}
		return $out;
	}

	/**
	 * NATIONAL TRAFFIC COLLAPSE — Google Transparency Report traffic fraction.
	 *
	 * WHY THIS IS AN INSTRUMENT: it is the measured share of Google's global traffic originating
	 * from a country, counted at Google's edge — OUTSIDE the country. A state can switch its own
	 * networks off but cannot make traffic reappear at a foreign edge, so the measurement cannot be
	 * suppressed locally. Latency ~1.5-3 h, keyless: the fastest public instrument found for this.
	 *
	 * THE THRESHOLD IS EMPIRICAL, NOT GUESSED. Backtested over Iran 2026-01-01 -> 07-26 (301
	 * points): the distribution is BIMODAL — the counts below 0.5, below 1.0 and below 2.0 are
	 * IDENTICAL (81 each), and on any day without a sub-1.0 reading the minimum value seen is 6.68.
	 * Nothing lies in between, so an absolute floor separates outage from the normal diurnal dip
	 * perfectly, and OUTAGE_ABS sits in the middle of that empty gap. It recovers both known
	 * episodes (2026-01-15..18 and 2026-03-01..04-16, the latter containing the 11-day total
	 * blackout where the value read exactly 0.00).
	 *
	 * TWO REJECTED RULES, both of which look reasonable and fail:
	 *   - a flat trailing median ignores a strong diurnal cycle (Iran runs ~3.7 at 03:00 UTC vs
	 *     ~12.4 at 10:00), so a percentage-of-median rule fires most nights.
	 *   - an hour-matched trailing baseline fired ZERO times across the entire 11-day blackout: the
	 *     baseline collapses INTO the outage and stops seeing it. Any self-referential baseline is
	 *     blind to exactly the sustained event that matters most.
	 *
	 * WHAT IT CANNOT ESTABLISH — and the page must say so: this measures REACHABILITY, not cause. A
	 * collapse is equally consistent with infrastructure destroyed, a deliberate national shutdown,
	 * a cable fault, a power failure, or a provider withdrawing under sanctions.
	 */
	public static function detect_blackout() {
		$out = [];
		$now = time();
		foreach ( self::WATCH as $cc => $country ) {
			$url = 'https://transparencyreport.google.com/transparencyreport/api/v3/traffic/fraction'
				. '?start=' . ( ( $now - 45 * DAY_IN_SECONDS ) * 1000 ) . '&end=' . ( $now * 1000 )
				. '&product=19&region=' . rawurlencode( $cc ) . '&cb=' . $now; // edge caches an hour; bust it
			$raw = self::fetch( $url, 12 );
			if ( '' === $raw ) { continue; }
			// XSSI-guarded with exactly 6 bytes: )]}'\n\n — a naive trim leaves a blank line and
			// json_decode returns null, so cut from the first bracket instead.
			$i = strpos( $raw, '[' );
			if ( false === $i ) { continue; }
			$j      = json_decode( substr( $raw, $i ), true );
			$series = $j[0][1] ?? null;
			if ( ! is_array( $series ) ) { continue; }
			$pts = [];
			foreach ( $series as $p ) {
				$v = $p[1][0][1] ?? null;
				if ( null === $v ) { continue; }
				$pts[] = [ (int) ( $p[0] / 1000 ), (float) $v ];
			}
			if ( count( $pts ) < 20 ) { continue; }
			$last = end( $pts );
			if ( $last[1] >= self::OUTAGE_ABS ) { continue; }
			// A country whose NORMAL level is already tiny would trip the floor forever; require the
			// recent upper range to sit far above it, so what publishes is a CHANGE, not a baseline.
			$vals = array_column( $pts, 1 );
			sort( $vals );
			$p75 = $vals[ (int) ( 0.75 * ( count( $vals ) - 1 ) ) ];
			if ( $p75 < self::OUTAGE_ABS * 3 ) { continue; }
			$pct = $p75 > 0 ? ( 100.0 * $last[1] / $p75 ) : 0.0;
			$out[] = [
				// One ongoing blackout is ONE story per country per day, updated — not one per tick.
				'ekey'       => 'gtr_' . $cc . '_' . gmdate( 'Ymd', $last[0] ),
				'ts'         => $last[0],
				'lat'        => null, 'lon' => null,
				'place'      => '', 'country' => $country,
				'severity'   => max( 0.0, 100.0 - $pct ),        // % below the country's own recent normal
				'rank'       => max( 0.0, 100.0 - $pct ) + 50.0, // a national collapse outranks a single fire
				'confidence' => 'high',                          // measured at a foreign edge, not inferred
				'kind'       => 'national internet traffic collapse',
				'measures'   => [
					'Country'              => $country,
					'Traffic fraction now' => round( $last[1], 2 ) . ' (share of Google global traffic)',
					'Recent normal level'  => round( $p75, 2 ) . ' (75th percentile of the past 45 days)',
					'Share of normal'      => round( $pct, 1 ) . '%',
					'Last measurement'     => gmdate( 'Y-m-d H:i', $last[0] ) . ' UTC',
					'Measurement point'    => 'Google global edge, outside the country — a national shutdown cannot suppress it',
				],
				'source'     => [ 'name' => 'Google Transparency Report · traffic fraction (product 19, region ' . $cc . ')',
					'url' => $url, 'retrieved' => $now ],
			];
		}
		return $out;
	}

	/**
	 * Commodity price moves past N sigma of their own trailing volatility (not a fixed %).
	 *
	 * CADENCE MATTERS. The benchmark behind these prices is the World Bank Pink Sheet, which is
	 * MONTHLY. The energy card carries each monthly value across a daily grid for display, so the
	 * daily series steps: in a 56-day window it holds ONE distinct observation and 37 zero returns.
	 * Run a MAD z-score over that and sigma collapses to zero — the detector could never fire, and
	 * if it had, it would have described a monthly benchmark revision as a one-session move. So this
	 * reads the monthly series directly and reports month-over-month, which is what the data is.
	 */
	public static function detect_price() {
		$src   = get_option( 'aq_commodities_src', [] );
		$items = is_array( $src['items'] ?? null ) ? $src['items'] : [];
		$out   = [];
		$now   = time();
		foreach ( $items as $it ) {
			$key = (string) ( $it['key'] ?? '' );
			if ( '' === $key || ! class_exists( '\\AQ\\Extra' ) ) { continue; }
			// USD leg only: the ₳ series is USD ÷ gold, so a move in it can be the GOLD denominator
			// rather than the commodity — that would publish 'coal jumped' when coal did nothing.
			$months = (array) Extra::commodity_monthly( $key );
			if ( count( $months ) < self::PRICE_MIN_OBS ) { continue; }
			ksort( $months );
			$dates = array_keys( $months );
			$vals  = array_values( $months );
			// Bound the yardstick to recent regime, not sixty years of it.
			if ( count( $vals ) > self::PRICE_WINDOW ) {
				$vals  = array_slice( $vals, -self::PRICE_WINDOW );
				$dates = array_slice( $dates, -self::PRICE_WINDOW );
			}
			$rets = [];
			for ( $i = 1; $i < count( $vals ); $i++ ) {
				if ( $vals[ $i - 1 ] <= 0 ) { continue; }
				$rets[] = ( $vals[ $i ] - $vals[ $i - 1 ] ) / $vals[ $i - 1 ];
			}
			$last = array_pop( $rets );
			if ( null === $last || count( $rets ) < self::PRICE_MIN_OBS ) { continue; }
			// Robust sigma: median absolute deviation, so one earlier jump can't inflate the yardstick
			// and hide the next one (a plain stdev is exactly the wrong tool for jump detection).
			$med = self::median( $rets );
			$abs = array_map( static fn( $r ) => abs( $r - $med ), $rets );
			$mad = self::median( $abs );
			$sig = $mad > 0 ? $mad * 1.4826 : 0.0; // MAD → σ for a normal distribution
			if ( $sig <= 0 ) { continue; }
			$z = ( $last - $med ) / $sig;
			if ( abs( $z ) < self::PRICE_SIGMA ) { continue; } // σ against its OWN recent behaviour
			$month = (string) end( $dates );
			$out[] = [
				'ekey'       => 'p_' . $key . '_' . $month,
				// The move belongs to its OBSERVATION month, not to whenever the cron noticed it.
				'ts'         => strtotime( $month . '-01 00:00:00 UTC' ) ?: $now,
				'lat'        => null, 'lon' => null,
				'severity'   => abs( $z ),
				'rank'       => abs( $z ),
				'dir'        => $last,
				'confidence' => 'high',
				'kind'       => $last < 0 ? 'price drop' : 'price jump',
				'measures'   => [
					'Commodity'      => (string) ( $it['label'] ?? '' ),
					'Move'           => ( $last >= 0 ? '+' : '' ) . round( $last * 100, 2 ) . '% month over month',
					'Size vs normal' => round( $z, 1 ) . 'σ of its own ' . count( $rets ) . '-month volatility (robust MAD estimate)',
					'Price now'      => '₳' . round( (float) ( $it['acoin'] ?? 0 ), 4 ) . ' per kWh',
					'Observation'    => $month . ' (World Bank Pink Sheet, monthly)',
				],
				'source'     => [ 'name' => 'World Bank Commodity Markets "Pink Sheet" (monthly nominal USD) → ₳ per kWh',
					'url' => home_url( '/wp-json/aq/v1/commodities' ), 'retrieved' => $now ],
			];
		}
		return $out;
	}

	// ── helpers ───────────────────────────────────────────────────────────────────────────────

	/** Single-link clustering on the sphere: pixels within $km of the growing cluster join it. */
	private static function cluster( $pts, $km ) {
		$out  = [];
		$used = [];
		$n    = count( $pts );
		for ( $i = 0; $i < $n; $i++ ) {
			if ( isset( $used[ $i ] ) ) { continue; }
			$used[ $i ] = true;
			$mem = [ $pts[ $i ] ];
			$q   = [ $i ];
			while ( $q ) {
				$cur = array_pop( $q );
				for ( $j = 0; $j < $n; $j++ ) {
					if ( isset( $used[ $j ] ) ) { continue; }
					if ( self::km( $pts[ $cur ]['lat'], $pts[ $cur ]['lon'], $pts[ $j ]['lat'], $pts[ $j ]['lon'] ) <= $km ) {
						$used[ $j ] = true; $mem[] = $pts[ $j ]; $q[] = $j;
					}
				}
			}
			// FRP IS INSTANTANEOUS POWER. Summing it across acquisition times adds measurements taken
			// hours apart and reports the result as one number — physically meaningless, and it was
			// inflating every headline: a real cluster read 34 + 14,193 + 55,285 = 69,512 MW when the
			// fire never radiated more than 55,285 MW at any observed instant. The cluster's power is
			// the STRONGEST SINGLE OVERPASS; the per-time series is kept for the energy integral.
			$frp = 0.0; $ti4 = 0.0; $la = 0.0; $lo = 0.0; $ts = 0; $dn = '';
			foreach ( $mem as $m ) {
				$frp += $m['frp']; $ti4 = max( $ti4, $m['ti4'] );
				$la += $m['lat'] * $m['frp']; $lo += $m['lon'] * $m['frp']; // FRP-weighted centroid
				if ( $m['ts'] > $ts ) { $ts = $m['ts']; $dn = $m['dn']; }
			}
			// BUILD THE SERIES FIRST. It used to be assembled at the BOTTOM of this loop body and
			// read at the top: on the first cluster of a tick it was undefined (peak 0 → dropped at
			// the FRP floor), and on every cluster after that it still held the PREVIOUS cluster's
			// per-overpass map. So the reported power, the overpass timestamp and — via the
			// peak-weighted centroid — the LATITUDE AND LONGITUDE all belonged to a different fire,
			// which then drove the place name, the watch-box test, the slug and the headline. On a
			// platform whose contract is that a printed number is a measurement, that is the worst
			// class of defect there is; it is the severity-as-sort-key mistake wearing a new hat.
			$cells = []; $sats = []; $series = [];
			foreach ( $mem as $m ) {
				// Every cell the cluster actually touches — the census is tested against all of them.
				$cells[ round( $m['lat'], 2 ) . ',' . round( $m['lon'], 2 ) ] = true;
				if ( ! empty( $m['sat'] ) ) { $sats[ $m['sat'] ] = true; }
				// Power summed PER ACQUISITION TIME — the series fire radiative ENERGY integrates over.
				$series[ (int) $m['ts'] ] = ( $series[ (int) $m['ts'] ] ?? 0.0 ) + (float) $m['frp'];
			}
			// Peak-overpass power, and the centroid weighted by that same overpass's pixels.
			$peak_ts = 0; $peak = 0.0;
			foreach ( $series as $st => $sf ) { if ( $sf > $peak ) { $peak = $sf; $peak_ts = (int) $st; } }
			$pla = 0.0; $plo = 0.0; $pw = 0.0; $pn = 0;
			foreach ( $mem as $m ) {
				if ( (int) $m['ts'] !== $peak_ts ) { continue; }
				$pla += $m['lat'] * $m['frp']; $plo += $m['lon'] * $m['frp']; $pw += $m['frp']; $pn++;
			}
			$frp  = $peak;                       // the reported power: one instant, not a time-sum
			$la   = $pw > 0 ? $pla : $la;
			$lo   = $pw > 0 ? $plo : $lo;
			$wsum = $pw > 0 ? $pw : $frp;
			$clat = $wsum > 0 ? $la / $wsum : $mem[0]['lat'];
			$clon = $wsum > 0 ? $lo / $wsum : $mem[0]['lon'];
			// The extent needs the centroid, so it is a second, short pass.
			$span = 0.0;
			foreach ( $mem as $m ) { $span = max( $span, self::km( $clat, $clon, $m['lat'], $m['lon'] ) * 2 ); }
			$out[] = [ 'lat' => $clat, 'lon' => $clon, 'frp' => $frp, 'ti4' => $ti4, 'n' => count( $mem ),
				'ts' => $peak_ts ?: ( $ts ?: time() ), 'dn' => $dn, 'span' => $span,
				'peak_n' => $pn, 'looks' => count( $series ),
				'cells' => array_keys( $cells ), 'sats' => array_keys( $sats ), 'series' => $series,
				// The frozen pixel record: what the instrument actually saw, kept so the published
				// notebook can redraw the event from evidence rather than from our summary of it.
				'px' => array_map( static fn( $m ) => [ round( $m['lat'], 5 ), round( $m['lon'], 5 ),
					round( $m['frp'], 1 ), (int) $m['ts'], (string) ( $m['sat'] ?? '' ) ], $mem ) ];
		}
		return $out;
	}

	/**
	 * OUTPUT-SIDE VALIDATION of model prose. Two rules, both mechanical:
	 *   1. NO INVENTED FIGURES — every number in the prose must appear in the measurements or the
	 *      context we supplied. A model that adds "at least 40 hectares" has fabricated a fact.
	 *   2. NO ASSERTED CAUSE — a bare causal verb ("was struck", "was bombed", "caused by") is a
	 *      claim no instrument here can support, however plausible it reads.
	 * Failing either sends the event to the deterministic report, which can do neither.
	 */
	private static function prose_ok( $prose, $meas, $ctx ) {
		// Compare numbers as TOKENS, never as substrings: '40' occurs inside '14059.0', so a substring
		// test would wave through an invented "at least 40 hectares" on a page whose only figure is FRP.
		$known = [];
		preg_match_all( '/\d+(?:[.,]\d+)*/', strtolower( $ctx . ' ' . wp_json_encode( $meas ) ), $km );
		foreach ( (array) ( $km[0] ?? [] ) as $k ) { $known[ self::num_key( $k ) ] = true; }
		preg_match_all( '/\d+(?:[.,]\d+)*/', (string) $prose, $m );
		foreach ( (array) ( $m[0] ?? [] ) as $num ) {
			$key = self::num_key( $num );
			if ( '' === $key || strlen( $key ) < 2 ) { continue; }   // single digits are prose, not claims
			if ( isset( $known[ $key ] ) ) { continue; }
			return false;                                             // a figure we never measured
		}
		$banned = [ 'was struck', 'was hit', 'was bombed', 'was attacked', 'was targeted', 'strike on',
			'airstrike', 'missile', 'shelling', 'caused by', 'sabotage', 'terrorist',
			'casualties', 'killed', 'injured', 'perpetrator', 'responsible for the' ];
		$low = strtolower( (string) $prose );
		foreach ( $banned as $b ) {
			if ( false !== strpos( $low, $b ) ) { return false; }
		}
		return true;
	}

	/** Canonical form of a number so '14,059', '14059' and '14059.0' compare equal. */
	private static function num_key( $n ) {
		$n = str_replace( ',', '', (string) $n );
		if ( false !== strpos( $n, '.' ) ) { $n = rtrim( rtrim( $n, '0' ), '.' ); }
		return $n;
	}

	/** A live event of the same detector near this point in space and time — the identity fallback
	 *  when a derived key (a drifting centroid) cannot be trusted to stay stable. */
	private static function live_near( $detector, $lat, $lon, $ts ) {
		$rows = Data::all(
			'SELECT id, revisions, status, severity, lat, lon FROM ' . Data::t( 'aq_news_events' )
			. ' WHERE detector = %s AND ABS(last_ts - %d) < %d LIMIT 200',
			[ $detector, (int) $ts, self::FRESH_S ] );
		$best = null; $bd = PHP_FLOAT_MAX;
		foreach ( (array) $rows as $row ) {
			$d = self::km( $lat, $lon, (float) $row['lat'], (float) $row['lon'] );
			if ( $d <= self::DRIFT_KM && $d < $bd ) { $bd = $d; $best = $row; }
		}
		return $best;
	}

	/** The strongest prior-persistence evidence anywhere in the cluster (one batched query). */
	private static function census_days_max( $cells ) {
		global $wpdb;
		$cells = array_values( array_unique( array_filter( (array) $cells ) ) );
		if ( ! $cells ) { return 0; }
		$max = 0;
		$t   = Data::t( 'aq_news_cells' );
		foreach ( array_chunk( $cells, 400 ) as $chunk ) {
			$ph  = implode( ',', array_fill( 0, count( $chunk ), '%s' ) );
			$max = max( $max, (int) $wpdb->get_var( $wpdb->prepare( "SELECT MAX(days) FROM {$t} WHERE cell IN ({$ph})", $chunk ) ) );
		}
		return $max;
	}

	/** Is this cluster on its own? A blast appears where nothing else is burning; a wildfire front
	 *  has siblings. Isolation is measured from the same coordinates, so it stays a measurement. */
	private static function isolated( $clusters, $c, $km, $self = null ) {
		// Skip SELF by index, not by comparing floats: two distinct clusters can round to the same
		// centroid, and identity by value would then silently mark a crowded pair as isolated.
		foreach ( $clusters as $i => $o ) {
			if ( $i === $self ) { continue; }
			if ( self::km( $c['lat'], $c['lon'], $o['lat'], $o['lon'] ) <= $km ) { return false; }
		}
		return true;
	}

	/**
	 * The energy figure as a reader meets it: a RANGE, never a single number.
	 *
	 * The first version of this printed the trapezoid alone and called it "a lower bound". Testing it
	 * against a real event refuted that outright: the observed series ran 34 MW → 14,193 MW →
	 * 55,285 MW across 11.45 h, and the bracketing assumptions about what happened BETWEEN
	 * overpasses span 88 TJ to 837 TJ — a factor of nine, with the trapezoid sitting 5.2x above the
	 * conservative end. A 9.75 h gap carrying a 416-fold jump simply does not determine the energy,
	 * and a linear ramp across it is an assumption, not a measurement.
	 */
	private static function energy_label( $e ) {
		[ $lo, $mid, $hi, $span, $gaps ] = $e;
		if ( $mid <= 0 ) {
			// Seen once. Power is measured; energy is not, and inventing a duration would fabricate the
			// number — the one thing this platform must never print.
			return 'not measurable — the sightings are too far apart to integrate between'
				. ' (a single overpass, or every gap longer than ' . (int) ( self::ENERGY_MAX_GAP / 3600 ) . ' h)';
		}
		$fmt = static function ( $mj ) {
			$gj = $mj / 1000.0;
			return $gj >= 1000 ? number_format( $gj / 1000, 1 ) . ' TJ' : number_format( $gj, 1 ) . ' GJ';
		};
		$hours = $span / 3600.0;
		$out   = 'between ' . $fmt( $lo ) . ' and ' . $fmt( $hi ) . ' (mid estimate ' . $fmt( $mid ) . ')'
			. ' radiated as heat and light over the ' . number_format( $hours, 1 ) . ' h between first'
			. ' and last sighting. This is energy the fire RADIATED, not the energy of what burned';
		// When the bracket is wide the range IS the finding, so say why rather than let a reader take
		// the mid estimate as the answer.
		// Two documented biases, in opposite directions, both stated rather than netted off.
		// UP: interpolating between polar-orbiter looks without a diurnal correction returned 163% of
		// a geostationary reference (Andela et al. 2015, doi:10.5194/acp-15-8831-2015) — the daytime
		// overpass sits near the ~13:00 peak of fire activity. DOWN: NASA sets FRP to ZERO on pixels
		// that saturate the M13 channel, so the most intense fires can contribute nothing at all.
		$out .= '. Two known biases pull opposite ways: sampling near the daily peak of fire activity'
			. ' tends to overstate the integral, while the most intense pixels can be recorded as zero'
			. ' power when the sensor saturates';
		if ( $lo > 0 && ( $hi / $lo ) >= 3.0 ) {
			$out .= '. The range is wide because the satellite saw this ' . ( $gaps + 1 ) . ' times and the'
				. ' longest gap between sightings was ' . number_format( self::$last_gap_h, 1 ) . ' h — what the'
				. ' fire did in between is not observed';
		}
		return $out;
	}

	/** Longest un-observed gap in the series just integrated, in hours (for the honesty note above). */
	private static $last_gap_h = 0.0;

	/**
	 * FIRE RADIATIVE ENERGY — bracketed, because sparse sampling does not determine it.
	 *
	 * FRP is POWER (1 MW = 1 MJ/s). Energy is its integral, but a polar orbiter samples a spot only a
	 * handful of times a day, so between two sightings the fire's behaviour is unobserved. Assuming
	 * monotonic change between samples, the energy of a segment lies between min(f0,f1)*dt and
	 * max(f0,f1)*dt; the trapezoid is the midpoint of that, not a bound.
	 *
	 * NOT EVEN THE UPPER FIGURE IS A HARD CEILING: a fire that spiked and subsided between two
	 * overpasses can exceed it. The range is the honest statement of what sampling supports.
	 *
	 * @return [ lo_MJ, mid_MJ, hi_MJ, observed_span_s, interpolated_gap_count ]
	 */
	private static function fire_energy( $series ) {
		self::$last_gap_h = 0.0;
		if ( ! is_array( $series ) || count( $series ) < 2 ) { return [ 0.0, 0.0, 0.0, 0, 0 ]; }
		ksort( $series );
		$t = array_keys( $series );
		$v = array_values( $series );
		$lo = $mid = $hi = 0.0;
		$gaps = 0; $covered = 0;
		for ( $i = 1; $i < count( $t ); $i++ ) {
			$dt = (float) ( $t[ $i ] - $t[ $i - 1 ] );
			if ( $dt <= 0 || $dt > self::ENERGY_MAX_GAP ) { continue; } // too far apart to interpolate at all
			$a = (float) $v[ $i - 1 ];
			$b = (float) $v[ $i ];
			$lo  += min( $a, $b ) * $dt;   // it never rose above the lower reading
			$hi  += max( $a, $b ) * $dt;   // it was already at the higher reading throughout
			$mid += 0.5 * ( $a + $b ) * $dt; // a straight line between them
			$gaps++;
			$covered += (int) $dt;
			self::$last_gap_h = max( self::$last_gap_h, $dt / 3600.0 );
		}
		// Report the span ACTUALLY INTEGRATED, not first-to-last: with an over-long gap refused, a
		// 0/13h/14h series integrates one hour but used to print 'radiated over the 14.0 h'.
		return [ $lo, $mid, $hi, (int) $covered, $gaps ];
	}

	/** Great-circle distance in km (haversine). */
	private static function km( $la1, $lo1, $la2, $lo2 ) {
		$r = 6371.0088;
		$dla = deg2rad( $la2 - $la1 ); $dlo = deg2rad( $lo2 - $lo1 );
		$a = sin( $dla / 2 ) ** 2 + cos( deg2rad( $la1 ) ) * cos( deg2rad( $la2 ) ) * sin( $dlo / 2 ) ** 2;
		return $r * 2 * atan2( sqrt( $a ), sqrt( 1 - $a ) );
	}

	private static function median( $a ) {
		if ( ! $a ) { return 0.0; }
		sort( $a );
		$n = count( $a );
		return 0 === $n % 2 ? ( $a[ $n / 2 - 1 ] + $a[ $n / 2 ] ) / 2 : $a[ (int) ( $n / 2 ) ];
	}

	/** FIRMS acq_date (YYYY-MM-DD) + acq_time (HHMM, UTC) → unix. */
	private static function firms_ts( $date, $hhmm ) {
		$hhmm = str_pad( preg_replace( '/\D/', '', $hhmm ), 4, '0', STR_PAD_LEFT );
		$t = strtotime( $date . ' ' . substr( $hhmm, 0, 2 ) . ':' . substr( $hhmm, 2, 2 ) . ' UTC' );
		return $t ?: time();
	}

	/**
	 * Nearest populated place ≥15k people, from the bundled GeoNames index (CC BY 4.0). Offline by
	 * design: no geocoding API means no key, no rate limit, no third party deciding what a place is
	 * called, and a deterministic result a reader can reproduce.
	 */
	public static function nearest_place( $lat, $lon ) {
		static $places = null, $countries = null;
		if ( null === $places ) {
			$places = [];
			$f = AQ_DIR . '/data/places.tsv';
			if ( is_readable( $f ) ) {
				foreach ( explode( "\n", (string) file_get_contents( $f ) ) as $line ) {
					if ( '' === $line ) { continue; }
					$p = explode( "\t", $line );
					if ( count( $p ) < 5 ) { continue; }
					$places[] = [ $p[0], $p[1], (float) $p[2], (float) $p[3] ];
				}
			}
			$countries = [];
			$cf = AQ_DIR . '/data/countries.tsv';
			if ( is_readable( $cf ) ) {
				foreach ( explode( "\n", (string) file_get_contents( $cf ) ) as $line ) {
					$p = explode( "\t", $line );
					if ( count( $p ) >= 2 ) { $countries[ $p[0] ] = trim( $p[1] ); }
				}
			}
		}
		$best = null; $bd = PHP_FLOAT_MAX;
		foreach ( $places as $p ) {
			// cheap bounding-box reject before the trig — 34k haversines per event would be wasteful
			if ( abs( $p[2] - $lat ) > 3.0 ) { continue; }
			$dlon = abs( $p[3] - $lon );
			if ( $dlon > 180 ) { $dlon = 360 - $dlon; }
			if ( $dlon > 3.0 / max( 0.05, cos( deg2rad( $lat ) ) ) ) { continue; }
			$d = self::km( $lat, $lon, $p[2], $p[3] );
			if ( $d < $bd ) { $bd = $d; $best = $p; }
		}
		if ( ! $best ) { return [ 'place' => '', 'country' => '', 'km' => 0.0 ]; }
		return [ 'place' => $best[0], 'country' => $countries[ $best[1] ] ?? $best[1], 'km' => round( $bd, 1 ) ];
	}

	/**
	 * The honest location phrase. The geocoder returns the nearest settlement of ≥15,000 people,
	 * which in sparsely populated terrain can be a very long way from the measurement — a British
	 * Columbia fire resolved to "Brocklehurst" 95 km away. Naming that town as the location is a
	 * claim the coordinates do not support, so beyond NEAR_KM the distance is stated instead of
	 * hidden. Nothing here is inferred: the distance is computed from the same coordinates.
	 */
	// `$sep` defaults to the comma, because a town and a country are separated by one in every
	// language this ships in, and the one caller that took a bare-space default printed
	// "Terny Ukraine" into a rail of "…, Russia" and "…, Philippines". A default that is wrong for
	// every caller is not a default, it is a trap; pass something else only for a genuine reason.
	private static function place_phrase( $place, $country, $km, $sep = ', ' ) {
		$town = trim( (string) $place );
		$cty  = trim( (string) $country );
		if ( '' === $town && '' === $cty ) { return ''; }
		$km = (float) $km;
		// Three tiers, because a nearest-town name stops carrying information as the distance grows:
		//   ≤ NEAR_KM      the town IS the locality        → "Tehran, Iran"
		//   ≤ BEARING_KM   the town is a usable bearing    → "32 km from Redmond, United States"
		//   beyond that    the town is noise; the country is the only honest unit → "United States"
		// The middle tier was the whole fix at first, and it produced "168 km from Redmond" — true,
		// and useless. Naming a settlement three hours' drive away is not locating anything.
		if ( '' === $town ) { return $cty; }
		$full = $town . ( $cty ? $sep . $cty : '' );
		if ( $km <= self::NEAR_KM ) { return $full; }
		if ( $km <= self::BEARING_KM ) { return number_format( $km ) . ' km from ' . $full; }
		return $cty ?: $full;
	}

	/** The preposition that fits the location phrase: a town or a bearing is somewhere you are
	 *  NEAR; a whole country is somewhere you are IN. "measured near United States" is wrong. */
	private static function place_prep( $place, $km ) {
		$km = (float) $km;
		if ( '' === trim( (string) $place ) ) { return 'in'; }   // country only
		if ( $km <= self::NEAR_KM )    { return 'near'; }         // "near Tehran, Iran"
		if ( $km <= self::BEARING_KM ) { return ''; }             // the phrase carries its own "32 km from …"
		return 'in';                                              // fell back to the country
	}

	/** "Explosions, Tehran, Iran" — the operator's concise form: what, then where. */
	private static function headline( $detector, $r, $place ) {
		$kind = (string) ( $r['kind'] ?? 'Event' );
		$what = [
			'high-intensity thermal anomaly' => 'Major heat signature',
			'thermal anomaly'                => 'Heat signature',
			'wildfire'                       => 'Wildfire',
			'earthquake'                     => 'Earthquake',
			'price move'                     => 'Price jump',
			'national internet traffic collapse' => 'Internet traffic collapse',
		][ $kind ] ?? ucfirst( $kind );
		if ( 'quake' === $detector ) {
			// Format from the MEASURED magnitude, never from severity's ranking twin — and never call an
			// analyst-classified blast an earthquake: that classification is why it cleared the threshold.
			$m    = 'M' . number_format( (float) ( $r['mag'] ?? $r['severity'] ), 1 );
			$what = empty( $r['blast'] ) ? $m . ' earthquake' : $m . ' blast recorded seismically';
		}
		if ( 'price' === $detector ) {
			$m = (array) ( $r['measures'] ?? [] );
			// Direction is measured — calling a crash a 'jump' misstates the sign of the move.
			$dir = ( (float) ( $r['dir'] ?? 0 ) < 0 ) ? ' price drop' : ' price jump';
			return trim( (string) ( $m['Commodity'] ?? 'Commodity' ) . $dir );
		}
		// ', ' — the same separator every other surface uses. The default is a bare space, and taking
		// it produced "Major heat signature, Terny Ukraine" in the rail: a comma after the what, then
		// a town and a country welded together, sitting directly under three siblings that all read
		// "…, Russia" and "…, Philippines". It reads as a missing comma because it is one. The API's
		// own `place_label` already passes ', ' at both call sites, so the headline and the subtitle
		// were describing the same place two different ways.
		$where = self::place_phrase( $place['place'], $place['country'], $place['km'] ?? 0, ', ' );
		$head  = $where ? $what . ', ' . $where : $what;
		// Two separate clusters near the same town would otherwise mint identical headlines, which
		// reads as duplicate publishing. The measured intensity distinguishes them honestly.
		if ( 'thermal' === $detector && ! empty( $r['severity'] ) ) {
			$head .= ' (' . number_format( (float) $r['severity'] ) . ' MW)';
		}
		return $head;
	}

	/**
	 * CLAUDE SERVICE DISRUPTION — the provider's own machine monitoring (see CLAUDE_STATUS_URL above
	 * for why this one detector is allowed to read a vendor status page at all).
	 *
	 * Reads the Statuspage summary endpoint and takes ONLY enums from it: each component's `status`
	 * and each unresolved incident's `impact`. The incident title is used as a label and never as a
	 * measurement, so no wording on the status page can change the severity we record.
	 *
	 * KEYED ON THE INCIDENT, NOT THE HOUR. The connectivity detector learned this the hard way: a
	 * per-hour key turned one ongoing national blackout into a fresh page every hour. An outage is a
	 * single continuing event, so an open incident keeps ONE ekey for its whole life and every later
	 * poll updates it. Component degradation with no incident attached falls back to a per-day key.
	 */
	public static function detect_claude() {
		$t0   = microtime( true );
		$raw  = self::fetch( self::CLAUDE_STATUS_URL, 15 );
		$body = json_decode( $raw, true );
		// "NO EVENTS" AND "COULD NOT READ THE SOURCE" MUST NOT LOOK THE SAME. detect_tick() records
		// health as (bool) $rows, which is fine for a detector that normally returns something — but
		// the healthy state of this one is ZERO events, so that generic rule would file a perfectly
		// working monitor as a failed source on every tick, and a genuinely unreachable status page
		// would hide inside the same silence. So report health here, keyed on whether the FETCH
		// succeeded, not on whether anything was wrong with Claude.
		if ( ! is_array( $body ) || ! isset( $body['components'] ) ) {
			Extra::src_health( 'news:claude', false, ( microtime( true ) - $t0 ) * 1000, 0,
				'' === $raw ? 'status endpoint unreachable' : 'unexpected payload shape' );
			return [];
		}
		$now  = time();
		$out  = [];
		$src  = [ 'name' => 'Anthropic status (Statuspage)', 'url' => self::CLAUDE_STATUS_URL, 'retrieved' => $now ];

		// 1) OPEN INCIDENTS — the provider has acknowledged a disruption and given it an impact enum.
		foreach ( (array) ( $body['incidents'] ?? [] ) as $inc ) {
			$impact = strtolower( (string) ( $inc['impact'] ?? '' ) );
			$sev    = (float) ( self::CLAUDE_IMPACT[ $impact ] ?? 0.0 );
			if ( $sev < self::CLAUDE_MIN_SEVERITY ) { continue; }
			$ts   = strtotime( (string) ( $inc['started_at'] ?? $inc['created_at'] ?? '' ) ) ?: $now;
			$name = (string) ( $inc['name'] ?? 'Service incident' );
			$out[] = [
				'ekey'       => 'claude_inc_' . (string) ( $inc['id'] ?? md5( $name . $ts ) ),
				'ts'         => $ts,
				'lat'        => null, 'lon' => null,
				'place'      => 'Anthropic', 'country' => '',
				'severity'   => $sev,
				'rank'       => $sev,
				// NOT 'high': this is the measured party reporting on itself. The page must never show
				// a vendor self-report with the same confidence as a seismometer.
				'confidence' => 'operator-reported',
				'kind'       => 'service disruption',
				'headline'   => 'Claude service disruption — ' . $name,
				'measures'   => [
					'Impact'          => $impact,
					'Incident status' => (string) ( $inc['status'] ?? '' ),
					'Started (UTC)'   => gmdate( 'c', $ts ),
					'Components'      => implode( ', ', array_map(
						static function ( $c ) { return (string) ( $c['name'] ?? '' ); },
						(array) ( $inc['components'] ?? [] ) ) ),
				],
				'source'     => $src,
			];
		}
		if ( $out ) {
			Extra::src_health( 'news:claude', true, ( microtime( true ) - $t0 ) * 1000, count( $out ) );
			return $out;
		}

		// 2) NO OPEN INCIDENT, but a component is degraded — still a measurement, keyed per day.
		foreach ( (array) ( $body['components'] ?? [] ) as $c ) {
			if ( ! empty( $c['group'] ) ) { continue; }              // group headers carry no status of their own
			$status = strtolower( (string) ( $c['status'] ?? '' ) );
			$sev    = (float) ( self::CLAUDE_SEVERITY[ $status ] ?? 0.0 );
			if ( $sev < self::CLAUDE_MIN_SEVERITY ) { continue; }
			$name = (string) ( $c['name'] ?? 'Component' );
			$ts   = strtotime( (string) ( $c['updated_at'] ?? '' ) ) ?: $now;
			$out[] = [
				'ekey'       => 'claude_comp_' . (string) ( $c['id'] ?? sanitize_title( $name ) ) . '_' . gmdate( 'Ymd', $ts ),
				'ts'         => $ts,
				'lat'        => null, 'lon' => null,
				'place'      => 'Anthropic', 'country' => '',
				'severity'   => $sev,
				'rank'       => $sev,
				'confidence' => 'operator-reported',
				'kind'       => 'service disruption',
				'headline'   => 'Claude service disruption — ' . $name . ' ' . str_replace( '_', ' ', $status ),
				'measures'   => [
					'Component'      => $name,
					'Status'         => str_replace( '_', ' ', $status ),
					'Observed (UTC)' => gmdate( 'c', $ts ),
				],
				'source'     => $src,
			];
		}
		// A read that found nothing wrong is a SUCCESSFUL read — that is the normal state of a service
		// monitor and it must not look like an outage of the monitor itself.
		Extra::src_health( 'news:claude', true, ( microtime( true ) - $t0 ) * 1000, count( $out ) );
		return $out;
	}

	/** Bounded GET → body string ('' on any failure — a source outage is never fatal). */
	private static function fetch( $url, $timeout = 20 ) {
		$res = wp_remote_get( $url, [ 'timeout' => $timeout, 'redirection' => 3,
			'user-agent' => 'ArtaQuest/1.0 (+https://artaquest.com; automated data monitoring)' ] );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) { return ''; }
		return (string) wp_remote_retrieve_body( $res );
	}
}
