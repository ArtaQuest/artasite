import { useEffect, useState } from "react";
import { verifyCertificate, type Cert } from "../lib/wp";
import { Button } from "../components/ui";
import { CertificateDoc } from "./Certificate";

// Public certificate authenticity check (route /verify/?c=<course>&u=<user>&k=<code>). Anyone holding a
// printed or shared ArtaQuest certificate can confirm it is genuine here — no sign-in needed. The code is
// an HMAC of (user, course) under a server-only salt, so a forged certificate can't pass. A valid result
// re-renders the exact certificate; anything else is reported as unverifiable.
export default function Verify() {
  const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const c = Number(q.get("c") || 0);
  const u = Number(q.get("u") || 0);
  const k = q.get("k") || "";
  const [cert, setCert] = useState<Cert | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!c || !u || !k) { setLoaded(true); return; }
    verifyCertificate(c, u, k).then(setCert).finally(() => setLoaded(true));
  }, [c, u, k]);
  useEffect(() => { document.title = "Verify certificate – ArtaQuest"; }, []);

  if (!loaded) return <p role="status" className="py-20 text-center text-ink-3">Verifying…</p>;

  const ok = !!(cert && cert.valid);

  if (!ok) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border-2 border-rose-400/50 text-rose-400" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </div>
        <h1 className="mt-5 text-[24px] font-bold tracking-tight">Couldn’t verify this certificate</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          The verification link is incomplete, altered, or the certificate has not been earned. A genuine
          ArtaQuest certificate carries a code that only this page can confirm.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Button href="/courses/" size="lg">Browse courses</Button>
          <Button variant="outline" href="/" size="lg">Home</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl py-8">
      <div className="aq-no-print mx-auto mb-5 flex max-w-2xl items-center gap-3 rounded-card border border-yang/40 bg-yang/10 px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-yang/20 text-yang" aria-hidden>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
        </span>
        <div className="text-left">
          <p className="text-[14px] font-semibold text-ink">Authentic certificate</p>
          <p className="text-[12px] text-ink-2" data-ay-skip="1">
            Issued by the ArtaQuest Foundation to {cert!.learner} for {cert!.course}.
          </p>
        </div>
      </div>
      <CertificateDoc cert={cert!} />
    </div>
  );
}
