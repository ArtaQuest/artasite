import { useId } from "react";
import { cx } from "./ui";

/**
 * CoinDisc — the Arta Coin struck as an actual coin: a beveled, reeded gold rim, an
 * engine-turned field, an "ARTA COIN · 1 mg · AU 999" legend, a soft sheen, and at its
 * centre the brand mark itself — the gold "A" bursting through a recessed blue-enamel
 * ring that is notched where the A crosses it, with the A's triangular counter cut
 * hollow (engraved). Same geometry as the flat <LogoMark/>, only minted. It is the
 * large-format sibling of the inline <CoinMark/> currency symbol.
 *
 * The artwork is kept verbatim as a string so the struck design is preserved exactly;
 * its gradient/filter/clip/mask ids carry a "ring-" prefix that is remapped to a
 * per-instance id at render, so two coins on one page never share (and clobber) <defs>.
 */
const DISC = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Arta Coin — 1 mg gold">
  <defs>
    <radialGradient id="ring-metal" cx="36%" cy="34%" r="80%">
      <stop offset="0%" stop-color="#FFE9A8"/>
      <stop offset="34%" stop-color="#F5D060"/>
      <stop offset="68%" stop-color="#E8B923"/>
      <stop offset="92%" stop-color="#C49B1A"/>
      <stop offset="100%" stop-color="#8A6E12"/>
    </radialGradient>
    <linearGradient id="ring-rim" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFE9A8"/>
      <stop offset="48%" stop-color="#E8B923"/>
      <stop offset="100%" stop-color="#8A6E12"/>
    </linearGradient>
    <linearGradient id="ring-rim2" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#8A6E12"/>
      <stop offset="52%" stop-color="#E8B923"/>
      <stop offset="100%" stop-color="#FFE9A8"/>
    </linearGradient>
    <linearGradient id="ring-enamel" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%" stop-color="#4A72FF"/>
      <stop offset="45%" stop-color="#2352E8"/>
      <stop offset="100%" stop-color="#1A3DB5"/>
    </linearGradient>
    <radialGradient id="ring-aface" cx="38%" cy="26%" r="86%">
      <stop offset="0%" stop-color="#FFE9A8"/>
      <stop offset="46%" stop-color="#F5D060"/>
      <stop offset="82%" stop-color="#E8B923"/>
      <stop offset="100%" stop-color="#C49B1A"/>
    </radialGradient>
    <radialGradient id="ring-sheen" cx="34%" cy="28%" r="44%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#FFFFFF" stop-opacity="0.08"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <filter id="ring-dshadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    <filter id="ring-emboss" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1.4" dy="1.8" stdDeviation="0.6" flood-color="#8A6E12" flood-opacity="0.85"/>
    </filter>
    <path id="ring-legendtop" d="M100 100 m -72 0 a 72 72 0 1 1 144 0" fill="none"/>
    <path id="ring-legendbot" d="M100 100 m -72 0 a 72 72 0 0 0 144 0" fill="none"/>
    <clipPath id="ring-disc"><circle cx="100" cy="100" r="83"/></clipPath>
  </defs>
  <g filter="url(#ring-dshadow)">
    <circle cx="100" cy="100" r="89" fill="#C49B1A"/>
    <g stroke="#8A6E12" stroke-width="1.1" opacity="0.85"><path d="M185.50 100.00L190.00 100.00 M185.38 104.47L189.88 104.71 M185.03 108.94L189.51 109.41 M184.45 113.38L188.89 114.08 M183.63 117.78L188.03 118.71 M182.59 122.13L186.93 123.29 M181.32 126.42L185.60 127.81 M179.82 130.64L184.02 132.25 M178.11 134.78L182.22 136.61 M176.18 138.82L180.19 140.86 M174.05 142.75L177.94 145.00 M171.71 146.57L175.48 149.02 M169.17 150.26L172.81 152.90 M166.45 153.81L169.94 156.64 M163.54 157.21L166.88 160.22 M160.46 160.46L163.64 163.64 M157.21 163.54L160.22 166.88 M153.81 166.45L156.64 169.94 M150.26 169.17L152.90 172.81 M146.57 171.71L149.02 175.48 M142.75 174.05L145.00 177.94 M138.82 176.18L140.86 180.19 M134.78 178.11L136.61 182.22 M130.64 179.82L132.25 184.02 M126.42 181.32L127.81 185.60 M122.13 182.59L123.29 186.93 M117.78 183.63L118.71 188.03 M113.38 184.45L114.08 188.89 M108.94 185.03L109.41 189.51 M104.47 185.38L104.71 189.88 M100.00 185.50L100.00 190.00 M95.53 185.38L95.29 189.88 M91.06 185.03L90.59 189.51 M86.62 184.45L85.92 188.89 M82.22 183.63L81.29 188.03 M77.87 182.59L76.71 186.93 M73.58 181.32L72.19 185.60 M69.36 179.82L67.75 184.02 M65.22 178.11L63.39 182.22 M61.18 176.18L59.14 180.19 M57.25 174.05L55.00 177.94 M53.43 171.71L50.98 175.48 M49.74 169.17L47.10 172.81 M46.19 166.45L43.36 169.94 M42.79 163.54L39.78 166.88 M39.54 160.46L36.36 163.64 M36.46 157.21L33.12 160.22 M33.55 153.81L30.06 156.64 M30.83 150.26L27.19 152.90 M28.29 146.57L24.52 149.02 M25.95 142.75L22.06 145.00 M23.82 138.82L19.81 140.86 M21.89 134.78L17.78 136.61 M20.18 130.64L15.98 132.25 M18.68 126.42L14.40 127.81 M17.41 122.13L13.07 123.29 M16.37 117.78L11.97 118.71 M15.55 113.38L11.11 114.08 M14.97 108.94L10.49 109.41 M14.62 104.47L10.12 104.71 M14.50 100.00L10.00 100.00 M14.62 95.53L10.12 95.29 M14.97 91.06L10.49 90.59 M15.55 86.62L11.11 85.92 M16.37 82.22L11.97 81.29 M17.41 77.87L13.07 76.71 M18.68 73.58L14.40 72.19 M20.18 69.36L15.98 67.75 M21.89 65.22L17.78 63.39 M23.82 61.18L19.81 59.14 M25.95 57.25L22.06 55.00 M28.29 53.43L24.52 50.98 M30.83 49.74L27.19 47.10 M33.55 46.19L30.06 43.36 M36.46 42.79L33.12 39.78 M39.54 39.54L36.36 36.36 M42.79 36.46L39.78 33.12 M46.19 33.55L43.36 30.06 M49.74 30.83L47.10 27.19 M53.43 28.29L50.98 24.52 M57.25 25.95L55.00 22.06 M61.18 23.82L59.14 19.81 M65.22 21.89L63.39 17.78 M69.36 20.18L67.75 15.98 M73.58 18.68L72.19 14.40 M77.87 17.41L76.71 13.07 M82.22 16.37L81.29 11.97 M86.62 15.55L85.92 11.11 M91.06 14.97L90.59 10.49 M95.53 14.62L95.29 10.12 M100.00 14.50L100.00 10.00 M104.47 14.62L104.71 10.12 M108.94 14.97L109.41 10.49 M113.38 15.55L114.08 11.11 M117.78 16.37L118.71 11.97 M122.13 17.41L123.29 13.07 M126.42 18.68L127.81 14.40 M130.64 20.18L132.25 15.98 M134.78 21.89L136.61 17.78 M138.82 23.82L140.86 19.81 M142.75 25.95L145.00 22.06 M146.57 28.29L149.02 24.52 M150.26 30.83L152.90 27.19 M153.81 33.55L156.64 30.06 M157.21 36.46L160.22 33.12 M160.46 39.54L163.64 36.36 M163.54 42.79L166.88 39.78 M166.45 46.19L169.94 43.36 M169.17 49.74L172.81 47.10 M171.71 53.43L175.48 50.98 M174.05 57.25L177.94 55.00 M176.18 61.18L180.19 59.14 M178.11 65.22L182.22 63.39 M179.82 69.36L184.02 67.75 M181.32 73.58L185.60 72.19 M182.59 77.87L186.93 76.71 M183.63 82.22L188.03 81.29 M184.45 86.62L188.89 85.92 M185.03 91.06L189.51 90.59 M185.38 95.53L189.88 95.29"/></g>
    <circle cx="100" cy="100" r="86" fill="url(#ring-rim)"/>
    <circle cx="100" cy="100" r="82.5" fill="url(#ring-rim2)"/>
    <circle cx="100" cy="100" r="80" fill="url(#ring-metal)"/>
    <circle cx="100" cy="100" r="80" fill="none" stroke="#8A6E12" stroke-width="0.8" opacity="0.5"/>
    <circle cx="100" cy="100" r="73.5" fill="none" stroke="#8A6E12" stroke-width="0.8" opacity="0.45"/>
    <g fill="#8A6E12" font-family="Helvetica, Arial, sans-serif" font-weight="700" letter-spacing="3">
      <text font-size="9.5"><textPath href="#ring-legendtop" startOffset="50%" text-anchor="middle">ARTA COIN</textPath></text>
      <text font-size="7"><textPath href="#ring-legendbot" startOffset="50%" text-anchor="middle">1 mg · AU 999 · ONE</textPath></text>
    </g>
    <g clip-path="url(#ring-disc)">
      <g stroke="#C49B1A" stroke-width="0.4" opacity="0.35"><path d="M118.00 100.00L164.00 100.00 M117.93 101.57L163.76 105.58 M117.73 103.13L163.03 111.11 M117.39 104.66L161.82 116.56 M116.91 106.16L160.14 121.89 M116.31 107.61L158.00 127.05 M115.59 109.00L155.43 132.00 M114.74 110.32L152.43 136.71 M113.79 111.57L149.03 141.14 M112.73 112.73L145.25 145.25 M111.57 113.79L141.14 149.03 M110.32 114.74L136.71 152.43 M109.00 115.59L132.00 155.43 M107.61 116.31L127.05 158.00 M106.16 116.91L121.89 160.14 M104.66 117.39L116.56 161.82 M103.13 117.73L111.11 163.03 M101.57 117.93L105.58 163.76 M100.00 118.00L100.00 164.00 M98.43 117.93L94.42 163.76 M96.87 117.73L88.89 163.03 M95.34 117.39L83.44 161.82 M93.84 116.91L78.11 160.14 M92.39 116.31L72.95 158.00 M91.00 115.59L68.00 155.43 M89.68 114.74L63.29 152.43 M88.43 113.79L58.86 149.03 M87.27 112.73L54.75 145.25 M86.21 111.57L50.97 141.14 M85.26 110.32L47.57 136.71 M84.41 109.00L44.57 132.00 M83.69 107.61L42.00 127.05 M83.09 106.16L39.86 121.89 M82.61 104.66L38.18 116.56 M82.27 103.13L36.97 111.11 M82.07 101.57L36.24 105.58 M82.00 100.00L36.00 100.00 M82.07 98.43L36.24 94.42 M82.27 96.87L36.97 88.89 M82.61 95.34L38.18 83.44 M83.09 93.84L39.86 78.11 M83.69 92.39L42.00 72.95 M84.41 91.00L44.57 68.00 M85.26 89.68L47.57 63.29 M86.21 88.43L50.97 58.86 M87.27 87.27L54.75 54.75 M88.43 86.21L58.86 50.97 M89.68 85.26L63.29 47.57 M91.00 84.41L68.00 44.57 M92.39 83.69L72.95 42.00 M93.84 83.09L78.11 39.86 M95.34 82.61L83.44 38.18 M96.87 82.27L88.89 36.97 M98.43 82.07L94.42 36.24 M100.00 82.00L100.00 36.00 M101.57 82.07L105.58 36.24 M103.13 82.27L111.11 36.97 M104.66 82.61L116.56 38.18 M106.16 83.09L121.89 39.86 M107.61 83.69L127.05 42.00 M109.00 84.41L132.00 44.57 M110.32 85.26L136.71 47.57 M111.57 86.21L141.14 50.97 M112.73 87.27L145.25 54.75 M113.79 88.43L149.03 58.86 M114.74 89.68L152.43 63.29 M115.59 91.00L155.43 68.00 M116.31 92.39L158.00 72.95 M116.91 93.84L160.14 78.11 M117.39 95.34L161.82 83.44 M117.73 96.87L163.03 88.89 M117.93 98.43L163.76 94.42"/></g>
      <g stroke="#FFE9A8" stroke-width="0.3" opacity="0.3" transform="rotate(2.5 100 100)"><path d="M118.00 100.00L164.00 100.00 M117.93 101.57L163.76 105.58 M117.73 103.13L163.03 111.11 M117.39 104.66L161.82 116.56 M116.91 106.16L160.14 121.89 M116.31 107.61L158.00 127.05 M115.59 109.00L155.43 132.00 M114.74 110.32L152.43 136.71 M113.79 111.57L149.03 141.14 M112.73 112.73L145.25 145.25 M111.57 113.79L141.14 149.03 M110.32 114.74L136.71 152.43 M109.00 115.59L132.00 155.43 M107.61 116.31L127.05 158.00 M106.16 116.91L121.89 160.14 M104.66 117.39L116.56 161.82 M103.13 117.73L111.11 163.03 M101.57 117.93L105.58 163.76 M100.00 118.00L100.00 164.00 M98.43 117.93L94.42 163.76 M96.87 117.73L88.89 163.03 M95.34 117.39L83.44 161.82 M93.84 116.91L78.11 160.14 M92.39 116.31L72.95 158.00 M91.00 115.59L68.00 155.43 M89.68 114.74L63.29 152.43 M88.43 113.79L58.86 149.03 M87.27 112.73L54.75 145.25 M86.21 111.57L50.97 141.14 M85.26 110.32L47.57 136.71 M84.41 109.00L44.57 132.00 M83.69 107.61L42.00 127.05 M83.09 106.16L39.86 121.89 M82.61 104.66L38.18 116.56 M82.27 103.13L36.97 111.11 M82.07 101.57L36.24 105.58 M82.00 100.00L36.00 100.00 M82.07 98.43L36.24 94.42 M82.27 96.87L36.97 88.89 M82.61 95.34L38.18 83.44 M83.09 93.84L39.86 78.11 M83.69 92.39L42.00 72.95 M84.41 91.00L44.57 68.00 M85.26 89.68L47.57 63.29 M86.21 88.43L50.97 58.86 M87.27 87.27L54.75 54.75 M88.43 86.21L58.86 50.97 M89.68 85.26L63.29 47.57 M91.00 84.41L68.00 44.57 M92.39 83.69L72.95 42.00 M93.84 83.09L78.11 39.86 M95.34 82.61L83.44 38.18 M96.87 82.27L88.89 36.97 M98.43 82.07L94.42 36.24 M100.00 82.00L100.00 36.00 M101.57 82.07L105.58 36.24 M103.13 82.27L111.11 36.97 M104.66 82.61L116.56 38.18 M106.16 83.09L121.89 39.86 M107.61 83.69L127.05 42.00 M109.00 84.41L132.00 44.57 M110.32 85.26L136.71 47.57 M111.57 86.21L141.14 50.97 M112.73 87.27L145.25 54.75 M113.79 88.43L149.03 58.86 M114.74 89.68L152.43 63.29 M115.59 91.00L155.43 68.00 M116.31 92.39L158.00 72.95 M116.91 93.84L160.14 78.11 M117.39 95.34L161.82 83.44 M117.73 96.87L163.03 88.89 M117.93 98.43L163.76 94.42"/></g>
      <svg x="47.5" y="47.5" width="105" height="105" viewBox="0 0 100 100" overflow="visible">
        <defs><mask id="ring-acut"><rect width="100" height="100" fill="#fff"/><path d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z" fill="#000" stroke="#000" stroke-width="7" stroke-linejoin="round"/></mask></defs>
        <circle cx="50" cy="50" r="41.6" fill="none" stroke="#1A3DB5" stroke-width="14" mask="url(#ring-acut)"/>
        <circle cx="50" cy="50" r="41.6" fill="none" stroke="url(#ring-enamel)" stroke-width="11.66" mask="url(#ring-acut)"/>
        <circle cx="50" cy="50" r="46.6" fill="none" stroke="#000000" stroke-width="1.6" opacity="0.3" mask="url(#ring-acut)"/>
        <circle cx="50" cy="50" r="36.6" fill="none" stroke="#000000" stroke-width="1.4" opacity="0.22" mask="url(#ring-acut)"/>
        <circle cx="50" cy="50" r="41.6" fill="none" stroke="#4A72FF" stroke-width="2.2" opacity="0.6" stroke-dasharray="30 80" transform="rotate(-120 50 50)" mask="url(#ring-acut)"/>
        <path fill-rule="evenodd" fill="#8A6E12" opacity="0.9" transform="translate(2.2 2.5)" d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z M50 34.55L38.57 59.3L61.43 59.3Z"/>
        <path fill-rule="evenodd" fill="#FFE9A8" opacity="0.92" transform="translate(-1.8 -2)" d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z M50 34.55L38.57 59.3L61.43 59.3Z"/>
        <path fill-rule="evenodd" fill="url(#ring-aface)" filter="url(#ring-emboss)" d="M43.33 21.21L56.52 21.21L90.61 96.67L78.18 96.67L66.52 70.3L33.48 70.3L22.73 96.67L9.09 96.67Z M50 34.55L38.57 59.3L61.43 59.3Z"/>
      </svg>
      <circle cx="100" cy="100" r="80" fill="url(#ring-sheen)"/>
    </g>
  </g>
</svg>`;

export function CoinDisc({ size = 200, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const svg = DISC
    .replaceAll("ring-", `c${uid}-`)
    .replace("<svg ", `<svg width="100%" height="100%" style="display:block" `);
  return (
    <span
      className={cx("inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
