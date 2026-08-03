<?php
/**
 * Plugin Name: ArtaQuest — Default Profile Pictures
 * Description: Every member should show a profile picture everywhere avatars appear, even with no
 *              uploaded photo. Gravatar's built-in defaults don't fit a dark, on-brand UI: the
 *              "identicon"/"mystery" family bakes in a white background, and the old transparent
 *              ("blank") default rendered as an EMPTY RING with no picture at all (ticket #113 — the
 *              leaderboard symptom). So for any member WITHOUT a real Gravatar we repoint Gravatar's
 *              `d=` fallback at our own self-hosted brand emblem (/wp-json/aq/v1/emblem): a
 *              theme-adaptive, deterministic initials disc — gold or blue, never a white box, never
 *              blank, never a 404. Because the rewrite lives on core's `get_avatar_url` / `get_avatar`
 *              filters (which fire inside get_avatar_data), it covers every avatar surface at once —
 *              the leaderboard, discussions, profiles, the catalogue, server-rendered HTML.
 *
 *              Real avatars are untouched: an uploaded profile photo (a non-gravatar URL, set by the
 *              plugin/theme via pre_get_avatar_data) is skipped by the gravatar.com guard, and a real
 *              user Gravatar still wins because `d=` is only ever served when no Gravatar exists for
 *              the address (force_default stays false).
 */

if ( ! defined( 'ABSPATH' ) ) { exit; }

/** Resolve a WP user id from the several shapes core passes the avatar filters (id, WP_User, comment, email). */
function aq_avatar_uid( $id_or_email ) {
	if ( is_numeric( $id_or_email ) )        { return (int) $id_or_email; }
	if ( $id_or_email instanceof WP_User )   { return (int) $id_or_email->ID; }
	if ( $id_or_email instanceof WP_Comment ) {
		if ( ! empty( $id_or_email->user_id ) ) { return (int) $id_or_email->user_id; }
		if ( ! empty( $id_or_email->comment_author_email ) ) {
			$u = get_user_by( 'email', $id_or_email->comment_author_email );
			return $u ? (int) $u->ID : 0;
		}
		return 0;
	}
	if ( is_object( $id_or_email ) && ! empty( $id_or_email->user_id ) ) { return (int) $id_or_email->user_id; }
	if ( is_string( $id_or_email ) && is_email( $id_or_email ) ) {
		$u = get_user_by( 'email', $id_or_email );
		return $u ? (int) $u->ID : 0;
	}
	return 0;
}

/**
 * The self-hosted brand-emblem URL used as a member's default profile picture — a deterministic,
 * theme-adaptive initials disc. Seeded by the member's nicename so the gold/blue choice is stable,
 * and labelled with their display name so it shows their initials. Falls back to a neutral label for
 * an anonymous / unresolvable address so the result is never blank.
 */
function aq_avatar_emblem_url( $id_or_email ) {
	$seed  = '';
	$label = '';
	$uid   = aq_avatar_uid( $id_or_email );
	if ( $uid ) {
		$u = get_userdata( $uid );
		if ( $u ) {
			$seed  = (string) $u->user_nicename;
			$label = (string) $u->display_name;
		}
	}
	if ( '' === $label ) { $label = 'Quester'; } // matches the backend's name for an unknown member
	if ( '' === $seed )  { $seed  = $label; }
	// A single-encoded, valid emblem URL. It is rawurlencoded again where it's embedded as the gravatar
	// `d=` value, so gravatar decodes it once and 302-redirects the browser straight to this URL.
	return rest_url( 'aq/v1/emblem' ) . '?seed=' . rawurlencode( $seed ) . '&label=' . rawurlencode( $label );
}

/**
 * Swap a built Gravatar URL's `d=<built-in default>` fallback for our self-hosted emblem. Operates on
 * either a bare URL (get_avatar_url) or an <img> HTML string (get_avatar) — the `d=<keyword>` match is
 * unambiguous regardless of whether the separator is a raw `&` or the entity-encoded `&#038;`. A real
 * uploaded photo (non-gravatar URL) is left alone, and a real Gravatar keeps serving its own image
 * (the `d=` fallback only applies when the address has no Gravatar).
 */
function aq_avatar_swap_default( $s, $id_or_email ) {
	if ( ! is_string( $s ) || false === strpos( $s, 'gravatar.com' ) ) { return $s; }
	return preg_replace_callback(
		'/(?<![a-z0-9])d=(identicon|mp|mm|mystery|monsterid|wavatar|retro|robohash|blank)(?![a-z0-9])/i',
		static function () use ( $id_or_email ) {
			return 'd=' . rawurlencode( aq_avatar_emblem_url( $id_or_email ) );
		},
		$s
	);
}

// The URL the SPA / REST sees (leaderboard, discussions, profiles, catalogue) — the ticket #113 path.
add_filter( 'get_avatar_url', 'aq_avatar_swap_default', 20, 2 );

// Server-rendered get_avatar() HTML (legacy comment / author templates) — same fallback, for parity.
add_filter( 'get_avatar', 'aq_avatar_swap_default', 20, 2 );
