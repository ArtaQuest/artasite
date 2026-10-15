<?php
namespace ATR;

if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * One purpose-built table, versioned and installed with dbDelta (never wp_posts/postmeta).
 *
 * wp_aq_artatask_review — one row per (platform, handle) the platforms suggested.
 *   status          pending | included | excluded (only Arash moves it off pending)
 *   decided_at      when status last changed by hand
 *   request_sent_at set by the phone after it sent the connection/follow request
 *   accepted_at     set when the request was accepted / followed back;
 *                   accepted_at - request_sent_at is the time-to-acceptance
 *   photo           stored file path or URL of the profile photo
 *   connections     LinkedIn connections (NULL where the platform has none)
 *
 * The name carries the aq_ prefix only so AQ\Extra::PRIVATE_TABLES can withhold it; it is not
 * part of the public aq_* data set. No prefix-length index (`col(180)`): dbDelta emits no table
 * at all for that form under Studio's SQLite.
 */
class Schema {
	const VERSION = '1';
	const OPT     = 'atr_table_version';
	const TABLE   = 'aq_artatask_review';

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		$t       = self::table();
		$charset = $wpdb->get_charset_collate();
		dbDelta( "CREATE TABLE {$t} (
  id bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  platform varchar(16) NOT NULL,
  handle varchar(191) NOT NULL,
  profile_url varchar(500) NOT NULL DEFAULT '',
  full_name varchar(255) NOT NULL DEFAULT '',
  tagline varchar(500) NOT NULL DEFAULT '',
  bio text NULL,
  photo varchar(500) NOT NULL DEFAULT '',
  followers int(10) unsigned NULL,
  following int(10) unsigned NULL,
  connections int(10) unsigned NULL,
  mutuals int(10) unsigned NULL,
  source varchar(32) NOT NULL DEFAULT 'suggested',
  status varchar(16) NOT NULL DEFAULT 'pending',
  discovered_at datetime NOT NULL,
  updated_at datetime NOT NULL,
  decided_at datetime NULL,
  request_sent_at datetime NULL,
  accepted_at datetime NULL,
  notes text NULL,
  PRIMARY KEY  (id),
  UNIQUE KEY platform_handle (platform,handle),
  KEY status_id (status,id),
  KEY platform_status_id (platform,status,id)
) {$charset};" );
		update_option( self::OPT, self::VERSION, false );
	}

	public static function maybe_upgrade() {
		if ( get_option( self::OPT ) !== self::VERSION ) { self::install(); }
	}
}
