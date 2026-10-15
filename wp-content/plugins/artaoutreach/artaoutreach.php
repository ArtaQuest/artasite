<?php
/**
 * Plugin Name: ArtaOutreach
 * Description: Review queue for accounts the platforms suggested to Arash (LinkedIn, Facebook,
 *              Instagram, X). Each one is included in or excluded from the study by hand; the
 *              ArtaTask phone app only ever sends to accounts marked "included" here.
 * Version:     0.1.0
 * Author:      ArtaQuest Foundation
 * License:     GNU AGPLv3
 * License URI: https://www.gnu.org/licenses/agpl-3.0.html
 * Text Domain: artaoutreach
 *
 * PRIVATE DATA. Unlike the aq_* tables, these rows describe third parties who never joined
 * ArtaQuest. The table is admin-only, withheld from /data, /schema and /offline via
 * AQ\Extra::PRIVATE_TABLES, and every route requires manage_options. See README.md.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

// Keep equal to the header above.
define( 'AOR_VERSION', '0.1.0' );
define( 'AOR_FILE', __FILE__ );

foreach ( [ 'Schema', 'Store', 'Rest', 'Csv', 'Admin' ] as $aor_cls ) {
	require_once __DIR__ . '/src/' . $aor_cls . '.php';
}

register_activation_hook( __FILE__, [ 'ArtaOutreach\\Schema', 'install' ] );
add_action( 'plugins_loaded', [ 'ArtaOutreach\\Schema', 'maybe_upgrade' ] );
add_action( 'rest_api_init', [ 'ArtaOutreach\\Rest', 'register' ] );
if ( is_admin() ) { ArtaOutreach\Admin::boot(); }
