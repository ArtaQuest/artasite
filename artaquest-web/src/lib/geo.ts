// Country / currency layer — mirrors window.AQ_GEO injected by the theme
// (includes/aq-geo.php). A visitor's country drives the UI language, the
// display currency, the PPP-equity price, and which payment rails appear.

export type GeoCountry = {
  id: string;        // selector id (multilingual countries carry a -lang suffix, e.g. "CA-fr")
  iso2: string;      // two-letter country code (cookie + gateway gating)
  name: string;      // display label
  flag: string;      // emoji flag
  lang: string;      // supported UI locale (en/de/es/fr/zh/ja/hi/ar)
  currency: string;  // ISO 4217 display currency
};
export type Geo = {
  country: string;   // current selector id
  iso2: string;
  lang: string;
  currency: string;
  symbol: string;
  countries: GeoCountry[];
};

// A world-atlas country feature (Natural Earth 110m, numeric ISO 3166-1 ids).
export type AtlasFeature = { id?: string | number; type: string; geometry: unknown };

/**
 * Load the world atlas as GeoJSON features for the choropleth maps. The ~105KB topojson is
 * SELF-HOSTED (src/assets) and lazily imported, so it's a separate on-demand chunk (not in the
 * main bundle) AND served same-origin — no third-party CDN fetch (no visitor-IP leak on this
 * no-tracking platform; no silent failure when a CDN is blocked). Shared by every map.
 */
export async function loadWorldGeos(): Promise<AtlasFeature[]> {
  const [{ feature }, topo] = await Promise.all([
    import("topojson-client"),
    import("../assets/countries-110m.json"),
  ]);
  const t = (topo as { default?: unknown }).default ?? topo;
  const fc = feature(t as never, (t as { objects: { countries: unknown } }).objects.countries as never) as unknown as { features: AtlasFeature[] };
  return fc.features;
}

export function geo(): Geo | null {
  if (typeof window === "undefined") return null;
  const v = (window as unknown as { AQ_GEO?: Geo }).AQ_GEO;
  return v && Array.isArray(v.countries) && v.countries.length ? v : null;
}

const COOKIE = "aq_country_id";

function cookie(name: string): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

/** Active country selector id: saved cookie → server geo default → Canada. */
export function aqCountryId(): string {
  return cookie(COOKIE) || geo()?.country || "CA";
}

/** Persist the chosen country (1-year cookie) so the server localizes prices + gateways. */
export function setCountryCookie(id: string, iso2: string) {
  if (typeof document === "undefined") return;
  const attrs = "; max-age=" + 60 * 60 * 24 * 365 + "; path=/; samesite=lax";
  document.cookie = `${COOKIE}=${encodeURIComponent(id)}${attrs}`;
  document.cookie = `aq_country=${encodeURIComponent(iso2)}${attrs}`;
}

/** Languages the site actually has enabled (from window.AQ_I18N). */
function availableLangs(): string[] {
  const i = (window as unknown as { AQ_I18N?: { langs?: { code: string }[] } }).AQ_I18N;
  return i?.langs?.map((l) => l.code) ?? ["en"];
}

/**
 * The current page's URL under a new language prefix — mirrors the server
 * AQ_I18N_Router::convert_url (strip an existing /xx/ prefix, prepend the
 * target's; English is un-prefixed). Falls back to the current path when the
 * target language isn't enabled on the site.
 */
export function langUrl(code: string): string {
  const langs = availableLangs();
  const targets = langs.filter((c) => c !== "en");
  let path = window.location.pathname || "/";
  // Match a language prefix: 2-3 letters, optional "-xx[xx]" region/script (zh-tw, mni-mtei).
  const m = path.match(/^\/([a-z]{2,3}(?:-[a-z]{2,4})?)(?:\/|$)/i);
  if (m && targets.includes(m[1].toLowerCase())) {
    path = path.slice(m[1].length + 1) || "/";
    if (!path.startsWith("/")) path = "/" + path;
  }
  const supported = langs.includes(code);
  const prefix = !supported || code === "en" ? "" : "/" + code;
  return prefix + path + window.location.search + window.location.hash;
}

/**
 * Switch to a country: persist the choice, then reload into its language so the
 * whole server-rendered shell + BFF prices re-localize. A full navigation (not
 * SPA) is intentional — the server reads the cookie on render.
 */
export function chooseCountry(c: GeoCountry) {
  setCountryCookie(c.id, c.iso2);
  window.location.assign(langUrl(c.lang));
}

/**
 * Switch the UI language directly (the language selector). Persists a sticky
 * `ay_lang` cookie — the same cookie the server's first-visit detector reads, so
 * the choice survives future visits — then navigates to the language's URL so the
 * server re-renders the shell + the client mesh translates everything.
 */
export function switchLang(code: string) {
  if (typeof document !== "undefined") {
    document.cookie = `ay_lang=${encodeURIComponent(code)}; max-age=${60 * 60 * 24 * 365}; path=/; samesite=lax`;
  }
  if (typeof window !== "undefined") window.location.assign(langUrl(code));
}
