import { useEffect, useState } from "react";
import { isOnline, onConnectivity } from "../lib/offline/net";
import { localePath } from "../lib/wp";

/** A slim, dismissible banner shown while the device is offline, so it's clear what still works
 *  (watching + reading downloaded content) and what doesn't (posting, voting, competing). */
export function OfflineBanner() {
  const [online, setOnline] = useState(isOnline());
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => onConnectivity((o) => { setOnline(o); if (o) setDismissed(false); }), []);
  if (online || dismissed) return null;
  return (
    <div role="status" className="fixed inset-x-0 bottom-0 z-[60] flex items-center justify-center gap-3 border-t border-yin/40 bg-space-1/95 px-4 py-2 text-[13px] text-ink-2 backdrop-blur">
      <span className="inline-flex items-center gap-1.5 font-semibold text-yin-light">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M1 1l22 22" strokeLinecap="round" /><path d="M5 12.5a10 10 0 0 1 4-2.4M2 8.8A16 16 0 0 1 8 6M12 20h.01" strokeLinecap="round" /></svg>
        Offline
      </span>
      <span className="hidden sm:inline">Watching &amp; reading downloaded content works. Posting, voting, and competing need a connection.</span>
      <a href={localePath("/offline/")} className="font-semibold text-yang hover:underline">Manage downloads</a>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="ms-1 grid h-6 w-6 place-items-center rounded-full text-ink-3 hover:bg-veil/10 hover:text-ink">×</button>
    </div>
  );
}
