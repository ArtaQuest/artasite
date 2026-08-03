/**
 * Country flags for verified nationality (ticket #30). A member's verified nationality arrives on
 * user cards as `country` (ISO 3166-1 alpha-2, '' until they pass the blue-check verification —
 * AQ\Verify::badge_country). The flag overlays the avatar everywhere via <Avatar country={…}>.
 *
 * Zero-dependency by design: flags are EMOJI (two regional-indicator code points — no sprite sheet,
 * no flag CDN that would leak page views to a third party), and country NAMES come from the
 * browser's own CLDR data via Intl.DisplayNames, localized to the active app language.
 */
import { currentLang } from "./i18n";

/** Every officially assigned ISO 3166-1 alpha-2 code — ALL of them, mirroring the backend list
 *  (AQ\Verify::COUNTRIES). No allow-list: every nationality verifies identically. */
export const COUNTRY_CODES: readonly string[] =
  ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
   "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
   "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
   "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
   "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
   "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
   "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW").split(" ");

/** ISO alpha-2 → flag emoji ("DE" → 🇩🇪). '' for anything that isn't two letters, so a missing /
 *  unverified country renders nothing. */
export function flagEmoji(code?: string): string {
  const c = (code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65)));
}

/** Localized country name for tooltips / the picker — the active app language, falling back to
 *  English, falling back to the bare code (Intl.DisplayNames is in every browser we support, but
 *  never let a missing locale pack break rendering). */
export function countryName(code?: string, locale?: string): string {
  const c = (code || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  try {
    return new Intl.DisplayNames([locale || currentLang() || "en", "en"], { type: "region" }).of(c) || c;
  } catch {
    return c;
  }
}

/** The nationality picker's option list — every country, localized + sorted for the active
 *  language. Computed on demand (it's only needed on the identity form). */
export function countryOptions(locale?: string): { code: string; name: string }[] {
  const lang = locale || currentLang() || "en";
  const opts = COUNTRY_CODES.map((code) => ({ code, name: countryName(code, lang) }));
  try {
    const coll = new Intl.Collator(lang);
    opts.sort((a, b) => coll.compare(a.name, b.name));
  } catch {
    opts.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  return opts;
}
