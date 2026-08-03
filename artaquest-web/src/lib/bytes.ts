/**
 * Human file sizes. Its own module, not a component file: a file that exports BOTH components and
 * plain functions breaks React Fast Refresh (react-refresh/only-export-components), and this is
 * imported by the work page, the rail and anything else that lists a published file.
 */
export function fmtBytes(n: number) {
  if (n > 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n > 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
