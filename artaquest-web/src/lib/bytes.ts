/**
 * Human file sizes. Its own module, not a component file: a file that exports BOTH components and
 * plain functions breaks React Fast Refresh (react-refresh/only-export-components), and this is
 * imported by the work page, the rail and anything else that lists a published file.
 */
/**
 * NOTE the caller's obligation: this returns a NUMBER followed by a Latin unit, which the bidi
 * algorithm reorders inside RTL text — "512 KB" renders as "KB 512" on a Persian page. Render it
 * inside the `aq-ltr` class (index.css) or a <bdi dir="ltr">. The isolation lives at the render
 * site, not here: embedding U+2068/U+2069 in the return value would put invisible control
 * characters into title attributes and translated sentences.
 */
export function fmtBytes(n: number) {
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
