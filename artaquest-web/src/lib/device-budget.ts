// Device memory budget — the on-device models are gated by what THIS device can actually hold, so a
// heavy model never OOM-crashes the tab/system (operator, 2026-07-23). Requirements are approximate
// RESIDENT costs (weights + runtime tensors + arena), checked against reported device memory with a
// standing allowance for the OS + the rest of the browser.
//
// navigator.deviceMemory is Chromium-only (GB, capped at 8): where it's missing (Safari/Firefox) we
// assume 8 GB on desktop and 3 GB on mobile — conservative for phones, permissive for laptops.

export type HeavyModel = "piper" | "kokoro" | "kokoro-fp32" | "nllb" | "florence" | "texify";

const NEED_GB: Record<HeavyModel, number> = {
  piper: 0.3,          // 61 MB VITS + ort arena
  kokoro: 0.7,         // q8/f16 Kokoro + ort arena
  "kokoro-fp32": 2.2,  // 326 MB weights, fp32 activations
  nllb: 2.6,           // ~900 MB int8 seq2seq + KV cache + arena
  florence: 1.8,       // ~405 MB weights, fp16 vision activations
  texify: 1.5,         // ~320 MB q8 seq2seq (texify2 image→LaTeX) + KV cache + arena
};
const SYSTEM_ALLOWANCE_GB = 2; // OS + other tabs + the page itself

function isMobile(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  return nav.userAgentData?.mobile === true || (matchMedia("(pointer: coarse)").matches && navigator.maxTouchPoints > 0);
}

export function deviceMemGB(): number {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof dm === "number" && dm > 0) return dm;
  return isMobile() ? 3 : 8;
}

/** Can this device hold `model` without endangering the system? `why` is member-facing when not. */
export function canRun(model: HeavyModel): { ok: boolean; why?: string } {
  const mem = deviceMemGB();
  // The really heavy models are desktop-class, full stop — mobile browsers hard-kill big WASM heaps.
  if (isMobile() && (model === "nllb" || model === "florence" || model === "texify" || model === "kokoro-fp32")) {
    return { ok: false, why: "This needs a desktop-class device — on phones the reader keeps to the lighter voices." };
  }
  if (mem < NEED_GB[model] + SYSTEM_ALLOWANCE_GB) {
    return { ok: false, why: `This device reports ~${mem} GB of memory — not enough to run this safely (needs ~${NEED_GB[model]} GB free).` };
  }
  return { ok: true };
}
