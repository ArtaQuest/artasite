/**
 * Self-contained client for identity + the blue-check verification flow (talks to /identity,
 * /verify/status, /verify/identity directly so it doesn't depend on modules under active refactor).
 *
 * The ID + selfie images are sent ONCE for the check and never stored by the backend — see AQ\Verify.
 * We downscale every image in the browser before upload (keeps the request small and legible for the
 * vision check; the originals never leave the device beyond the single verification call).
 */

const BASE = "/wp-json/aq/v1";
const NONCE =
  (typeof window !== "undefined" && (window as unknown as { AQ_WP_NONCE?: string }).AQ_WP_NONCE) || "";

export type VerifyStatus = {
  full_name: string; birthday: string; has_identity: boolean;
  /** The member's stated nationality (ISO 3166-1 alpha-2), '' until stated. Asked at sign-up
   *  (defaulted from the visitor's country), shown as a flag on the public profile, and checked
   *  against the ID by the blue check (operator 2026-08-18). */
  nationality: string;
  verified: boolean; verified_at: number; last_note: string;
  configured: boolean;
};
export type VerifyResult = { ok?: boolean; verified?: boolean; reason?: string; error?: string; message?: string };

async function req<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(NONCE ? { "X-WP-Nonce": NONCE } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!r.ok) return { ...(j as object), error: (j as { error?: string }).error || "error", message: (j as { message?: string }).message } as T;
  return j;
}

/** Public verification facts for any profile (verified badge + public birthday + the verified-country
 *  avatar flag). Self-contained so it doesn't depend on the main profile loader (which is under
 *  refactor). */
export async function profileVerification(slug: string): Promise<{ verified: boolean; birthday: string; full_name: string; country: string } | null> {
  try {
    const r = await fetch(`${BASE}/profile?slug=${encodeURIComponent(slug)}`, {
      credentials: "include",
      headers: NONCE ? { "X-WP-Nonce": NONCE } : {},
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { verified?: boolean; birthday?: string; full_name?: string; country?: string };
    return { verified: !!j.verified, birthday: j.birthday || "", full_name: j.full_name || "", country: j.country || "" };
  } catch {
    return null;
  }
}

export const VerifyApi = {
  status: () => req<VerifyStatus>("/verify/status", "GET"),
  // Name + date of birth + nationality (ISO 3166-1 alpha-2). Nationality came back on 2026-08-18
  // (operator; it had gone on 08-11): the server REQUIRES a valid code until the account has one on
  // record, and thereafter an omitted/empty value leaves the stored claim untouched — so a form that
  // only edits the name still works, and a first-time member is never let through without one.
  setIdentity: (full_name: string, birthday: string, nationality?: string) =>
    req<{ ok?: boolean; error?: string; message?: string; full_name?: string; birthday?: string; nationality?: string }>(
      "/identity", "POST", nationality ? { full_name, birthday, nationality } : { full_name, birthday }),
  // Save the "fine-tune" birth time (minutes past local midnight) that positions the member's long-term goal.
  setBirthTime: (min: number) => req<{ ok?: boolean; min?: number }>("/identity/birthtime", "POST", { min }),
  verify: (imgs: { profile_pic: string; id_front: string; id_back: string; selfie: string }) =>
    req<VerifyResult>("/verify/identity", "POST", imgs),
  // Change ONLY the avatar — no ID-verify, free. Independent of the blue check.
  setPhoto: (image: string) =>
    req<{ ok?: boolean; avatar?: string; error?: string; message?: string }>("/profile/photo", "POST", { image }),
  // The palm "back photo" (ticket #94) — an opt-in image flipped behind the avatar. Free, public,
  // and independent of the blue check. Pass an image data-URL to set; call removePalm() to take it down.
  setPalm: (image: string) =>
    req<{ ok?: boolean; palm?: string; error?: string; message?: string }>("/profile/palm", "POST", { image }),
  removePalm: () =>
    req<{ ok?: boolean; palm?: string; error?: string; message?: string }>("/profile/palm", "POST", { remove: true }),
  // The profile BANNER (operator 2026-08-18) — the picture behind the profile header. Free, public,
  // session-only like the photo and the palm. A data-URL to set; removeBanner() paints the gold→blue
  // band again.
  setBanner: (image: string) =>
    req<{ ok?: boolean; banner?: string; error?: string; message?: string }>("/profile/banner", "POST", { image }),
  removeBanner: () =>
    req<{ ok?: boolean; banner?: string; error?: string; message?: string }>("/profile/banner", "POST", { remove: true }),
};

/** Read a File, downscale to <= maxDim on the long edge, return a JPEG data URL (small + legible). */
export async function fileToImage(file: File, maxDim = 1600, quality = 0.85): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("decode failed"));
    i.src = dataUrl;
  });
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  if (Math.max(w, h) > maxDim) {
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality);
}
