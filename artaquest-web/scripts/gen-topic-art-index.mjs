/**
 * Build step: enumerate the bundled topic-art SVGs (public/topic-art/*.svg) into
 * public/topic-art-index.json — the list the Studio editors' "SVG library" picker reads so an
 * author can pick an existing icon for any image field (ticket #140). Kept in public/ so it ships
 * both in dev (served at /topic-art-index.json) and prod (Vite copies public/ → the theme app/,
 * served under …/artaquest-theme/app/topic-art-index.json). Run before every build, and committed
 * so the picker also works in plain `vite dev` without a build.
 */
import { readdirSync, writeFileSync } from "node:fs";

const DIR = new URL("../public/topic-art/", import.meta.url);
const OUT = new URL("../public/topic-art-index.json", import.meta.url);

const files = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith(".svg"))
  .sort(); // alphabetical groups each system with its `__option` variants

writeFileSync(OUT, JSON.stringify(files));
console.log(`topic-art-index.json: ${files.length} svgs`);
