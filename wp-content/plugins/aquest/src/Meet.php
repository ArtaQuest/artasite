<?php
namespace AQ;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Google Meet group meetings for grant outreach.
 *
 * When members register to help apply for a grant, they're invited to a series of 1-hour Google
 * Meet working sessions scheduled at the grant's deadline-reminder milestones (T-14 days, T-1 day,
 * 16:00 America/New_York). Each session is a real Google Calendar event with a Meet conference link
 * and every registrant as a guest, created via the Calendar API.
 *
 * Auth = OAuth2 on a normal (consumer) Google account — NO Workspace required. The foundation grants
 * the app calendar access ONCE (offline consent → a long-lived refresh token); thereafter the app
 * exchanges that refresh token for short-lived access tokens. The Meet link + event + guest invites
 * live on that account's primary calendar. (A service account can't create Meet links without a
 * Workspace + domain-wide delegation, so we deliberately use the user-OAuth path instead.)
 *
 * Dependency-free (just wp_remote_*). Secrets come from the environment only (Secrets), never the DB:
 *   GOOGLE_OAUTH_CLIENT_ID · GOOGLE_OAUTH_CLIENT_SECRET · GOOGLE_OAUTH_REFRESH_TOKEN
 * Generate the refresh token once with tools/google_oauth.mjs (see that file's header).
 *
 * Graceful degrade: if the OAuth secrets aren't configured, enabled() is false and the whole feature
 * no-ops — claims still work, the page just shows no Meet links until it's set up.
 */
final class Meet {

	/** reminder_key → days before the deadline. A 1-hour session is scheduled at each (if still future). */
	const REMINDERS = [ 't-14' => 14, 't-1' => 1 ];
	const HOUR_ET   = 16;      // 16:00 America/New_York
	const TZ        = 'America/New_York';
	const SCOPE     = 'https://www.googleapis.com/auth/calendar.events';

	/** True only when the OAuth refresh-token credentials needed to create Meet events are present. */
	public static function enabled() {
		return Secrets::has( 'GOOGLE_OAUTH_CLIENT_ID' )
			&& Secrets::has( 'GOOGLE_OAUTH_CLIENT_SECRET' )
			&& Secrets::has( 'GOOGLE_OAUTH_REFRESH_TOKEN' );
	}

	/** Live access token for THIS request only — see token(). Never persisted. */
	private static $tok = null;

	/**
	 * An OAuth2 access token, obtained by exchanging the long-lived refresh token (refresh_token
	 * grant). Returns '' on any failure.
	 *
	 * CACHED IN MEMORY, FOR THIS REQUEST ONLY. It used to sit in a transient until ~5 min before
	 * expiry — and a transient is a wp_options row whenever no persistent object cache is present,
	 * which means a LIVE Google credential in the table the Data explorer serves to the world
	 * (Extra::db). That it happens not to land there on a host with memcached is not a property to
	 * rely on: "never put a secret in the database" is the rule, and an environment-dependent
	 * exception to it is the same as no rule. A static costs one extra token exchange per request
	 * that touches Calendar — Meet is used a handful of times per cron run, so that is nothing.
	 */
	private static function token() {
		if ( is_string( self::$tok ) && self::$tok !== '' ) { return self::$tok; }
		if ( ! self::enabled() ) { return ''; }

		$resp = wp_remote_post( 'https://oauth2.googleapis.com/token', [
			'timeout' => 15,
			'body'    => [
				'grant_type'    => 'refresh_token',
				'client_id'     => Secrets::get( 'GOOGLE_OAUTH_CLIENT_ID' ),
				'client_secret' => Secrets::get( 'GOOGLE_OAUTH_CLIENT_SECRET' ),
				'refresh_token' => Secrets::get( 'GOOGLE_OAUTH_REFRESH_TOKEN' ),
			],
		] );
		if ( is_wp_error( $resp ) ) { error_log( 'AQ Meet token: ' . $resp->get_error_message() ); return ''; }
		$body = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
		$tok  = $body['access_token'] ?? '';
		if ( $tok === '' ) { error_log( 'AQ Meet token: ' . wp_remote_retrieve_body( $resp ) ); return ''; }
		self::$tok = (string) $tok;
		// Clear any token a previous deploy left sitting in wp_options. Cheap, idempotent, and it
		// means the fix takes effect the first time this runs rather than when the TTL happens to lapse.
		delete_transient( 'aq_meet_token' );
		return self::$tok;
	}

	/** A Calendar API request on the authorizing account's primary calendar. Returns the decoded body, or null. */
	private static function api( $method, $path, $payload = null ) {
		$tok = self::token();
		if ( $tok === '' ) { return null; }
		$args = [
			'method'  => $method,
			'timeout' => 15,
			'headers' => [ 'Authorization' => 'Bearer ' . $tok, 'Content-Type' => 'application/json' ],
		];
		if ( $payload !== null ) { $args['body'] = wp_json_encode( $payload ); }
		$resp = wp_remote_request( 'https://www.googleapis.com/calendar/v3' . $path, $args );
		if ( is_wp_error( $resp ) ) { error_log( 'AQ Meet api: ' . $resp->get_error_message() ); return null; }
		$code = (int) wp_remote_retrieve_response_code( $resp );
		$body = json_decode( (string) wp_remote_retrieve_body( $resp ), true );
		if ( $code >= 300 ) { error_log( "AQ Meet api $method $path → $code " . wp_remote_retrieve_body( $resp ) ); return null; }
		return is_array( $body ) ? $body : [];
	}

	/** Unix start time for a reminder: N days before the deadline, at 16:00 ET. */
	private static function start_for( $deadline, $days_before ) {
		try {
			$dt = new \DateTime( $deadline . ' ' . sprintf( '%02d:00:00', self::HOUR_ET ), new \DateTimeZone( self::TZ ) );
			$dt->modify( '-' . (int) $days_before . ' days' );
			return $dt->getTimestamp();
		} catch ( \Exception $e ) { return 0; }
	}

	/** Extract the Meet URL from a Calendar event response. */
	private static function meet_url( $event ) {
		if ( ! empty( $event['hangoutLink'] ) ) { return $event['hangoutLink']; }
		foreach ( $event['conferenceData']['entryPoints'] ?? [] as $ep ) {
			if ( ( $ep['entryPointType'] ?? '' ) === 'video' && ! empty( $ep['uri'] ) ) { return $ep['uri']; }
		}
		return '';
	}

	/**
	 * Create/refresh this grant's group meetings and sync the guest list to its current registrants.
	 * Idempotent + safe to call on every claim/release. Never throws — failures degrade to "no meeting".
	 * Only dated grants get meetings; only reminders still in the future are scheduled.
	 */
	public static function sync_grant( $gid ) {
		$gid = (int) $gid;
		if ( ! $gid || ! self::enabled() ) { return; }

		$g = Data::one( 'SELECT id, slug, title, funder, url, deadline FROM ' . Data::t( 'aq_grants' ) . ' WHERE id = %d', [ $gid ] );
		if ( ! $g || ! preg_match( '/^\d{4}-\d{2}-\d{2}$/', (string) $g['deadline'] ) ) { return; }

		// Current registrants (those occupying a slot) → calendar guests + people to notify.
		$people = Data::all(
			'SELECT c.user_id, u.user_email, u.display_name FROM ' . Data::t( 'aq_grant_claims' ) . ' c'
			. ' JOIN ' . $GLOBALS['wpdb']->users . ' u ON u.ID = c.user_id'
			. ' WHERE c.grant_id = %d AND c.status IN ' . Extra::CLAIM_ACTIVE, [ $gid ]
		);
		$attendees = [];
		foreach ( $people as $p ) {
			if ( is_email( $p['user_email'] ) ) { $attendees[] = [ 'email' => $p['user_email'] ]; }
		}
		if ( ! $attendees ) { return; }

		foreach ( self::REMINDERS as $key => $days ) {
			$start = self::start_for( $g['deadline'], $days );
			if ( $start <= time() ) { continue; } // past — skip
			$end   = $start + 3600;
			$human = ( $days === 1 ? 'final review' : $days . '-day working session' );
			$event = [
				'summary'     => 'ArtaQuest grant — ' . $g['title'] . ' (' . $human . ')',
				'description' => "Group working session for the ArtaQuest Foundation's application to "
					. $g['funder'] . ".\n\nGrant: " . $g['title'] . ( $g['url'] ? "\n" . $g['url'] : '' )
					. "\nDeadline: " . $g['deadline'] . "\n\nSee https://artaquest.com/outreach/",
				'start'       => [ 'dateTime' => gmdate( 'Y-m-d\TH:i:s', $start ) . 'Z' ],
				'end'         => [ 'dateTime' => gmdate( 'Y-m-d\TH:i:s', $end ) . 'Z' ],
				'attendees'   => $attendees,
				'guestsCanModify' => false,
				'reminders'   => [ 'useDefault' => false, 'overrides' => [
					[ 'method' => 'email', 'minutes' => 1440 ],
					[ 'method' => 'popup', 'minutes' => 30 ],
				] ],
			];

			$row = Data::one( 'SELECT id, gcal_event_id FROM ' . Data::t( 'aq_grant_meetings' ) . ' WHERE grant_id = %d AND reminder_key = %s', [ $gid, $key ] );
			if ( $row && $row['gcal_event_id'] ) {
				$res = self::api( 'PATCH', '/calendars/primary/events/' . rawurlencode( $row['gcal_event_id'] ) . '?conferenceDataVersion=1&sendUpdates=all', $event );
			} else {
				$event['conferenceData'] = [ 'createRequest' => [
					'requestId' => 'aq-' . $gid . '-' . $key . '-' . $start,
					'conferenceSolutionKey' => [ 'type' => 'hangoutsMeet' ],
				] ];
				$res = self::api( 'POST', '/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', $event );
			}
			if ( ! $res || empty( $res['id'] ) ) { continue; }

			$meet = self::meet_url( $res );
			Data::upsert( 'aq_grant_meetings', [ 'grant_id' => $gid, 'reminder_key' => $key ], [
				'start_ts' => $start, 'end_ts' => $end, 'meet_url' => $meet,
				'gcal_event_id' => $res['id'], 'ics_uid' => $res['iCalUID'] ?? '', 'created' => Data::now(),
			] );

			// Tell every registrant about the session (idempotent per member+meeting).
			$when = wp_date( 'D j M, g:i a T', $start );
			foreach ( $people as $p ) {
				Notify::push(
					(int) $p['user_id'], 'meeting',
					'Grant working session scheduled',
					$g['title'] . ' — ' . $when . ( $meet ? ' · join: ' . $meet : '' ),
					$meet ?: home_url( '/outreach/' ), 'meet' . $gid . '-' . $key
				);
			}
		}
	}
}
