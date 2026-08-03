// ISO 3166-1 alpha-2 → numeric code. The world-atlas TopoJSON keys features by the
// numeric id, while the BFF reports donation reach by alpha-2 country code; this bridges
// the two so the choropleth can colour the right shapes. Static reference data.
export const ISO_A2_TO_NUM: Record<string, number> = {
  AF: 4, AL: 8, DZ: 12, AO: 24, AR: 32, AM: 51, AU: 36, AT: 40, AZ: 31,
  BD: 50, BY: 112, BE: 56, BJ: 204, BO: 68, BA: 70, BW: 72, BR: 76, BN: 96, BG: 100, BF: 854, BI: 108,
  KH: 116, CM: 120, CA: 124, CF: 140, TD: 148, CL: 152, CN: 156, CO: 170, CG: 178, CD: 180, CR: 188, CI: 384, HR: 191, CU: 192, CY: 196, CZ: 203,
  DK: 208, DJ: 262, DO: 214,
  EC: 218, EG: 818, SV: 222, GQ: 226, ER: 232, EE: 233, ET: 231,
  FI: 246, FR: 250,
  GA: 266, GM: 270, GE: 268, DE: 276, GH: 288, GR: 300, GL: 304, GT: 320, GN: 324, GW: 624, GY: 328,
  HT: 332, HN: 340, HU: 348,
  IS: 352, IN: 356, ID: 360, IR: 364, IQ: 368, IE: 372, IL: 376, IT: 380,
  JM: 388, JP: 392, JO: 400,
  KZ: 398, KE: 404, KP: 408, KR: 410, KW: 414, KG: 417,
  LA: 418, LV: 428, LB: 422, LS: 426, LR: 430, LY: 434, LT: 440, LU: 442,
  MK: 807, MG: 450, MW: 454, MY: 458, ML: 466, MR: 478, MX: 484, MD: 498, MN: 496, ME: 499, MA: 504, MZ: 508, MM: 104,
  NA: 516, NP: 524, NL: 528, NZ: 554, NI: 558, NE: 562, NG: 566, NO: 578,
  OM: 512,
  PK: 586, PA: 591, PG: 598, PY: 600, PE: 604, PH: 608, PL: 616, PT: 620, PR: 630,
  QA: 634,
  RO: 642, RU: 643, RW: 646,
  SA: 682, SN: 686, RS: 688, SL: 694, SK: 703, SI: 705, SO: 706, ZA: 710, SS: 728, ES: 724, LK: 144, SD: 729, SR: 740, SE: 752, CH: 756, SY: 760,
  TW: 158, TJ: 762, TZ: 834, TH: 764, TL: 626, TG: 768, TT: 780, TN: 788, TR: 792, TM: 795,
  UG: 800, UA: 804, AE: 784, GB: 826, US: 840, UY: 858, UZ: 860,
  VE: 862, VN: 704,
  YE: 887, ZM: 894, ZW: 716,
};

/** Resolve a donation-distribution country to the atlas numeric id. Accepts a row that
 *  may already carry a numeric `id`, else maps its alpha-2 `code`. Returns -1 if unknown. */
export function atlasId(row: { id?: number; code?: string }): number {
  if (typeof row.id === "number" && row.id > 0) return row.id;
  const c = (row.code || "").toUpperCase();
  return ISO_A2_TO_NUM[c] ?? -1;
}
