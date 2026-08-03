<?php
/**
 * Header language selector — fills the slot previously held by the
 * ArtaQuest search button. Renders the artaquest-i18n plugin's switcher
 * when the plugin is active.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}
if ( class_exists( 'AQ_I18N_Switcher' ) ) {
	echo '<div class="header__language-selector">';
	echo AQ_I18N_Switcher::render(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	echo '</div>';
}
