/**
 * The official ArtaQuest links — the legal pages and the accounts — as DATA, so the two places that
 * render them cannot drift: the footer (below lg) and the right column's foot (lg+, RightRail.tsx).
 * They moved out of Footer.tsx when the right column took over the footer's job on a wide screen;
 * a component module cannot export plain constants without breaking Fast Refresh.
 */
export const LEGAL: { label: string; href: string }[] = [
  { label: "Code of Conduct", href: "/code-of-conduct/" },
  { label: "Privacy Policy", href: "/privacy-policy/" },
  { label: "Terms & Conditions", href: "/terms-and-conditions/" },
];

/**
 * The official ArtaQuest accounts.
 *
 * ⚠️ This list is MIRRORED as the Organization node's `sameAs` in
 * wp-content/themes/artaquest-theme/includes/aq-seo-schema.php (the `aq_social_*` option
 * defaults). Change one and you must change the other — `sameAs` is how Google resolves which
 * "ArtaQuest" this is and what a knowledge panel is built from, so a footer link the schema
 * doesn't know about is invisible to search, and a schema link the footer dropped is a claim
 * about an account nobody can find. (The X handle here was `artaquestorg` until 2026-07-27,
 * which 404s — it had gone stale in BOTH copies at once, which is exactly the failure mode.)
 */
/* The Kaggle mark is a LETTER, and a letter does not centre like a logo. Measured by filling the
   path to a canvas and taking the centroid of the painted pixels: its bounding box sits at 49.9% of
   the icon (dead centre) while its INK sits at 42.1% — the heavy vertical stem is on the left and the
   arms that reach right are thin, so a box-centred "k" reads as shoved left. Its viewBox is therefore
   shifted 40.8 units left (7.91% of 516), which moves the glyph right until the ink is centred.
   The same measurement puts the ink 8.38% LOW, and that one is deliberately NOT corrected: the
   letterform is 516.1 units tall in a 516 box, so it already fills the height and any vertical shift
   clips it — fixing it needs the viewBox ~17% larger, which would render the k visibly smaller than
   every icon beside it. A centred-but-full-size mark beats a perfectly-centred shrunken one. */
export const SOCIALS: { label: string; href: string; path: string; viewBox?: string }[] = [
  // YouTube took Instagram's slot (operator, 2026-07-31). Verified before the swap: the channel
  // resolves 200. Instagram's handle is parked in aq_social_profiles() alongside the other three.
  { label: "YouTube", href: "https://www.youtube.com/@ArtaQuest", path: "M23.5 6.19a3.02 3.02 0 00-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 002.12 2.14c1.88.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 002.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.6 15.6V8.4l6.2 3.6-6.2 3.6z" },
  // LinkedIn replaced the WhatsApp channel (operator, 2026-07-27). Note this is the FOLLOW
  // link — the "share to WhatsApp" action in SharePanel/Funds is a different thing and stays.
  { label: "LinkedIn", href: "https://www.linkedin.com/company/artaquest", path: "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" },
  // GitHub is not decoration: it is the source-code CDN every submitted notebook is mirrored to
  // as a public gist, which is what makes the one-click Colab link possible (src/Gist.php).
  { label: "GitHub", href: "https://github.com/ArtaQuest", path: "M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z" },
  // X, restored 2026-08-15 (operator). It was removed on 08-13 because the handle it pointed at,
  // @arta_quest, is DEAD — re-checked today and it still answers 404, which is why the URL changed
  // rather than the entry simply coming back. @artafather resolves 200 (checked before linking:
  // a social row is the one place on the site where a broken link is the whole content of the link).
  { label: "X", href: "https://x.com/artafather", path: "M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.4l-5.8-7.58-6.64 7.58H.48l8.6-9.83L0 1.15h7.59l5.24 6.93 6.07-6.93zm-1.29 19.5h2.04L6.48 3.24H4.29L17.61 20.65z" },
  // Kaggle is the least decorative link here (operator 2026-08-02): every submission IS a public
  // Kaggle notebook that has been run, and `artafather` is the account hosting the platform's own
  // heavy data — the model weights and dataset files this site serves. The mark is drawn on a 512
  // grid rather than the 24 the others use, so it carries its own viewBox instead of being
  // hand-rescaled (rescaling a path by eye is how a logo ends up subtly wrong forever).
  //
  // The viewBox is NOT the artwork's declared 0 0 512 512, and that is the point. Measured, the
  // glyph occupies x 43.6..306.3 and y 0..516.1 — so on a 512 grid it sits 81 units left of
  // centre (16% of the width) and overhangs the bottom by four. In a round social button that
  // reads as a letter shoved into the corner, which is what it looked like.
  //
  // So the box is a SQUARE of the glyph's own height, centred on the glyph's own centre
  // (175.0, 258.1): the mark keeps exactly the size it renders at today, stops being clipped, and
  // sits in the middle. Derived, not nudged — a magic offset chosen by eye is how the next person
  // ends up nudging it again.
  { label: "Kaggle", href: "https://www.kaggle.com/organizations/artaquest-foundation", viewBox: "-123.8 0 516 516", path: "M304.2 501.5L158.4 320.3 298.2 185c2.6-2.3 3.6-5.6 2.6-8.9-1-3.3-4.3-5.6-7.9-5.6h-56.9c-4.3 0-8.6 1.7-11.9 4.9L96.8 297.5V6.9c0-4.3-3.6-6.9-6.9-6.9H50.5c-4.3 0-6.9 2.6-6.9 6.9v498.2c0 4.3 2.6 6.9 6.9 6.9h39.4c3.3 0 6.9-2.6 6.9-6.9V354.8l131.1 156.4c3.3 3.3 6.9 4.9 11.9 4.9h58.2c3.6 0 6.6-2.3 7.6-5.6.7-2.9 0-6.2-1.4-9z" },
];

