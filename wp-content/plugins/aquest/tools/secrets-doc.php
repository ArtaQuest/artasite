<?php
/**
 * Generates docs/SECRETS.md from src/SecretRegistry.php, so the doc, the AQ Security page and the
 * code read from ONE definition.
 *
 *   php wp-content/plugins/aquest/tools/secrets-doc.php --write   # regenerate the doc
 *   php wp-content/plugins/aquest/tools/secrets-doc.php --check   # exit 1 when the doc is stale (preflight)
 */
namespace AQ;

define( 'ABSPATH', __DIR__ );
require __DIR__ . '/../src/SecretRegistry.php';

$root = dirname( __DIR__, 4 );
$path = $root . '/docs/SECRETS.md';
$md   = function ( $s ) { return str_replace( [ '|', "\n" ], [ '\\|', ' ' ], (string) $s ); };
$rot  = function ( $tier ) { $d = SecretRegistry::ROTATE[ $tier ]; return $d ? "every {$d} days ({$tier})" : 'no rotation'; };
$old  = function ( $n ) { $o = SecretRegistry::ALIASES[ $n ] ?? []; return $o ? implode( ', ', array_map( fn( $x ) => "`$x`", $o ) ) : '—'; };

$o  = "# Secrets and settings\n\n";
$o .= "<!-- GENERATED from wp-content/plugins/aquest/src/SecretRegistry.php by tools/secrets-doc.php --write. Do not edit by hand; preflight fails when this file is stale. -->\n\n";
$o .= "Every secret and setting that production artaquest.com reads, grouped by purpose. The same definitions drive the **wp-admin → AQ Security** page (descriptions, groups, rotation clock) and the `ops.secrets` health check.\n\n";
$o .= "## How it works\n\n";
$o .= "- **Define** — `src/SecretRegistry.php`: name, group, tier, purpose, who reads it, where to get or rotate it, what breaks without it, and its old names.\n";
$o .= "- **Resolve** — `Secrets::get('NAME')` reads the encrypted vault first, then the environment, then a `wp-config.php` constant. Asking for an old name, or storing under one, still works.\n";
$o .= "- **Store** — `src/Vault.php`: the encrypted vault file (`wp-content/aq-vault.php`, libsodium, keyed from `AUTH_KEY`/`AUTH_SALT`) and the AQ Security page. Values are write-only: the page shows set/unset, source, age and the last 4 characters, never a value. The database is public, so a secret never goes in it.\n";
$o .= "- **Watch** — `src/Watchdog.php`: rotation due, compromised flags, vault-file changes, the leak sweep of public options, honeypot traps, and the audit log.\n\n";
$o .= "**Adding a key:** add it to `SecretRegistry::KEYS`, read it with `Secrets::get`, run `tools/secrets-doc.php --write`. Only list a name that production code reads — a local script reads its own environment variable. No `AQ_` prefix.\n\n";
$o .= "## Rotation policy\n\n| Tier | Clock | For |\n|---|---|---|\n";
$o .= "| critical | 90 days | moves money, sends mail as us, or writes our storage/Cloudflare account |\n";
$o .= "| standard | 180 days | one bot, one route, or one integration |\n";
$o .= "| low | 365 days | a narrow token that only publishes our own public work or reads public data |\n";
$o .= "| none | — | not a credential: identifiers, addresses, endpoints, publishable keys, flags |\n\n";
$o .= "Rotate on the clock, and immediately when a value may have been exposed (use **Flag leaked** on the page first). To rotate: create the new value at the issuer, paste it into **Rotate** on AQ Security, check the feature works, then revoke the old value at the issuer.\n\n";
$o .= "**Need:** `required` = the health check fails without it; `optional` = the feature is off without it; a NAME = either this or that one is enough.\n\n";

$o .= "## Summary\n\n| Name | Group | Tier | Rotation | Need | Old name |\n|---|---|---|---|---|---|\n";
foreach ( SecretRegistry::KEYS as $n => $k ) {
	$sp = SecretRegistry::spec( $n );
	$o .= "| `$n` | {$sp['group']} | {$sp['tier']} | " . ( $sp['days'] ? $sp['days'] . ' d' : '—' ) . ' | ' . ( $sp['alt'] ? 'or `' . $sp['alt'] . '`' : $sp['need'] ) . ' | ' . $old( $n ) . " |\n";
}
$o .= "\n";

foreach ( SecretRegistry::GROUPS as $g => $gdesc ) {
	$o .= "## $g\n\n" . $gdesc . "\n\n";
	foreach ( SecretRegistry::KEYS as $n => $k ) {
		if ( $k[0] !== $g ) { continue; }
		$sp = SecretRegistry::spec( $n );
		$o .= "### `$n`\n\n";
		$o .= "- **Purpose:** " . $sp['desc'] . "\n";
		$o .= "- **Used by:** " . $sp['used_by'] . "\n";
		$o .= "- **Get / rotate:** " . $sp['issuer'] . "\n";
		$o .= "- **Rotation:** " . $rot( $sp['tier'] ) . "\n";
		$o .= "- **Need:** " . ( $sp['alt'] ? 'this or `' . $sp['alt'] . '`' : $sp['need'] ) . "\n";
		$o .= "- **If missing:** " . $sp['breaks'] . "\n";
		if ( isset( SecretRegistry::ALIASES[ $n ] ) ) { $o .= "- **Old name (still works):** " . $old( $n ) . "\n"; }
		$o .= "\n";
	}
}

$o .= "## Renamed on 2026-10-26\n\nOld names keep resolving from the vault, the environment and `wp-config.php`. The first admin page load (or the next Watchdog run) moves vault entries to the new name — the ciphertext is copied unchanged and each move is written to the audit log by name only. A constant or env var with an old name keeps working; rename it at leisure.\n\n";
$o .= "| Old name | New name |\n|---|---|\n";
foreach ( SecretRegistry::ALIASES as $n => $olds ) { foreach ( $olds as $x ) { $o .= "| `$x` | `$n` |\n"; } }
foreach ( SecretRegistry::ALIAS_PREFIXES as $new => $oldp ) { $o .= "| `{$oldp}<TIER>` | `{$new}<TIER>` |\n"; }
$o .= "\n## Removed — no production code reads these\n\nA stored value for one of these appears under **Unused — safe to forget** on AQ Security, never alarms, and is removed by **Forget** (one row) or **Forget all unused** (every unused row; each name is written to the audit log). An old-name copy whose new name already holds its own value is listed there too.\n\n";
$o .= "| Name | Why |\n|---|---|\n";
foreach ( SecretRegistry::RETIRED as $n => $why ) { $o .= "| `$n` | " . $md( $why ) . " |\n"; }

$mode = $argv[1] ?? '--check';
if ( $mode === '--write' ) { file_put_contents( $path, $o ); echo "wrote docs/SECRETS.md (" . count( SecretRegistry::KEYS ) . " keys)\n"; exit( 0 ); }
$cur = @file_get_contents( $path );
if ( $cur !== $o ) { echo "docs/SECRETS.md is stale — run: php wp-content/plugins/aquest/tools/secrets-doc.php --write\n"; exit( 1 ); }
echo "docs/SECRETS.md matches the registry (" . count( SecretRegistry::KEYS ) . " keys)\n";
