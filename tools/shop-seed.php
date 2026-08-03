<?php
/**
 * ArtaShop catalogue — the FINAL two items (operator directive 2026-07-05): ArtaRPS Cards
 * + ArtaMug. Idempotent by slug (safe to run on local + prod, re-runs update). The earlier
 * placeholder items (ASPECTS deck, Truth-Seekers deck, tee, A3 print) were removed 2026-07-05;
 * this seed never resurrects them. Design files live in wp-content/uploads/shop/ and are
 * openly downloadable (linked from each summary).
 * Run: studio wp eval 'require ABSPATH . "shop-seed.php";' after copying into the WP root.
 */
AQ\Shop::ensure_tables();
$rows = [
	[
		'kind' => 'game', 'slug' => 'artarps-the-wheel-of-hands-145-card-deck',
		'title' => 'ArtaRPS Cards',
		'summary' => 'Rock–paper–scissors, grown to twelve. Twelve decks of twelve hand-sign tools (Gun, Plow, Scissors, Cup, Bolt, Wheat, Wedge, Hook, Arrow, Rock, Saw, Net) plus the rules card, in a tuck box. Each card is one hand, one name, and the two laws that matter — who it takes ("Saw cuts the Plow") and who takes it ("Hook jams the Saw") — with a QR to its living digital twin. 2–12 players — three easy rings (four tools, four rounds) or the advanced full wheel. Play free online at artaquest.com/game/artarps. Professionally printed (poker size, 300 gsm); the full print-ready files are openly downloadable at https://artaquest.com/wp-content/uploads/shop/artarps-print-en-v3-1.zip if you would rather print your own. English edition first — 19 more languages follow.',
		'image' => 'https://artaquest.com/wp-content/uploads/shop/artarps-card-v3.png',
		'price_coins' => 45, 'weight_g' => 350, 'stock' => -1,
	],
	[
		'kind' => 'merch', 'slug' => 'artaquest-mug',
		'title' => 'ArtaMug',
		'summary' => 'The brand equation on a ceramic mug: the gold A through the blue ring, and the two colours that complete to light — #E8B923 + #1746DC = #FFFFFF. Dark-space glaze, printed full-wrap, dishwasher safe. The print-ready wrap file is openly downloadable at https://artaquest.com/wp-content/uploads/shop/artamug-wrap-v1.svg if you would rather print your own.',
		'image' => 'https://artaquest.com/wp-content/uploads/shop/artamug-v1.svg',
		'price_coins' => 85, 'weight_g' => 380, 'stock' => -1,
	],
];
global $wpdb;
$t = $wpdb->prefix . 'aq_products';
foreach ( $rows as $r ) {
	$r += [ 'status' => 'published', 'updated' => time() ];
	$id = (int) $wpdb->get_var( $wpdb->prepare( "SELECT id FROM {$t} WHERE slug = %s", $r['slug'] ) );
	if ( $id ) {
		$wpdb->update( $t, $r, [ 'id' => $id ] );
		echo "updated {$r['slug']} (#{$id})\n";
	} else {
		$wpdb->insert( $t, $r + [ 'created' => time() ] );
		echo "created {$r['slug']} (#{$wpdb->insert_id})\n";
	}
}
// The retired placeholders stay retired, whatever state a stale DB has them in.
foreach ( [ 'aspects-zodiac-strategy-game', 'truth-seekers-deceivers-battle-deck', 'artaquest-tee', 'studio-illustration-print-a3' ] as $slug ) {
	$wpdb->query( $wpdb->prepare( "UPDATE {$t} SET status = 'removed', updated = %d WHERE slug = %s AND status != 'removed'", time(), $slug ) );
}
echo 'published products: ' . (int) $wpdb->get_var( "SELECT COUNT(*) FROM {$t} WHERE status = 'published'" ) . "\n";
