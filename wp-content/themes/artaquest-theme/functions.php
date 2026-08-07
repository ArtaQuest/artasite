<?php
// ── iter-222: dark color-scheme hint ────────────────────────────────────────
// Tells the user-agent that the site prefers a dark surface for native
// scrollbars + form widgets. Pairs with `color-scheme: dark` on `:root` in
// style.css so the cascade settles correctly even when the meta is missed.
add_action( 'wp_head', function () {
    echo '<meta name="color-scheme" content="dark light">' . "\n";
}, 1 );

// ── iter-223 (user directive 2026-05-24): Kaggle header — language is the
// LAST item of the primary nav (with a dropdown caret), not a separate
// trailing element. Opt the artaquest-i18n switcher back into auto-injection
// so it appends as the final <li> of `.starter-menu`. The Switcher's own
// `static $done` guard keeps it to a single append per request, and the
// inline header menu is the first `wp_nav_menu` call so it wins the slot.
// Registered at functions.php load (before the plugin's `init`-time boot()
// reads this filter). Logged-in users still get the switcher in the drawer.
add_filter( 'ay_i18n_auto_inject_switcher', '__return_true' );

// ── iter-223: priority-nav "⋯" overflow for the desktop inline menu ─────────
// When the inline nav items can't all fit on one row, the trailing ones are
// moved (last-first) into a "⋯" dropdown so the header never overfills. The
// Language item stays pinned as the last visible element; the ⋯ sits just
// before it. Desktop-only (≤1024 the .aq-drawer owns navigation). Pure
// progressive enhancement — with JS off, every item simply renders inline.
add_action( 'wp_footer', function () {
    if ( is_admin() ) {
        return;
    }
    ?>
<script id="aq-nav-overflow-js">
(function () {
    'use strict';
    var nav = document.getElementById('aq-primary-nav'); // ul.starter-menu
    if (!nav) { return; }
    var mq       = window.matchMedia('(min-width: 1025px)');
    var langItem = nav.querySelector('.ay-langsw-menu-item');
    var section  = nav.closest('.navigation') || nav.parentNode; // the flex row

    // Build the "⋯" control once.
    var moreLi = document.createElement('li');
    // Start hidden via a class (not inline display): the theme's
    // `.starter-menu > li { display:inline-flex !important }` would override an
    // inline `display:none`, so `.is-hidden` carries its own !important.
    moreLi.className = 'menu-item aq-nav-more is-hidden';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'aq-nav-more__btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', <?php echo wp_json_encode( __( 'More navigation', 'artaquest' ) ); ?>);
    // Plain text node (not a <span>) so the theme's blanket
    // `.starter-menu * { display:none }` rule can't hide the glyph. The
    // button's aria-label is the accessible name, so the glyph stays silent.
    // Use the \u escape (not a literal ⋯): the i18n output-buffer engine
    // re-encodes non-ASCII to numeric HTML entities on translated pages, and
    // entities inside a <script> are NOT decoded by the parser — a literal ⋯
    // there became the visible text "&#8943;" on /ar/, /fa/, etc.
    btn.textContent = '\u22EF';
    var moreMenu = document.createElement('ul');
    moreMenu.className = 'aq-nav-more__menu';
    moreMenu.setAttribute('role', 'menu');
    moreLi.appendChild(btn);
    moreLi.appendChild(moreMenu);
    /* iter-248 (user 2026-05-24): Language must be the LAST visible nav item
       BEFORE the ⋯ (like Kaggle's "Data Hub"). So put ⋯ AFTER the language
       item: order becomes [...items] [Language ▾] [⋯]. */
    if (langItem) {
        if (langItem.nextSibling) { nav.insertBefore(moreLi, langItem.nextSibling); }
        else { nav.appendChild(moreLi); }
    } else {
        nav.appendChild(moreLi);
    }

    function regularItems() {
        return Array.prototype.filter.call(nav.children, function (li) {
            return li !== moreLi
                && !li.classList.contains('ay-langsw-menu-item')
                && !li.classList.contains('aq-nav-more');
        });
    }
    function collapseAll() {
        while (moreMenu.firstChild) { nav.insertBefore(moreMenu.firstChild, moreLi); }
    }
    function openMenu()  { moreMenu.classList.add('is-open');    btn.setAttribute('aria-expanded', 'true'); }
    function closeMenu() { moreMenu.classList.remove('is-open'); btn.setAttribute('aria-expanded', 'false'); }

    /* Kaggle exact carbon-copy (iter-250, user directive 2026-05-24): the
       visible primary nav is an EXPLICIT whitelist in a fixed order —
       Courses, Rankings, Careers — then Language (pinned, last item
       before ⋯), then ⋯ which houses EVERYTHING ELSE (Home, About,
       Bursaries, Donate, FAQ…). Matches Kaggle's "4 items + ⋯" shape with
       Language playing the "Data Hub" role. */
    var PRIMARY = ['courses', 'ranking', 'career'];   // lowercase substring match, in order
    function labelOf(li) { return (li.textContent || '').trim().toLowerCase(); }

    function recalc() {
        closeMenu();
        collapseAll();
        moreLi.classList.add('is-hidden');
        if (!mq.matches) { return; }                       // mobile → drawer
        if (getComputedStyle(nav).display === 'none') { return; } // logged-in sidebar

        var items = regularItems();
        /* Partition: whitelist (keep visible, in PRIMARY order) vs the rest
           (fold into ⋯). */
        var primary = [];
        PRIMARY.forEach(function (key) {
            var hit = items.find(function (li) { return labelOf(li).indexOf(key) === 0 || labelOf(li).indexOf(key) !== -1; });
            if (hit && primary.indexOf(hit) === -1) { primary.push(hit); }
        });
        var rest = items.filter(function (li) { return primary.indexOf(li) === -1; });

        /* Reorder the visible primaries to sit first, in PRIMARY order,
           immediately before the langItem. */
        primary.forEach(function (li) {
            if (langItem) { nav.insertBefore(li, langItem); }
            else { nav.insertBefore(li, moreLi); }
        });

        /* Fold every non-primary item into ⋯ (preserve their order). */
        if (rest.length) {
            moreLi.classList.remove('is-hidden');
            rest.forEach(function (li) { moreMenu.appendChild(li); });
        }

        /* Safety: if the row still overflows (very narrow desktop), fold the
           trailing primaries too — but never the langItem. */
        function tooWide() { return section.scrollWidth > section.clientWidth + 1; }
        var guard = 0;
        while (tooWide() && guard++ < 20) {
            var vis = regularItems();
            if (vis.length <= 1) { break; }
            moreLi.classList.remove('is-hidden');
            moreMenu.insertBefore(vis[vis.length - 1], moreMenu.firstChild);
        }
        if (!moreMenu.children.length) { moreLi.classList.add('is-hidden'); }
    }

    btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        if (moreMenu.classList.contains('is-open')) { closeMenu(); } else { openMenu(); }
    });
    document.addEventListener('click', function (e) {
        if (!moreLi.contains(e.target)) { closeMenu(); }
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' || e.keyCode === 27) { closeMenu(); }
    });

    var t;
    function schedule() { clearTimeout(t); t = setTimeout(recalc, 120); }
    window.addEventListener('resize', schedule);
    if (mq.addEventListener) { mq.addEventListener('change', schedule); }

    recalc();
    if (document.fonts && document.fonts.ready) { document.fonts.ready.then(recalc); }
    setTimeout(recalc, 600);
})();
</script>
    <?php
}, 20 );

// ── iter-110 #431 (diego slow-3G FOUC): inline critical CSS ─────────────────
// On slow connections style.css arrives ~18s after first paint, so visitors
// saw the legacy header (clipped "rtaQuest", hamburger right) until JS
// hydrated the new iter-108 drawer layout. Inline the absolute-minimum rules
// the header needs at first paint to render the new layout immediately,
// regardless of stylesheet load time. ~700 bytes — cheap insurance.
add_action( 'wp_head', function () {
    ?>
<style id="aq-critical-css">
:root { color-scheme: dark; }
html, body { background:#010C17 !important; color:rgba(255,255,255,.92); }
.aq-drawer, .aq-drawer__backdrop { display:none !important; }
.aq-drawer.is-open, .aq-drawer__backdrop.is-open { display:flex !important; }
.ay-logo__wordmark-mobile { display:none !important; }
@media (max-width:600px) {
  .ay-logo--ltr > svg:not(.ay-logo__wordmark-mobile) { display:none !important; }
  .ay-logo--ltr .ay-logo__wordmark-mobile { display:block !important; height:40px !important; }
}
/* iter-133 (ren #466): the older `.navigation .starter-menu { display:none !important }`
   line unconditionally hid the primary nav, beating my iter-132 desktop
   inline-nav rule via cascade source order (critical CSS prints in the
   head BEFORE style.css). Now hide ONLY at mobile widths so the
   Kaggle-style inline nav renders on desktop. */
@media (max-width:1024px) {
  .navigation .starter-menu { display:none !important; }
}
.navigation { display:flex !important; align-items:center; gap:8px; }
.navigation .starter-logo { order:2; }
</style>
    <?php
}, 1 );

/* iter-142 #484 (freya): /en/ returns 404 because English is the unprefixed
   canonical locale — AQ_I18N_Router strips known prefixes but `en` was
   never a "prefix to strip", it was the implicit default. Search engines
   following hreflang `<link rel="alternate" hreflang="en" href="/en/">`
   land on a dead page. Server-side redirect /en/ → / preserving the
   sub-path so hreflang stays valid AND visitors who type /en/ explicitly
   get the homepage. */
add_action( 'template_redirect', function () {
	if ( is_admin() || wp_doing_cron() || wp_doing_ajax() ) {
		return;
	}
	$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
	if ( preg_match( '#^/en(/|$)#', $path ) ) {
		$new = preg_replace( '#^/en(/|$)#', '/', $path );
		if ( '/' === $new || '' === $new ) {
			$new = '/';
		}
		wp_safe_redirect( $new, 301 );
		exit;
	}
}, 1 );

// ── ArtaQuest brand mark — "Aquest" wordmark (no background) ─────────────────
// iter-348c (user 2026-05-25): bicolour "Aquest" — capital A in --yang gold,
// "quest" lowercase in --yin blue. No tile / no background. Single inline SVG
// used sitewide. The $height arg is the only size knob; width follows aspect.
function aq_brand_svg( $height = 32 ) {
    // Brand mark (user 2026-05-30): the supplied artwork — a SOLID gold "A" (the Why)
    // cutting through a blue ring (the How). The ring is notched (masked) wherever the A
    // crosses it, leaving an even moat that shows THROUGH to whatever is behind the mark
    // (no background of its own); the A's thin crossbar matches the ring's line weight.
    // Language-agnostic graphic — identical across all 8 locales.
    // HARD BRAND INVARIANT: gold + blue sum to white per channel — yin + yang complete to
    // light. Blue is DERIVED as 255-gold, never typed by hand. This shipped as #4A72FF,
    // which sums to (306,299,290) — a super-white that merely clips — so the header mark
    // did not match <LogoMark/> in the SPA (which uses the canonical --color-yin) nor the
    // favicon. Regenerate the raster/SVG kit with tools/brand-kit.py after any change here.
    // Shared mask id across inline instances (all identical, so fine).
    $height  = (int) $height;
    $gold    = '#E8B923';   // --color-yang (canonical, ArtaContrast Standard K=1)
    $blue    = sprintf(     // --color-yin = 255 - gold, per channel
        '#%02X%02X%02X',
        255 - hexdec( substr( $gold, 1, 2 ) ),
        255 - hexdec( substr( $gold, 3, 2 ) ),
        255 - hexdec( substr( $gold, 5, 2 ) )
    );
    $a_outer = 'M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z';
    $a_full  = $a_outer . 'M50 34.55L38.57 59.3L61.43 59.3Z';   // + triangular counter
    return sprintf(
        '<svg class="aq-brand-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        . 'width="%1$d" height="%1$d" role="img" aria-label="%2$s" focusable="false" fill="none">'
        . '<defs><mask id="aq-brand-ring-cut">'
        . '<rect width="100" height="100" fill="white"/>'
        . '<path d="%5$s" fill="black" stroke="black" stroke-width="7" stroke-linejoin="round"/>'
        . '</mask></defs>'
        // The colours go in as INLINE STYLE, not as fill=/stroke= presentation attributes.
        // index.css carries a global sentinel remap ([fill="#E8B923"]{fill:var(--ico-gold)},
        // [stroke="#4A72FF"]{...}) that swaps brand hexes for the theme-adaptive LEGIBLE INKS
        // — right for icons and links, fatal for the logo: --ico-gold is #8A6300 on light and
        // #8A6300 + #1746DC is not white. An inline style beats an attribute selector, so the
        // mark keeps the canonical pair wherever it renders. Same reason <LogoMark/> in the SPA
        // uses style={{...}} rather than the fill= attribute.
        . '<circle cx="50" cy="50" r="41.6" fill="none" style="stroke:%3$s" stroke-width="11.66" mask="url(#aq-brand-ring-cut)"/>'
        . '<path style="fill:%4$s" fill-rule="evenodd" d="%6$s"/>'
        . '</svg>',
        $height,
        esc_attr( get_bloginfo( 'name' ) ),
        $blue,
        $gold,
        $a_outer,
        $a_full
    );
}

function aq_brand_css_vars() {
    return '
:root {
    /* ════════════════════════════════════════════════════════════════════
       iter-256 (2026-05-24): FULL Kaggle dark-theme carbon copy. The
       gold/blue brand palette is remapped to Kaggle dark tokens (measured
       from the logged-in dashboard). Var NAMES kept so every existing rule
       that references them cascades to the new palette automatically.
         Kaggle dark: bg #1C1D20 · surface #202124 · elevated #2E3033 ·
         text #E8EAED · secondary #9AA0A6 · border #5F6368 · accent #20BEFF
       (See [[full-kaggle-theme]].)
       ════════════════════════════════════════════════════════════════════ */
    /* iter-257 (user 2026-05-24): KEEP our two brand accents (gold + blue)
       ON the Kaggle dark theme. Only the surfaces/text/font are Kaggle;
       the accent colours stay ArtaQuest gold #E8B923 + blue #1746DC. */
    --yang:           #E8B923;
    --yang-light:     #F5D060;
    --yang-dark:      #C49B1A;
    --yang-glow:      rgba(232,185,35,.18);
    --yang-soft:      rgba(232,185,35,.08);
    /* YIN = 255 - YANG, PER CHANNEL. Gold and blue are exact additive complements: they sum to
       white, because yin and yang complete to light. This pair was #486EE1 (an iter-257 blue that
       predates the rule), which sums to 304, 295, 260 -- a super-white that merely CLIPS, and looks
       fine while being wrong. The SPA already computes the canonical #1746DC (lib/contrast.ts,
       index.css), so the theme was the only surface still emitting the old blue, and the two
       disagreed on every page that used both. AQ\Health::check_brand asserts this arithmetic now,
       so it cannot drift back unnoticed. Change --yang and this must be recomputed with it. */
    --yin:            #1746DC;
    --yin-light:      #4A72FF;
    --yin-dark:       #1A3DB5;
    --yin-glow:       rgba(23, 70, 220,.18);
    --yin-soft:       rgba(23, 70, 220,.08);
    /* iter-283 (user 2026-05-24): "use our old background everywhere" — the
       Kaggle gray surfaces are reverted to the ArtaQuest signature deep-space
       palette. The Kaggle LAYOUT/structure + Inter font stay; only the surface
       colours go back to our deep navy. (No apostrophes here: this is a PHP
       single-quoted return string — see [[php-single-quote-strings]].) */
    --space-1:        #010C17;   /* page bg — deepest */
    --space-2:        #06121E;   /* surface / card — mid-dark */
    --space-3:        #0C1E32;   /* elevated */

    /* Former LIGHT page tokens map to our dark-space palette too, so any
       "light" section renders on our deep navy (not Kaggle gray). */
    --light-1:        #010C17;
    --light-2:        #06121E;
    --light-3:        #0C1E32;

    /* Text → Kaggle dark-theme text colours */
    --text-h:         #E8EAED;   /* headings  (Kaggle #E8EAED) */
    --text-b:         #E8EAED;   /* body      */
    --text-m:         #9AA0A6;   /* muted/secondary (Kaggle #9AA0A6) */
    --white:          #E8EAED;   /* on-dark text → Kaggle near-white */
    --aq-border:      #3C4043;   /* Kaggle hairline border */

    /* Font → Inter everywhere (Kaggle UI font). Heading + body both Inter
       so same-text elements render identically to Kaggle. */
    --wp--preset--font-family--primary: Inter, system-ui, -apple-system, sans-serif;
    --wp--preset--font-family--body:    Inter, system-ui, -apple-system, sans-serif;

    /* iter-258 (user 2026-05-24): KEEP the bicolor blue→white→gold
       split-border — it is our unique theme signature. NOT overridden here;
       the gradient from style.css :root (using --yin/--yang) stands. */

    /* Plugin accent aliases */
    --accent_color:                    #E8B923;
    --second_accent_color:             #486EE1;
    --primary_color:                   #010C17;
    --color_accent:                    #E8B923;

    /* ArtaQuest LMS primary palette → yang (gold) */
    --artaquest-color--primary-100:  #E8B923;
    --artaquest-color--primary-200:  #F5D060;
    --artaquest-color--primary-70:   rgba(232,185,35,.7);
    --artaquest-color--primary-50:   rgba(232,185,35,.5);
    --artaquest-color--primary-30:   rgba(232,185,35,.3);
    --artaquest-color--primary-10:   rgba(232,185,35,.1);
    --artaquest-color--primary-5:    rgba(232,185,35,.05);
    --artaquest-color--primary-hover: rgba(232,185,35,.85);

    /* Navigation */
    --stm-lms-menu-separator-color:    #E8B923;
    --stm-lms-menu-link-hover-color:   #E8B923;
    --stm-lms-menu-link-color:         #FFFFFF;

    /* Search button — yin blue circle, white icon */
    --stm-lms-search-button-bg:        #486EE1;
    --stm-lms-search-button-color:     #FFFFFF;

    /* ArtaQuest accent alias (button.css uses var(--accent-100)) */
    --accent-100:   #E8B923;
    --accent-200:   #F5D060;

    /* Filter "SHOW RESULTS" button → yin blue */
    --lms-filter-filterButtonBgColor:        #486EE1;
    --lms-filter-filterButtonBgColorHover:   #1A3DB5;
    --lms-filter-filterButtonColor:          #FFFFFF;
    --lms-filter-filterButtonColorHover:     #FFFFFF;
    --lms-filter-filterButtonBorderRadius:   6px;

    /* Popup button text must be dark on gold background */
    --lms-preset-popupButtonColor:           #010C17;
    --lms-preset-popupButtonColorHover:      #FFFFFF;

    /* Button block */
    --wp-block-artaquest-button--bgColor:      #E8B923;
    --wp-block-artaquest-button--color:        #010C17;
    --wp-block-artaquest-button--bgHoverColor: #486EE1;
    --wp-block-artaquest-button--hoverColor:   #FFFFFF;

    /* Auth / sign-in links */
    --stm-lms-auth-links-login-icon-bg-color:      #E8B923;
    --stm-lms-auth-links-login-icon-color:         #010C17;
    --stm-lms-auth-links-login-link-color:         #FFFFFF;
    --stm-lms-auth-links-login-link-hover-color:   #E8B923;
    --stm-lms-auth-links-sing-in-icon-color:       #E8B923;
    --stm-lms-auth-links-sing-in-text-color:       #FFFFFF;
    --stm-lms-auth-links-sing-in-text-hover-color: #E8B923;
    --stm-lms-auth-links-sing-in-bg-color:         #06121E;
    --stm-lms-auth-links-sing-in-bg-hover-color:   #486EE1;

    /* ── LMS status/state colors → mapped to brand tokens ─────────────────
       The LMS ships with default "success" (#61cc2f green),
       "danger"/"error" (#ff3945 red), "info" (#438eff blue), "warning"
       (#ff1f59 pink) and several flat #4ed7a8 / #ff3945 / #227aff /
       #4d5e6f preset variables sprayed across course-archive +
       course-player + quiz components. The two-color brand
       (gold + blue) only allows yin (positive) and yang (highlight)
       for any state we surface to the learner, so we remap all of
       them to brand tokens. */
    --artaquest-color--success-100:  #486EE1;
    --artaquest-color--success-70:   rgba(72, 110, 225,.7);
    --artaquest-color--success-50:   rgba(72, 110, 225,.5);
    --artaquest-color--success-30:   rgba(72, 110, 225,.3);
    --artaquest-color--success-10:   rgba(72, 110, 225,.1);
    --artaquest-color--success-5:    rgba(72, 110, 225,.05);
    --artaquest-color--danger-100:   #486EE1;
    --artaquest-color--danger-70:    rgba(72, 110, 225,.7);
    --artaquest-color--danger-50:    rgba(72, 110, 225,.5);
    --artaquest-color--danger-30:    rgba(72, 110, 225,.3);
    --artaquest-color--danger-10:    rgba(72, 110, 225,.1);
    --artaquest-color--danger-5:     rgba(72, 110, 225,.05);

    /* Bare aliases for marker-question feedback. CSS uses unnamespaced
       var(--success-10) etc; without these defined the bg fell to
       transparent (Tomas realbot 2026-05-21). Success = yang gold for
       correct, danger = brand-adjacent warm red for wrong (same hue
       used by the donate-form validation message). */
    --success-100:   #E8B923;
    --success-70:    rgba(232,185,35,.7);
    --success-50:    rgba(232,185,35,.5);
    --success-30:    rgba(232,185,35,.3);
    --success-10:    rgba(232,185,35,.18);
    --success-5:     rgba(232,185,35,.08);
    --danger-100:    #FF6B6B;
    --danger-70:     rgba(255,107,107,.7);
    --danger-50:     rgba(255,107,107,.5);
    --danger-30:     rgba(255,107,107,.3);
    --danger-10:     rgba(255,107,107,.18);
    --danger-5:      rgba(255,107,107,.08);
    --artaquest-color--info-100:     #486EE1;
    --artaquest-color--info-70:      rgba(72, 110, 225,.7);
    --artaquest-color--info-50:      rgba(72, 110, 225,.5);
    --artaquest-color--info-30:      rgba(72, 110, 225,.3);
    --artaquest-color--info-10:      rgba(72, 110, 225,.1);
    --artaquest-color--info-5:       rgba(72, 110, 225,.05);
    --artaquest-color--warning-100:  #E8B923;
    --artaquest-color--warning-70:   rgba(232,185,35,.7);
    --artaquest-color--warning-50:   rgba(232,185,35,.5);
    --artaquest-color--warning-30:   rgba(232,185,35,.3);
    --artaquest-color--warning-10:   rgba(232,185,35,.1);
    --artaquest-color--warning-5:    rgba(232,185,35,.05);

    /* Status preset chips painted by lms-preset-* variables */
    --lms-preset-statusNewBgColor:           #486EE1;  /* was #61cc2f */
    --lms-preset-statusEnrolledBgColor:      #486EE1;
    --lms-preset-statusCompletedBgColor:     #E8B923;
    --lms-preset-statusFailedBgColor:        #1A3DB5;
}

/* ── Last-mile color overrides for compiled LMS blocks ────────────────────
   Some Gutenberg block stylesheets bake the LMS default hexes directly
   into class rules (not via CSS variables), so the var overrides above
   cannot reach them. Map the specific selectors that surface on /courses/. */
.lms-courses-filter-option-clear-all,
.artaquest-course-status--new,
.artaquest-status-new {
    background-color: var(--yin) !important;
    color: var(--white) !important;
}
.artaquest-course-rating__star {
    color: var(--yang) !important;
}
';
}

// In <head>, after all enqueued styles (priority 9999)
add_action('wp_head', function () {
    // iter-256: load Inter (Kaggle UI font) + force it globally.
    echo '<link rel="preconnect" href="https://fonts.googleapis.com">' . "\n";
    echo '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' . "\n";
    echo '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">' . "\n";
    echo '<style id="ay-brand-vars">' . aq_brand_css_vars() . '</style>' . "\n";
    echo '<style id="aq-inter-global">'
       . 'html body, html body h1, html body h2, html body h3, html body h4, html body h5, html body h6, '
       . '.header, .header *, button, input, .stm-btn, .wp-block-artaquest-button { '
       . 'font-family: Inter, system-ui, -apple-system, sans-serif !important; }'
       . '</style>' . "\n";
}, 9999);

// In <body> footer, after any template-injected inline <style> blocks (priority 1)
add_action('wp_footer', function () {
    echo '<style id="ay-brand-vars-footer">' . aq_brand_css_vars() . '</style>' . "\n";
}, 1);

// ── Promote the first hero h2 → h1 on the home page (server-side) ──────────
// The ArtaQuest Advanced Text block emits its hero title as <h2>, leaving
// the home page with no <h1> — bad for SEO (crawlers don't always run JS)
// and a11y (screen readers need it on first paint). Swap at render time
// when the block is inside the hero adaptive-box.
add_filter('render_block_artaquest/advanced-text', function ($content, $block) {
    if ( ! is_front_page() ) return $content;
    static $promoted = false;
    if ( $promoted ) return $content;
    $new = preg_replace(
        '#<h2(\s[^>]*class="[^"]*wp-block-artaquest-advanced-text__title[^"]*"[^>]*)>(.*?)</h2>#s',
        '<h1$1>$2</h1>',
        $content,
        1,
        $count
    );
    if ( $count > 0 ) { $promoted = true; return $new; }
    return $content;
}, 10, 2);

// ── Defer non-critical scripts ───────────────────────────────────────────────
// Adds defer to scripts that don't need to block render. Keep jQuery + its
// migrate shim synchronous because plugin-emitted inline <script> blocks
// expect $ to be defined when they run; everything else is safe to defer.
add_filter('script_loader_tag', function ($tag, $handle, $src) {
    $never_defer = array(
        'jquery', 'jquery-core', 'jquery-migrate',
        // Inline-script-emitting handles. These plugins print `<script>jQuery(...)`
        // inline right after their own <script src>, which would break with defer.
        'wc-cart-fragments', 'woocommerce',
    );
    if ( in_array( $handle, $never_defer, true ) ) {
        return $tag;
    }
    // Never defer any core WP runtime script (wp-*). They're load-bearing
    // dependencies (wp.element, wp.data, wp.i18n, wp.apiFetch, …) that other
    // scripts reference synchronously in inline `-js-after` segments. Deferring
    // any of them causes "wp is not defined" / "createRoot is not a function"
    // and breaks Gutenberg blocks, WC cart/checkout, and our course list.
    if ( strpos( $handle, 'wp-' ) === 0 ) {
        return $tag;
    }
    // React itself + ReactDOM + react-jsx-runtime. wp-element is a thin
    // wrapper over these — if React loads after wp-element's inline code
    // tries to use it, you get "createRoot is not a function" and every
    // block-based UI (cart, checkout, account dashboard) renders empty.
    if ( in_array( $handle, array( 'react', 'react-dom', 'react-jsx-runtime', 'lodash', 'moment', 'underscore', 'backbone' ), true ) ) {
        return $tag;
    }
    // Never defer any WooCommerce-side script. The cart/checkout React app
    // resolves dependencies through inline configuration that has to run in
    // source order — deferring any wc-* script (wc-types, wc-settings,
    // wc-blocks-*, wc-cart-*, wc-add-to-cart, etc.) breaks the chain and
    // leaves the cart/checkout pages rendering empty skeletons forever.
    if ( strpos( $handle, 'wc-' ) === 0 || strpos( $handle, 'woocommerce' ) === 0 ) {
        return $tag;
    }
    // Don't double-add
    if ( false !== strpos( $tag, ' defer' ) || false !== strpos( $tag, ' async' ) ) {
        return $tag;
    }
    // Skip admin context
    if ( is_admin() ) {
        return $tag;
    }
    // Don't defer any script that emits inline `-after` data — that inline
    // segment runs synchronously and would execute before the deferred main
    // script loads, breaking anything that references symbols from the main.
    if ( wp_script_is( $handle, 'registered' ) ) {
        $obj = wp_scripts()->registered[ $handle ] ?? null;
        if ( $obj && ! empty( $obj->extra['after'] ) ) {
            return $tag;
        }
    }
    return str_replace( ' src=', ' defer src=', $tag );
}, 10, 3);

// ── SEO/security: hide user sitemap + product sitemap ─────────────────────
// WP core's user sitemap leaks admin usernames to anyone who fetches
// wp-sitemap-users-1.xml — useful only for sites with public author archives,
// not for a single-instructor LMS. The product sitemap exposes our internal
// donation product at /product/artaquest-donation/ which donors should reach
// via /donate/, not directly.
add_filter( 'wp_sitemaps_add_provider', function ( $provider, $name ) {
	if ( $name === 'users' ) return false;
	return $provider;
}, 10, 2 );

add_filter( 'wp_sitemaps_post_types', function ( $post_types ) {
	unset( $post_types['product'] );
	return $post_types;
} );

// Hard fallback: 404 the direct user/product sitemap URLs if they slip through.
add_action( 'parse_request', function ( $wp ) {
	$uri = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '';
	if ( preg_match( '#wp-sitemap-(users|posts-product)#', $uri ) ) {
		status_header( 404 );
		nocache_headers();
		echo '404';
		exit;
	}
} );

// Stop /?author=N → /author/admin/ enumeration. Returns 404 instead of
// redirecting (which leaks the username via the redirect URL).
add_action( 'template_redirect', function () {
	if ( is_author() || ( ! empty( $_GET['author'] ) && is_numeric( $_GET['author'] ) ) ) {
		global $wp_query;
		$wp_query->set_404();
		status_header( 404 );
		nocache_headers();
	}
} );

// iter-364 (user 2026-05-26): the page was renamed Leaderboard(s) → Rankings.
// The legacy /leaderboard(s)/ → /rankings/ 301 lives in the mu-plugin
// aq-legacy-redirects.php — it must run BEFORE the i18n detector (which fires
// earlier than any hook a theme can register), so a theme-side redirect is
// unreliable under PHP-WASM. See that file for the rationale.

// /bug-bounty/ → /bug-bounty-rules/ (real page slug). meilin realbot 2026-05-23:
// /zh/bug-bounty/ 404'd because the implicit WordPress fuzzy-match redirect
// strips the language prefix. Mirror the /leaderboards/ pattern so all 7
// locales reach the rubric page without dropping their language.
add_action( 'template_redirect', function () {
	$path = trim( wp_parse_url( $_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH ) ?? '', '/' );
	if ( preg_match( '#^([a-z]{2}/)?bug-bounty$#', $path, $m ) ) {
		wp_safe_redirect( home_url( '/' . $m[1] . 'bug-bounty-rules/' ), 301 );
		exit;
	}
}, 1 );

// ── Backend security hardening ────────────────────────────────────────────
// 1) XML-RPC hardening — pingback-only.
//    DO NOT disable XML-RPC wholesale. This site runs on WordPress.com Atomic,
//    where Jetpack is the bridge to WordPress.com and communicates over
//    `xmlrpc.php` (the `jetpack.*` methods, including `jetpack.jsonAPI`).
//    Blanket-blocking the endpoint or emptying `xmlrpc_methods` breaks that
//    connection and surfaces as:
//      "requested method jetpack.jsonAPI does not exist. [-32601]"
//    The real DDoS/brute-force vectors are the legacy pingback methods and
//    `system.multicall` amplification — so we strip only those and leave the
//    Jetpack methods intact. Auth brute-forcing of the rest is mitigated at
//    the WordPress.com edge. Jetpack requests are token-signed, not login-based.
add_filter( 'wp_headers', function ( $h ) { unset( $h['X-Pingback'] ); return $h; } );
add_filter( 'pre_update_option_default_pingback_flag', '__return_zero' );
add_filter( 'xmlrpc_methods', function ( $methods ) {
	unset(
		$methods['pingback.ping'],
		$methods['pingback.extensions.getPingbacks'],
		$methods['system.multicall']
	);
	return $methods;
}, 100 );

// 2) Strip the REST users endpoint for unauthenticated requests so author
//    slugs aren't enumerable. Authenticated admin REST calls still work.
//    Also: hide the WooCommerce/Woocom marketing REST namespaces from the
//    public namespace list (`/wp-json/`) — they're internal plumbing the
//    site doesn't expose to third parties.
add_filter( 'rest_endpoints', function ( $endpoints ) {
	if ( ! is_user_logged_in() ) {
		unset(
			$endpoints['/wp/v2/users'],
			$endpoints['/wp/v2/users/(?P<id>[\\d]+)']
		);
	}
	return $endpoints;
} );
add_filter( 'rest_index', function ( $response ) {
	if ( is_user_logged_in() ) return $response;
	$data = $response->get_data();
	$hide = array( 'wc-telemetry', 'wccom-site/v3', 'wc-admin-email', 'wc/pos/v1/catalog' );
	if ( ! empty( $data['namespaces'] ) ) {
		$data['namespaces'] = array_values( array_diff( $data['namespaces'], $hide ) );
	}
	if ( ! empty( $data['routes'] ) ) {
		foreach ( $hide as $ns ) {
			foreach ( array_keys( $data['routes'] ) as $route ) {
				if ( strpos( $route, '/' . $ns ) === 0 ) unset( $data['routes'][ $route ] );
			}
		}
	}
	$response->set_data( $data );
	return $response;
} );

// 3) Disable trackbacks + pingbacks site-wide (legacy DDoS amplifier).
add_action( 'pre_ping', function ( &$links ) { $links = array(); } );
add_filter( 'pings_open', '__return_false' );
add_action( 'init', function () {
	if ( get_option( 'default_ping_status' ) !== 'closed' ) {
		update_option( 'default_ping_status', 'closed' );
	}
	if ( get_option( 'default_pingback_flag' ) ) {
		update_option( 'default_pingback_flag', 0 );
	}
} );

// 4) Remove RSD + Windows Live Writer manifest links from <head> — both
//    advertise XML-RPC.
remove_action( 'wp_head', 'rsd_link' );
remove_action( 'wp_head', 'wlwmanifest_link' );
remove_action( 'wp_head', 'wp_generator' );  // also drop WP version leak


// 6a) Disable WordPress's emoji-script loader. The site uses native Unicode
//     emoji where present (rare — almost never) and the browser renders them
//     fine on every modern platform without the polyfill. Drops:
//       - inline <style id="wp-emoji-styles-inline-css">
//       - <script src="…/wp-emoji-release.min.js">
//       - the `emoji_url` SVG endpoint hint
//       - the `staticfile.org` DNS prefetch (used by the polyfill)
remove_action( 'wp_head', 'print_emoji_detection_script', 7 );
remove_action( 'admin_print_scripts', 'print_emoji_detection_script' );
remove_action( 'wp_print_styles', 'print_emoji_styles' );
remove_action( 'admin_print_styles', 'print_emoji_styles' );
remove_filter( 'the_content_feed', 'wp_staticize_emoji' );
remove_filter( 'comment_text_rss',  'wp_staticize_emoji' );
remove_filter( 'wp_mail',           'wp_staticize_emoji_for_email' );
add_filter( 'emoji_svg_url', '__return_false' );
add_filter( 'tiny_mce_plugins', function ( $plugins ) {
	return array_diff( (array) $plugins, array( 'wpemoji' ) );
} );

// 6) Preconnect to the font host so the handshake doesn't block first paint.
//    wp.com serves the webfonts from fonts.wp.com (NOT Google's hosts) —
//    the perf probe confirmed 499 KB / 8 font files all come from there.
//    Preconnecting the actual host saves a TLS round-trip on cold visits;
//    on slow 3G (300ms RTT) that's ~600ms back.
add_action( 'wp_head', function () {
	if ( is_admin() ) return;
	echo '<link rel="preconnect" href="https://fonts.wp.com" crossorigin>' . "\n";
	echo '<link rel="dns-prefetch" href="https://fonts.wp.com">' . "\n";
	echo '<link rel="preconnect" href="https://s0.wp.com">' . "\n";
	echo '<link rel="preconnect" href="https://secure.gravatar.com">' . "\n";
}, 1 );

// 7) HTTP security headers — added on every frontend response. wp.com Atomic
//    sets HSTS for us; we add the rest.
add_action( 'send_headers', function () {
	if ( is_admin() ) return;
	// Clickjacking — sameorigin lets our own embeds work.
	header( 'X-Frame-Options: SAMEORIGIN' );
	// MIME-type sniffing — prevent script smuggling via image responses.
	header( 'X-Content-Type-Options: nosniff' );
	// Conservative referrer policy: send origin only when leaving the site.
	header( 'Referrer-Policy: strict-origin-when-cross-origin' );
	// Permissions policy — disable the device features we never use. The microphone IS used: ArtaChat
	// records voice notes on-device (pages/Messages.tsx VoiceButton → getUserMedia). An empty
	// allowlist `microphone=()` disables the feature for EVERY origin including our own, so
	// getUserMedia rejected before the browser ever showed a permission prompt and the record button
	// was a silent no-op in production. `(self)` restores it for this origin only — the member's own
	// browser permission prompt still gates it.
	//
	// CAMERA is `(self)` and nothing more. Calls are peer-to-peer WebRTC running in OUR OWN page
	// (components/chat/CallPanel.tsx + lib/webrtc.ts) rather than a third-party iframe, so no other
	// origin needs the camera or the microphone — and the named Jitsi origin that used to be here
	// went with the dependency. `getUserMedia` is still gated by the member's own browser prompt.
	header( 'Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=()' );

	// Content-Security-Policy — defence-in-depth vs XSS / injection / clickjacking / data exfil.
	// Cache-safe by design: NO per-request nonce (cached public pages would carry a stale nonce and
	// break), so script/style allow 'unsafe-inline' — React escapes output so the practical inline-XSS
	// path is small, and the real net-new wins are: external scripts load ONLY from self + Google (an
	// injected `<script src=evil>` is blocked), object-src 'none', base-uri/form-action 'self' (no
	// base-tag hijack / cross-origin form exfil), frame-ancestors 'self' (clickjacking), and frames/
	// connections restricted to the origins we actually use (YouTube, Google sign-in, Fonts, Translate).
	// Widen the allowlist here if a new third-party integration is added. wp-admin is already excluded.
	//
	// PLATFORM ORIGINS: production runs on wp.com Atomic, which serves our webfonts from fonts.wp.com,
	// platform CSS/JS (incl. the logged-in admin bar + Jetpack stats) from s0.wp.com, and avatars from
	// secure.gravatar.com (the same hosts this theme preconnects above). They MUST be allowlisted or
	// every prod page falls back to system fonts and the operator admin bar breaks — a regression that
	// is invisible locally (Studio loads Google Fonts directly). img-src already permits all https:.
	// THE MEDIA CDN must be named in the fetch directives (operator 2026-07-28). Every published
	// Library file — a game's HTML, a track's .wav, a dataset's .csv — is served from a DIFFERENT
	// ORIGIN (Cloudflare R2), which is exactly what makes member-authored HTML safe to frame. But a
	// cross-origin host that is not allowlisted is simply refused: without this a published game is
	// a permanently blank box, the music kind's player is dead, and every text/CSV preview falls to
	// its error branch. None of it is visible in dev, because Vite's dev server sends no CSP at all.
	//
	// Read from AQ\Media::cdn_base() rather than hardcoded: the bucket id is a Vault secret and can
	// be rotated, and cdn_base() falls back to this origin's uploads URL when R2 is unset — in which
	// case 'self' already covers it and this adds nothing, which is the correct behaviour.
	$aq_cdn = '';
	if ( class_exists( '\AQ\Media' ) ) {
		$aq_base = (string) \AQ\Media::cdn_base();
		$aq_host = $aq_base ? wp_parse_url( $aq_base, PHP_URL_HOST ) : '';
		if ( $aq_host && wp_parse_url( $aq_base, PHP_URL_SCHEME ) === 'https' && $aq_host !== wp_parse_url( home_url(), PHP_URL_HOST ) ) {
			$aq_cdn = ' https://' . $aq_host;
		}
	}
	header(
		"Content-Security-Policy: "
		. "default-src 'self'; "
		. "base-uri 'self'; "
		. "object-src 'none'; "
		. "frame-ancestors 'self'; "
		. "form-action 'self' https://accounts.google.com; "
		// 'wasm-unsafe-eval' + cdn.jsdelivr.net + worker-src: the Lab (/lab, pages/Lab.tsx) runs
		// Python on-device — Pyodide is WebAssembly in a blob module worker, served self-hosted from
		// /wp-content/lite/static/pyodide/ with jsDelivr as the resilience fallback. worker-src is
		// scoped to workers only, so <script> elements gain nothing from blob: here.
		. "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://accounts.google.com https://apis.google.com https://www.gstatic.com https://www.youtube.com https://s.ytimg.com https://s0.wp.com https://stats.wp.com https://www.google.com; "
		. "worker-src 'self' blob:; "
		// media-src: without it <audio>/<video> fall back to default-src 'self', which BLOCKS blob: —
		// and ArtaTTS plays every neural/cloud clip from a blob: URL (plus a data: silent wav that
		// unlocks iOS audio inside the first tap). Self-hosted narrations/teasers stay covered by 'self'.
		. "media-src 'self' blob: data:" . $aq_cdn . "; "
		. "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com https://s0.wp.com https://fonts.wp.com; "
		. "font-src 'self' data: https://fonts.gstatic.com https://fonts.wp.com https://s0.wp.com; "
		// img-src blob:: an encrypted ArtaChat photo is decrypted on-device and handed to <img> as an
		// object URL (lib/e2ee.ts openAttachment). Without blob: here it fell back to the https:/self
		// allowlist, which does NOT cover blob: — so every image attachment and the lightbox were
		// refused in production while working perfectly in dev. Same fix media-src already carries.
		. "img-src 'self' data: blob: https:; "
		// KAGGLE HOSTS — every model the browser runs on-device (ArtaTTS's Kokoro voices, the NLLB
		// reading translator, Florence-2 figure captioning, texify2 equation OCR) is downloaded from a
		// public Kaggle dataset owned by `artafather` (operator 2026-08-02, the HuggingFace purge).
		//
		// BOTH HOSTS ARE LOAD-BEARING. www.kaggle.com answers the download API and immediately 302s to
		// storage.googleapis.com, where the bytes actually live — and CSP validates EVERY HOP of a
		// redirect chain, so listing only the first one fails at the second, after the request looked
		// like it was working. That is the same trap the old HuggingFace entries were written around
		// (huggingface.co → cdn-lfs*.hf.co → cas-bridge.xethub.hf.co); Kaggle's chain is two hops
		// rather than three, and terminates at storage.googleapis.com.
		//
		// REMOVED with the purge: huggingface.co, *.huggingface.co, *.hf.co, *.xethub.hf.co — and also
		// fal.media / *.fal.media / *.replicate.delivery, which the comment here claimed served audio
		// for `lib/tts-hf.ts`. THAT FILE DOES NOT EXIST and has no successor, so those three were
		// allow-listing three third-party origins for a feature that was not there: straight
		// attack-surface reduction, independent of the Kaggle move.
		// stun:: CSP3 governs an RTCPeerConnection's ICE server URLs under connect-src, and Firefox
		// enforces it. A call cannot discover its own public address without STUN, so without this
		// grant ICE would silently find only host candidates and every call outside a single LAN
		// would fail to connect — with no error naming the cause. Scheme-source, not a host list:
		// which STUN servers are used is a client concern (lib/webrtc.ts), and STUN carries no media,
		// no identity and no conversation.
		. "connect-src 'self' stun: https://cdn.jsdelivr.net https://translate.googleapis.com https://accounts.google.com https://s0.wp.com https://stats.wp.com https://public-api.wordpress.com https://zenodo.org https://www.kaggle.com https://storage.googleapis.com" . $aq_cdn . "; "
		// NO CALL ORIGIN HERE ANY MORE. ArtaChat calls were briefly an embedded meet.jit.si room and
		// are now peer-to-peer WebRTC (artaquest-web/src/lib/webrtc.ts): the two browsers connect
		// directly, so there is no frame to allow and no third-party bridge that could see the media.
		// The grant was removed with the dependency — an origin allow-listed for a feature that no
		// longer uses it is pure attack surface.
		. "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://accounts.google.com https://www.google.com" . $aq_cdn . "; "
		. "upgrade-insecure-requests"
	);

	// Privacy: sensitive routes (account dashboard, cart, checkout, any WC
	// endpoint) must never be cached publicly. Without this, an edge or
	// reverse proxy could in principle serve one user's account page to
	// another. Forces no-store regardless of plugin behaviour.
	$sensitive = is_page( array( 'user-account', 'profile', 'cart', 'checkout' ) )
		|| ( function_exists( 'is_account_page' ) && is_account_page() )
		|| ( function_exists( 'is_cart' ) && is_cart() )
		|| ( function_exists( 'is_checkout' ) && is_checkout() )
		|| ( function_exists( 'is_wc_endpoint_url' ) && is_wc_endpoint_url() );
	if ( $sensitive ) {
		nocache_headers();
		header( 'Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0', true );
	}
}, 999 );



// ── Prepend a server-side <h1> to pages whose templates emit none ─────────
// WC my-account, courses archive, and similar use block layouts that don't
// emit a top-level <h1>, which fails WCAG 1.3.1 + SEO. Add a visually-hidden
// h1 from the page title (translatable via the i18n output-buffer pass).
add_filter('the_content', function ($content) {
    static $injected = false;
    if ( $injected ) return $content;
    $needs_h1   = false;
    $visible_h1 = false;
    if ( function_exists('is_account_page') && is_account_page() ) $needs_h1 = true;
    if ( is_page('courses') || is_post_type_archive('stm-courses') ) {
        $needs_h1   = true;
        $visible_h1 = true; // Priscilla realbot 2026-05-21: empty header band — make it visible
    }
    if ( ! $needs_h1 ) return $content;
    $title = get_the_title();
    if ( ! $title ) return $content;
    $injected = true;
    $class = $visible_h1 ? 'ay-injected-title ay-injected-title--visible' : 'ay-injected-title screen-reader-text';
    return '<h1 class="' . esc_attr($class) . '">' . esc_html( $title ) . '</h1>' . $content;
}, 1);

// ── JS fallback for any remaining pages without an <h1> ───────────────────
// Defence-in-depth for templates we can't filter server-side (admin UIs,
// shortcode-rendered pages we haven't touched).
add_action('wp_footer', function () {
    // Don't double-up on wp-login / admin pages — wp-login emits its own
    // logo <h1> and the front-end fallback would add a second.
    if ( is_admin() || ( function_exists( 'wp_is_login' ) ? wp_is_login() : ( $GLOBALS['pagenow'] ?? '' ) === 'wp-login.php' ) ) {
        return;
    }
    ?>
    <script id="ay-h1-fallback">
    (function () {
        if (document.querySelector('h1')) return;
        // Prefer an existing visually-prominent heading to promote, else
        // synthesise one from <title>.
        var promoted = document.querySelector(
            '.woocommerce-account h2, .u-column1 h2, .artaquest-account__title, ' +
            '.wc-block-page-title, h2.entry-title, .page-title'
        );
        var h1;
        if (promoted) {
            h1 = document.createElement('h1');
            for (var i = 0; i < promoted.attributes.length; i++) {
                h1.setAttribute(promoted.attributes[i].name, promoted.attributes[i].value);
            }
            h1.innerHTML = promoted.innerHTML;
            promoted.parentNode.replaceChild(h1, promoted);
            return;
        }
        // Fallback: build a visually-hidden h1 so screen readers + crawlers
        // have a top-level heading.
        var title = (document.title || '').split('–')[0].trim();
        if (!title) return;
        h1 = document.createElement('h1');
        h1.textContent = title;
        // Visually-hidden pattern that doesn't break RTL layout:
        // negative offsets (left:-9999px) flip to positive in RTL and
        // create huge scrollWidth, so use clip + 1px positioning instead.
        h1.style.position = 'absolute';
        h1.style.width = '1px';
        h1.style.height = '1px';
        h1.style.padding = '0';
        h1.style.margin = '-1px';
        h1.style.overflow = 'hidden';
        h1.style.clip = 'rect(0,0,0,0)';
        h1.style.whiteSpace = 'nowrap';
        h1.style.border = '0';
        var main = document.querySelector('main, #wrapper, body');
        if (main) main.insertBefore(h1, main.firstChild);
    })();
    </script>
    <?php
}, 6);


// ── pass-11 (user 2026-05-29): Kaggle-style USER DRAWER ──────────────────────
// Clicking the header avatar (.aq-account-pill--avatar) opens a right slide-in
// drawer holding the user menu — Kaggle's account-drawer pattern (Image #2) —
// instead of navigating to /user-account/. Reuses the SAME menu data as the
// dashboard (STM_LMS_User_Menu::float_menu_items) plus a coins / creator-tier
// progress panel (the ArtaQuest analogue of Kaggle's "quota"). Logged-in only;
// the avatar keeps its /user-account/ href as a no-JS fallback.
// [REMOVED 2026-06-07] Server-rendered MasterStudy user-drawer (aq-udrawer): a wp_footer closure
// that built the float-menu account drawer from STM_LMS_User_Menu::float_menu_items(). It guarded on
// class_exists('STM_LMS_User_Menu') — always false now MasterStudy is deleted, so it always early-
// returned (dead). The React AppShell UserMenu owns the signed-in drawer. (~255 lines.)

// ── LEGACY mobile-nav (kept disabled, see iter-222) ──────────────────────────
if ( false ) :
add_action('wp_footer', function () {
    /* Iter 27 / Mei-Lin #261 — hamburger drawer was rendering only ONE
       item ("My account" or "Sign in or register"). Signed-in tablet
       visitors were stranded: no link to My bugs, Settings, or Sign out.
       Server-side prep here so URLs travel through the
       AQ_I18N_Router::filter_home_url hook (so /zh/, /de/ etc. resolve
       to the localized route). Labels are looked up directly against
       AQ_I18N_Store — the DOM walker doesn't translate JSON values, and
       there is no gettext bridge, so __() alone would emit English. */
    $aq_logged_in   = is_user_logged_in();
    $aq_account_url = esc_url( home_url( '/user-account/' ) );
    $aq_lang        = class_exists( 'AQ_I18N_Router' ) ? AQ_I18N_Router::current() : 'en';
    $aq_is_source   = ( ! class_exists( 'AQ_I18N_Languages' ) ) || $aq_lang === AQ_I18N_Languages::source();
    $aq_label = function ( $source ) use ( $aq_lang, $aq_is_source ) {
        if ( $aq_is_source || ! class_exists( 'AQ_I18N_Store' ) ) {
            return $source;
        }
        $hit = AQ_I18N_Store::get( $source, $aq_lang );
        return ( is_string( $hit ) && $hit !== '' ) ? $hit : $source;
    };
    $aq_mobile_nav  = array(
        'loggedIn' => $aq_logged_in ? 1 : 0,
        'items'    => $aq_logged_in
            ? array(
                array( 'label' => $aq_label( 'My account' ),  'href' => $aq_account_url, 'key' => 'account' ),
                array( 'label' => $aq_label( 'My bugs' ),     'href' => esc_url( home_url( '/user-account/my-bugs/' ) ), 'key' => 'mybugs' ),
                array( 'label' => $aq_label( 'Settings' ),    'href' => esc_url( home_url( '/user-account/settings/' ) ), 'key' => 'settings' ),
                array( 'label' => $aq_label( 'Sign out' ),    'href' => esc_url( wp_logout_url( home_url( '/' ) ) ), 'key' => 'logout' ),
            )
            : array(
                array( 'label' => $aq_label( 'Sign in or register' ), 'href' => $aq_account_url, 'key' => 'signin' ),
            ),
    );
    ?>
    <script id="ay-mobile-nav-config">
    window.aqMobileNavConfig = <?php echo wp_json_encode( $aq_mobile_nav ); ?>;
    </script>
    <script id="ay-mobile-nav">
    (function () {
        'use strict';
        var sw = document.querySelector('.mobile-switcher');
        var menu = document.querySelector('.navigation-menu');
        if (!sw || !menu) return;
        // Don't override role/aria-label — they're already set in PHP markup
        // (button role, aria-label="Open navigation menu"). The JS-only
        // updates are state changes (aria-expanded) on toggle.
        if (!menu.id) menu.id = 'ay-mobile-menu';
        if (!sw.getAttribute('aria-controls')) sw.setAttribute('aria-controls', menu.id);

        /* Iter 27 / Mei-Lin #261 — the hamburger drawer is the ONLY
           account surface on tablet/mobile (the profile-circle is hidden
           by CSS at ≤1024pt). Inject the full signed-in nav (My account /
           My bugs / Settings / Sign out) when logged-in; one
           "Sign in or register" tap when logged-out. Labels + URLs come
           from window.aqMobileNavConfig (rendered server-side so gettext +
           the i18n URL router run before the strings reach the client). */
        function injectAccountLink() {
            var list = menu.querySelector('.starter-menu');
            if (!list || list.querySelector('.aq-mobile-account')) return;
            var cfg = window.aqMobileNavConfig;
            if (!cfg || !Array.isArray(cfg.items) || cfg.items.length === 0) return;
            // Build a fragment so we only mutate the DOM once.
            var frag = document.createDocumentFragment();
            cfg.items.forEach(function (it, idx) {
                if (!it || typeof it.label !== 'string' || typeof it.href !== 'string') return;
                var li = document.createElement('li');
                // Mark the FIRST item with `aq-mobile-account` (used as the
                // idempotency guard above) plus a per-key class so CSS can
                // style "Sign out" differently if desired down the line.
                li.className = (idx === 0 ? 'aq-mobile-account ' : 'aq-mobile-account-item ')
                    + 'menu-item aq-mobile-account--' + (it.key || ('i' + idx));
                var a = document.createElement('a');
                a.href = it.href;
                a.textContent = it.label;
                li.appendChild(a);
                frag.appendChild(li);
            });
            list.prepend(frag);
        }

        function toggle(open) {
            /* Decide the next state from aria-expanded, NOT the .active
               class. A competing starter-theme handler races our toggle:
               it re-adds .active out of sync AND its own CSS forces the
               drawer to display:block. Reading .active gave stale state
               and the drawer would not close (arashashra bug 2026-05-21).
               Fix: aria-expanded is the source of truth, AND we set the
               drawer's display inline with !important so no stylesheet —
               ours or the starter theme's — can override it. */
            var willOpen = (open !== undefined)
                ? !!open
                : (sw.getAttribute('aria-expanded') !== 'true');
            if (willOpen) injectAccountLink();
            menu.classList.toggle('active', willOpen);
            sw.classList.toggle('active', willOpen);
            sw.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
            var list = menu.querySelector('.starter-menu');
            if (list) {
                list.style.setProperty('display', willOpen ? 'flex' : 'none', 'important');
            }
            // Lock body scroll while the off-canvas menu is open
            document.documentElement.classList.toggle('ay-nav-open', willOpen);
        }
        /* Iter 87 / Marco #390 — also stopImmediatePropagation so the
           competing jQuery `stm_nav_toggle` handler in
           assets/js/components/header/header.js never fires. That
           handler toggled `.active` on the button + `.navigation-menu`
           out-of-sync with our aria-expanded source of truth, which on
           iOS WebKit was contributing to the vanishing-logo bug.
           Capture-phase registration runs BEFORE jQuery's bubble-phase
           handler, so stopImmediatePropagation drops it cleanly. */
        sw.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopImmediatePropagation();
            toggle();
        }, true);
        sw.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopImmediatePropagation();
                toggle();
            }
        }, true);
        // Close on outside click + ESC
        document.addEventListener('click', function (e) {
            if (!menu.classList.contains('active')) return;
            if (sw.contains(e.target) || menu.contains(e.target)) return;
            toggle(false);
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            /* WCAG 2.1.2 — no keyboard trap. Escape must close any open
               header overlay AND return focus to the control that opened
               it. (kai realbot finding #196, 2026-05-22.) */
            if (sw.getAttribute('aria-expanded') === 'true') {
                toggle(false);
                try { sw.focus(); } catch (err) {}
                return;
            }
            var lsBtn = document.querySelector('.ay-langsw__toggle[aria-expanded="true"]');
            if (lsBtn) {
                var lsMenu = lsBtn.parentNode && lsBtn.parentNode.querySelector('.ay-langsw__menu');
                if (lsMenu) lsMenu.classList.remove('is-open');
                lsBtn.setAttribute('aria-expanded', 'false');
                try { lsBtn.focus(); } catch (err) {}
            }
        });
        // Close after tapping a nav link.
        // User directive 2026-05-21: "ensure that when the menus are
        // clicked they get closed" — listen in CAPTURE phase so we beat
        // any child handler that calls stopPropagation, and ALSO close
        // when the user taps an item rendered inside the drawer that
        // isn't strictly an <a> (e.g. a div wrapping the link).
        menu.addEventListener('click', function (e) {
            var a = e.target.closest('a, .starter-menu li, .menu-item');
            if (a) {
                toggle(false);
            }
        }, true);
        // Reset on resize-up to desktop
        var mq = window.matchMedia('(min-width: 1025px)');
        var handler = function () { if (mq.matches) toggle(false); };
        mq.addEventListener ? mq.addEventListener('change', handler) : mq.addListener(handler);

        /* Iter 84 / Reni #385 — REGRESSION of iter-81 #379. The earlier
           MutationObserver only watched .navigation-menu's class/style and
           mirrored those to .mobile-switcher. But on Chrome Galaxy S23,
           closing the drawer (via outside-click, link-tap, or starter-theme
           handler) sometimes left the button's `.active` class AND
           `aria-expanded="true"` because the starter handler closed the
           drawer via a DIFFERENT mutation path the MO never observed
           (e.g. removing/replacing the .starter-menu child rather than
           stripping .navigation-menu.active).

           Fix: companion CSS now drives the X-shape SOLELY off
           `aria-expanded` (removed the `.active`-class duplicates). Here
           we add (1) a tighter sync that fires on the .navigation-menu
           subtree (catches child removals/style changes), and (2) a
           periodic reconciliation tick while the drawer claims to be open,
           so any path that closes the drawer out-of-band still resets
           the button within 250 ms. */
        function isDrawerVisible() {
            // Source of truth: is the .starter-menu actually visible?
            var list = menu.querySelector('.starter-menu');
            if (!list) return false;
            var cs = window.getComputedStyle(list);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0;
        }
        function reconcile() {
            var open = menu.classList.contains('active') && isDrawerVisible();
            var btnAriaOpen = sw.getAttribute('aria-expanded') === 'true';
            if (open === btnAriaOpen && sw.classList.contains('active') === open) return;
            sw.classList.toggle('active', open);
            sw.setAttribute('aria-expanded', open ? 'true' : 'false');
            document.documentElement.classList.toggle('ay-nav-open', open);
            if (!open) menu.classList.remove('active'); // belt-and-suspenders
        }
        try {
            var mo = new MutationObserver(reconcile);
            // Observe the menu AND its subtree — catches both the
            // .navigation-menu.active toggle and any child mutation
            // (e.g. .starter-menu display:none/style changes) that
            // signals the drawer is no longer visible.
            mo.observe(menu, {
                attributes: true,
                attributeFilter: ['class', 'style'],
                subtree: true
            });
        } catch (e) { /* IE11 / very old browser — fall back to interval */ }
        // Periodic safety net — every 250 ms while the button thinks the
        // drawer is open, verify the drawer really is visible; if not,
        // snap the button back to the closed glyph. Cheap and bounded:
        // the check no-ops the instant aria-expanded is "false".
        setInterval(function () {
            if (sw.getAttribute('aria-expanded') === 'true' && !isDrawerVisible()) {
                reconcile();
            }
        }, 250);
    })();
    </script>
    <?php
}, 50);
endif; // iter-222: legacy mobile-nav block disabled

// [REMOVED 2026-06-07] Course-page 'Rating' label injector: guarded on is_singular('stm-courses')
// — the stm-courses post type is gone, so it always early-returned. The React CourseDetail owns this.

// ── Header logo alt text (WCAG 1.1.1) ────────────────────────────────────────
add_filter('get_custom_logo', function ($html) {
    return str_replace('alt=""', 'alt="' . esc_attr(get_bloginfo('name') . ' — Home') . '"', $html);
});

// ── Course thumbnail alt fallback (WCAG 1.1.1) ───────────────────────────────
// If an admin uploads a course thumbnail without setting alt text, the LMS
// renders `<img alt="">` on the course cards. Substitute the course title.
add_filter('wp_get_attachment_image_attributes', function ($attr, $attachment) {
    if ( empty( $attr['alt'] ) && $attachment instanceof WP_Post ) {
        $parent = get_post( $attachment->post_parent );
        if ( $parent ) {
            $attr['alt'] = wp_strip_all_tags( $parent->post_title );
        } else {
            $attr['alt'] = wp_strip_all_tags( $attachment->post_title );
        }
    }
    return $attr;
}, 10, 2);

// ── Login page brand (wp-login.php) ──────────────────────────────────────────
// Replace the "Powered by WordPress" wp-login logo with ArtaQuest branding,
// link it to the home URL instead of wordpress.org, and apply the same
// brand colors used on the public site. wp.com Atomic's Jetpack SSO panel
// is left intact — admins use it for login.

add_filter('login_headerurl',  function () { return home_url('/'); }, 99);
add_filter('login_headertext', function () { return get_bloginfo('name'); }, 99);

// wp-login.php emits BOTH `<h1 class="screen-reader-text">` (page title for
// AT) and `<h1 class="wp-login-logo">` (visual logo link). Two h1s violate
// WCAG/SEO heading structure. Demote the visible logo wrapper to a <div>
// — the screen-reader h1 carries the page title for AT.
add_action('login_footer', function () {
    ?>
    <script id="ay-login-h1-dedupe">
    (function () {
        var logo = document.querySelector('h1.wp-login-logo');
        if (!logo) return;
        var div = document.createElement('div');
        for (var i = 0; i < logo.attributes.length; i++) {
            div.setAttribute(logo.attributes[i].name, logo.attributes[i].value);
        }
        div.innerHTML = logo.innerHTML;
        logo.parentNode.replaceChild(div, logo);
    })();
    </script>
    <?php
}, 999);

// Bump touch targets on WP-core admin update screen + login fallback links.
// Also hide the wp.com Atomic "Help Center" floating button (bottom-right
// blue circle with checkbox icon) and the "Help Center" admin-sidebar link
// — both link out to wordpress.com support, irrelevant for our team.
add_action('admin_head', function () {
    echo '<style id="ay-admin-touch">
    .wp-core-ui .button-primary,
    .wp-core-ui .button,
    a.button {
        min-height: 44px !important;
        line-height: 1.4 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center;
    }
    /* wp.com Atomic Help Center widget — floating button bottom-right */
    #wpcom-help-center,
    #help-center-app,
    .help-center__container,
    [class*="help-center__floating"],
    a[href*="wordpress.com/help"],
    a[href*="wordpress.com/support"],
    li.toplevel_page_help-center,
    li#toplevel_page_help-center,
    a.toplevel_page_help-center,
    #adminmenu a[href*="help-center"],
    #wp-admin-bar-help-center,
    #wp-admin-bar-wpcom-help-center {
        display: none !important;
    }
    </style>';
});

add_action('login_enqueue_scripts', function () {
    ?>
    <style id="ay-login-brand">
    body.login {
        background: #010C17;
        color: #FFFFFF;
    }
    body.login a { color: #E8B923; }
    body.login a:hover, body.login a:focus { color: #F5D060; }
    /* WCAG 2.5.8: bump the SSO-fallback link to 44px tall. */
    body.login #login p a,
    body.login p a,
    body.login p.nav a,
    body.login a.jetpack-sso-toggle,
    body.login a.wpcom,
    body.login .jetpack-sso-or + a {
        display: inline-flex !important;
        min-height: 44px !important;
        padding: 0.5rem 0 !important;
        align-items: center !important;
    }
    /* The DB-upgrade button on /wp-admin/upgrade.php — pre-login system page. */
    body.wp-core-ui a.button,
    body.wp-core-ui a.button-primary,
    body a.button,
    body a.button-primary {
        min-height: 44px !important;
        line-height: 1.4 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        padding: 0.5rem 1.25rem !important;
    }
    body.login #login h1 a,
    body.login .login h1 a {
        background-image: none;
        background-color: transparent;
        color: #E8B923;
        font-family: Inter, system-ui, -apple-system, sans-serif;
        font-weight: 700;
        font-size: 32px;
        line-height: 1.2;
        letter-spacing: 0.02em;
        text-indent: 0;
        height: auto;
        width: auto;
        text-decoration: none;
    }
    body.login #login h1 a::after,
    body.login .login h1 a::after {
        content: '';
        display: block;
        width: 84px;
        height: 3px;
        margin: 10px auto 0;
        background: linear-gradient(90deg, #486EE1 0%, #486EE1 49%, rgba(255,255,255,.70) 50%, #E8B923 51%, #E8B923 100%);
    }
    body.login form {
        background: #06121E;
        border: 1px solid rgba(232,185,35,.18);
        box-shadow: 0 8px 32px rgba(72, 110, 225,.22);
        color: #FFFFFF;
    }
    body.login label { color: rgba(255,255,255,.72); }
    body.login input[type=text],
    body.login input[type=password],
    body.login input[type=email] {
        background: rgba(255,255,255,.06);
        border: 1px solid rgba(232,185,35,.30);
        color: #FFFFFF;
        border-radius: 6px;
    }
    body.login input[type=text]:focus,
    body.login input[type=password]:focus,
    body.login input[type=email]:focus {
        border-color: #E8B923;
        box-shadow: 0 0 0 3px #1A3DB5;
    }
    body.login .button-primary {
        background: #E8B923;
        border-color: #E8B923;
        color: #010C17;
        text-shadow: none;
        font-weight: 700;
        border-radius: 999px;
        min-height: 44px;
        padding: 0 26px;
    }
    body.login .button-primary:hover,
    body.login .button-primary:focus {
        background: #486EE1;
        border-color: #486EE1;
        color: #FFFFFF;
        box-shadow: 0 8px 32px rgba(72, 110, 225,.22);
    }
    body.login #nav, body.login #backtoblog {
        text-align: center;
    }
    body.login #nav a, body.login #backtoblog a {
        color: rgba(255,255,255,.72);
    }
    body.login #nav a:hover, body.login #backtoblog a:hover,
    body.login #nav a:focus, body.login #backtoblog a:focus {
        color: #E8B923;
    }
    body.login .privacy-policy-page-link a { color: rgba(255,255,255,.55); }
    body.login .privacy-policy-page-link a:hover { color: #E8B923; }
    </style>
    <?php
}, 99);

// ── Scroll navigation — left/right arrows for testimonials + course grid ──
add_action('wp_footer', function () {
    ?>
    <script id="ay-scroll-nav">
    (function () {
        'use strict';

        var SVG_L = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="15 18 9 12 15 6"/></svg>';
        var SVG_R = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="9 18 15 12 9 6"/></svg>';

        function makeBtn(dir, label) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ay-nav-btn ay-nav-btn--' + dir;
            btn.setAttribute('aria-label', label);
            btn.innerHTML = (dir === 'prev') ? SVG_L : SVG_R;
            return btn;
        }

        /* ── Testimonials Swiper ← → ───────────────────────────────────────── */
        function initTestimonialsNav() {
            var block = document.querySelector(
                '.wp-block-artaquest-testimonials-aaa14f6d-f01c-4440-9629-33390042c071'
            );
            if (!block) return;

            var swiperEl = block.querySelector('.wp-block-artaquest-testimonials__swiper');
            if (!swiperEl) return;

            var tries = 0;
            var poll  = setInterval(function () {
                tries++;
                if (tries > 80) { clearInterval(poll); return; }
                if (!swiperEl.swiper) return;
                clearInterval(poll);

                var sw   = swiperEl.swiper;
                var loop = sw.params && sw.params.loop;

                var nav  = document.createElement('div');
                nav.className = 'ay-testimonials-nav';
                nav.setAttribute('role', 'group');
                nav.setAttribute('aria-label', 'Testimonial navigation');

                var prev = makeBtn('prev', 'Previous testimonial');
                var next = makeBtn('next', 'Next testimonial');

                function updateState() {
                    prev.setAttribute('aria-disabled', (!loop && sw.isBeginning).toString());
                    next.setAttribute('aria-disabled', (!loop && sw.isEnd).toString());
                }

                prev.addEventListener('click', function () { sw.slidePrev(); });
                next.addEventListener('click', function () { sw.slideNext(); });
                sw.on('slideChange',    updateState);
                sw.on('reachBeginning', updateState);
                sw.on('reachEnd',       updateState);
                updateState();

                nav.appendChild(prev);
                nav.appendChild(next);
                block.appendChild(nav);
            }, 100);
        }

        /* ── Course grid horizontal scroll ← → ────────────────────────────── */
        function initCoursesNav() {
            var featuredSection = document.querySelector(
                '.wp-block-artaquest-adaptive-box-2540b808-44dd-47b9-a787-ca9d37cd1777'
            );

            var grid = null;
            var candidates = document.querySelectorAll('.stm_lms_courses__grid_4');
            for (var i = 0; i < candidates.length; i++) {
                if (!featuredSection || !featuredSection.contains(candidates[i])) {
                    grid = candidates[i];
                    break;
                }
            }
            if (!grid) return;

            var wrap = document.createElement('div');
            wrap.className = 'ay-courses-scroll';
            grid.parentNode.insertBefore(wrap, grid);
            wrap.appendChild(grid);

            var nav  = document.createElement('div');
            nav.className = 'ay-courses-nav';
            var prev = makeBtn('prev', 'Scroll courses left');
            var next = makeBtn('next', 'Scroll courses right');
            nav.appendChild(prev);
            nav.appendChild(next);
            wrap.parentNode.insertBefore(nav, wrap);

            function cardWidth() {
                var card = grid.querySelector('.stm_lms_courses__single');
                return (card ? card.offsetWidth : 300) + 24;
            }

            function updateState() {
                var atStart = wrap.scrollLeft < 4;
                var atEnd   = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 4;
                prev.setAttribute('aria-disabled', atStart.toString());
                next.setAttribute('aria-disabled', atEnd.toString());
            }

            prev.addEventListener('click', function () {
                wrap.scrollBy({ left: -cardWidth(), behavior: 'smooth' });
            });
            next.addEventListener('click', function () {
                wrap.scrollBy({ left: cardWidth(), behavior: 'smooth' });
            });

            wrap.addEventListener('scroll', updateState, { passive: true });

            var mo = new MutationObserver(function () {
                setTimeout(updateState, 150);
            });
            mo.observe(grid, { childList: true });

            if (typeof ResizeObserver !== 'undefined') {
                new ResizeObserver(updateState).observe(wrap);
            }

            updateState();
        }

        function init() {
            initTestimonialsNav();
            initCoursesNav();
        }

        /* ── Rating filter: replace "& up" with "+" ──────────────────────── */
        function fixRatingLabels() {
            var labels = document.querySelectorAll('.lms-courses-filter-radio-label');
            for (var i = 0; i < labels.length; i++) {
                var node = labels[i];
                if (node.textContent.indexOf('& up') !== -1) {
                    node.childNodes.forEach(function(n) {
                        if (n.nodeType === 3) {
                            n.textContent = n.textContent.replace(/\s*&\s*up/g, '+');
                        }
                    });
                }
            }
        }

        function init() {
            initTestimonialsNav();
            initCoursesNav();
            fixRatingLabels();
            /* Rating labels may render async; observe the filter container */
            var filterRoot = document.querySelector('.lms-archive-courses, .stmlms-filter');
            if (filterRoot && typeof MutationObserver !== 'undefined') {
                var ro = new MutationObserver(function() { fixRatingLabels(); });
                ro.observe(filterRoot, { childList: true, subtree: true });
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }());
    </script>
    <?php
}, 20);

// ── Theme constants and core includes ────────────────────────────────────────
define( 'STM_THEME_VERSION', ( WP_DEBUG ) ? time() : wp_get_theme()->get( 'Version' ) );
define( 'STM_THEME_PATH', dirname( __FILE__ ) );
define( 'STM_INCLUDES_PATH', STM_THEME_PATH . '/includes' );
define( 'STM_TEMPLATE_URI', get_template_directory_uri() );
define( 'STM_TEMPLATE_DIR', get_template_directory() );
define( 'STM_SERVICE_URL', 'about:blank' );

require_once STM_INCLUDES_PATH . '/custom-functions.php';
require_once STM_INCLUDES_PATH . '/enqueue.php';
require_once STM_INCLUDES_PATH . '/comments.php';
require_once STM_INCLUDES_PATH . '/theme-config.php';
// [REMOVED 2026-06-07] includes/helpers.php — 100% dead Merlin/MasterStudy/Elementor demo-import +
// migration machinery: every function hooked only to merlin_after_all_import (the importer is deleted,
// did_action=0) or the orphaned wp_ajax_ms_starter_lms_theme_builder_option; none referenced live.
require_once STM_INCLUDES_PATH . '/artaquest-features.php'; // leaderboard + assignments removal
require_once STM_INCLUDES_PATH . '/aq-currency.php'; // USD-canonical, locale-aware display layer
require_once STM_INCLUDES_PATH . '/aq-geo.php';      // country layer: country → language + local-currency + PPP equity (2026-05-31)
// aq-auth.php removed 2026-06-05: the passwordless sign-in BFF moved to the plugin (AQ\Auth, routes
// registered with override=true) which authoritatively owns /aq/v1/auth/* — the theme copy's routes
// were dead (overridden), and its one live helper (Google client id) is now read inline above.
require_once STM_INCLUDES_PATH . '/aq-seo-schema.php';   // site-wide + course/profile/rankings schema.org (SEO + LLM, 2026-05-29)
require_once STM_INCLUDES_PATH . '/aq-app.php';          // serve the Vite-built React SPA from WP (WP.com-deployable, [aq_app] shortcode, 2026-05-29)
// ── Retired legacy BFF/economy includes — superseded by the `artaquest` plugin's REST
//    API on the new aq_* schema. The plugin owns /aq/v1/* now (see /CUTOVER.md). ─────
// require_once STM_INCLUDES_PATH . '/aq-coin-bank.php';    // → plugin AQ\Economy
// require_once STM_INCLUDES_PATH . '/aq-points.php';       // → plugin AQ\Economy
// require_once STM_INCLUDES_PATH . '/aq-discussions.php';  // → plugin AQ\Social
// require_once STM_INCLUDES_PATH . '/aq-courses-page.php'; // → plugin AQ\Courses
// require_once STM_INCLUDES_PATH . '/aq-funds.php';        // → plugin AQ\Funds
// require_once STM_INCLUDES_PATH . '/aq-outreach.php';     // (retired feature)
// require_once STM_INCLUDES_PATH . '/aq-headless-api.php'; // → plugin AQ\Rest (all BFF routes)
// require_once STM_INCLUDES_PATH . '/aq-disc-schema.php';  // → plugin AQ\Social (future SEO)
if ( ! defined( 'ABSPATH' ) ) {
	exit; // Exit if accessed directly.
}

/**
 * Constants
 */
define( 'MS_LMS_STARTER_THEME_DIR', get_parent_theme_file_path() );
define( 'MS_LMS_STARTER_THEME_URI', get_parent_theme_file_uri() );
define( 'MS_LMS_STARTER_THEME_VERSION', ( WP_DEBUG ) ? time() : wp_get_theme()->get( 'Version' ) );

// [REMOVED 2026-06-05] stm_ms_lms_theme_register_styles() enqueued the Elementor icon font
// (assets/fonts/elementor/) — but Elementor is deleted (no widgets render it), the SPA discards
// wp_head, and it was this function's only job. Removed with the font dir.


add_action(
	'admin_init',
	function () {
		delete_transient( 'elementor_activation_redirect' );
	}
);

// TGM Plugin Activation removed 2026-06-05: it nagged admins to install the DELETED "ArtaQuest LMS"
// plugin + Elementor (unused) — stale after the cutover. Admin-only library, self-contained (nothing
// outside includes/tgm/ called tgmpa()), so removing the require + dir is safe.

// Customizer controls removed 2026-06-05: the 6 includes/customizer/ files only registered admin
// "Appearance → Customize" panels (color/layout/header/footer/blog/typography) for the old MasterStudy
// theme. The React front-end owns all styling (its own tokens), doesn't read the resulting CSS vars,
// and theme-config.php falls back to defaults when the mods are unset. Self-contained (no external
// callers), control-registration only — so removing them has no front-end effect.

// [REMOVED 2026-06-07] MasterStudy starter-theme updater (includes/upgrade/, 3 files): a self-
// instantiating StarterLoader registered the wp_ajax_stm_update_starter_theme endpoint to install/
// update the commercial MasterStudy theme + plugins via Freemius. MasterStudy is deleted, Freemius is
// disabled in this fork, no JS triggers the action, and the plugin it installs is gone — fully orphaned.

// Freemius licence activation — DISABLED in the ArtaQuest fork.
// The original block loaded the Freemius SDK from theme/freemius/start.php
// and fired a daily fs_data_sync cron to api.freemius.com. The fork is
// self-contained: no licence server, no usage telemetry. A no-op stub
// keeps any downstream `artaquest_starter_fs()` callers from fatalling.
if ( ! function_exists( 'artaquest_starter_fs' ) ) {
	function artaquest_starter_fs() {
		static $stub;
		if ( ! $stub ) {
			$stub = new class {
				public function __call( $name, $args ) {
					// Boolean checks → true (premium/active); everything else → null.
					if ( 0 === strpos( $name, 'is_' )
						|| 0 === strpos( $name, 'has_' )
						|| 0 === strpos( $name, 'can_' ) ) {
						return true;
					}
					return null;
				}
			};
		}
		return $stub;
	}
	do_action( 'artaquest_starter_fs_loaded' );
}

//Freemius licenses check
function artaquest_starter_fs_verify() {
	if ( function_exists( 'artaquest_starter_fs' ) ) {
		return artaquest_starter_fs()->is__premium_only() && artaquest_starter_fs()->can_use_premium_code();
	}

	return false;
}

// Redirect-to-wizard on first activation removed (wizard is a vendor-specific flow).

/**
 * Vendor MS-LMS admin dashboard. The full bundle is a wizard for new-site
 * onboarding (Freemius checkout, demo importer, child-theme creator, plugin
 * recommender) and is no longer relevant on this self-hosted fork.
 *
 * Notably, `changelog.php` fired a remote HTTP request to a Stylemix service
 * (`STM_SERVICE_URL . 'artaquesttemplates_new.json'`) on every admin page
 * load — a phone-home we don't want. All these files are now skipped.
 */
// (Dashboard onboarding bundle disabled in the ArtaQuest fork.)

// [REMOVED 2026-06-07] Lesson-player engagement-gate wp_footer closure: guarded on
// is_singular('stm-lessons') — the stm-lessons post type is gone (MasterStudy deleted), so it
// always early-returned. The React Lesson page owns engagement now.

// [REMOVED 2026-06-07] admin_menu cleanup that remove_submenu_page'd MasterStudy LMS submenus
// (assignments/cert-builder/gradebook/drip/zoom/learndash under parent 'masterstudy-lms'). MasterStudy
// is deleted, so the parent menu and all those slugs are gone — every call was already a no-op.


// [REMOVED 2026-06-05] The logged-in-home "welcome hero" (iter-224 Kaggle-era) lived here: a
// the_content filter (aq_welcome_hero_prepend, ~244 lines) + a wp_head style hiding a defunct
// Gutenberg block. Dead — it only hooked the_content when is_user_logged_in() && is_front_page(),
// but the home is the React app (no the_content rendered), and it read DROPPED tables
// (artaquest_user_points/lessons/courses) + the deleted stm-reviews type. The React Home dashboard
// (Home.tsx, fed by the plugin getDashboard) replaces it.
add_action( 'wp_footer', function () {
	if ( is_user_logged_in() || ! is_front_page() ) { return; }
	?>
	<script id="aq-hero-dual-cta">
	(function () {
		var hero = document.querySelector('.wp-block-artaquest-adaptive-box-97bc4f65-8e54-480e-870e-7988b1272227');
		if (!hero) return;
		var btn = hero.querySelector('.wp-block-artaquest-button');
		if (!btn || btn.parentElement.querySelector('.aq-hero-secondary-cta')) return;
		var sec = document.createElement('a');
		sec.className = 'aq-hero-secondary-cta';
		sec.href = '/courses/';
		sec.textContent = <?php echo wp_json_encode( __( 'Browse Courses', 'artaquest' ) ); ?>;
		btn.parentElement.insertBefore(sec, btn.nextSibling);
	})();
	</script>
	<?php
}, 99 );
