<?php
/**
 * Plugin Name: ArtaTask Review
 * Description: Review queue for accounts the platforms suggested to Arash (LinkedIn, Facebook,
 *              Instagram, X). Each one is included in or excluded from the study by hand; the
 *              ArtaTask phone app only ever sends to accounts marked "included" here.
 * Version:     0.1.0
 * Author:      ArtaQuest Foundation
 * License:     GNU AGPLv3
 * License URI: https://www.gnu.org/licenses/agpl-3.0.html
 *
 * PRIVATE DATA. Unlike the aq_* tables, these rows describe third parties who never joined
 * ArtaQuest. The table is admin-only, withheld from /data, /schema and /offline via
 * AQ\Extra::PRIVATE_TABLES, and every route requires manage_options. See README.md.
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

// Keep equal to the header above.
define( 'ATR_VERSION', '0.1.0' );
define( 'ATR_FILE', __FILE__ );

foreach ( [ 'Schema', 'Store', 'Rest', 'Admin' ] as $atr_cls ) {
	require_once __DIR__ . '/src/' . $atr_cls . '.php';
}

register_activation_hook( __FILE__, [ 'ATR\\Schema', 'install' ] );
add_action( 'plugins_loaded', [ 'ATR\\Schema', 'maybe_upgrade' ] );
add_action( 'rest_api_init', [ 'ATR\\Rest', 'register' ] );
if ( is_admin() ) { ATR\Admin::boot(); }
