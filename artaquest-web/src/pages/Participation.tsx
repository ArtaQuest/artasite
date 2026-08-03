import { useEffect, useState } from "react";
import { participationCert, verifyParticipation, type PartCert } from "../lib/api";
import { isLoggedIn } from "../lib/auth";
import { Button, StatusNote } from "../components/ui";
import { ParticipationDoc } from "../components/participation";

/** Landscape paper, only while this page is mounted. `@page` cannot be nested under a selector, so
 *  the rule is injected and withdrawn rather than living in index.css, where it would rotate every
 *  other printable page on the site. */
function useLandscapePrint() {
  useEffect(() => {
    const el = document.createElement("style");
    el.textContent = "@media print{@page{size:landscape;margin:12mm}}";
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);
}

/**
 * The Certificate of Participation, on two routes and one component:
 *   /certificate/?challenge=<id>   the holder's own (auth-gated, GET /participation)
 *   /verify/?p=<ch>&u=<uid>&k=<code>  public authenticity check (GET /participation/verify)
 * Both WP pages already exist and are already SPA-served, so neither route is new to production.
 *
 * The verification leg is the point of the whole document: the code is an HMAC taken over the
 * server's auth salt, which is the one thing NOT in the public database — so a stranger can confirm
 * a printed certificate is genuine, and nobody can mint one.
 */
export default function Participation() {
  const q = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const challenge = Number(q.get("challenge") || 0);
  const p = Number(q.get("p") || 0), u = Number(q.get("u") || 0), k = q.get("k") || "";
  const isVerify = !!(p && u && k);

  const [cert, setCert] = useState<PartCert | null>(null);
  const [loaded, setLoaded] = useState(false);
  useLandscapePrint();

  useEffect(() => { document.title = "Certificate of Participation – ArtaQuest"; }, []);
  useEffect(() => {
    const go = isVerify ? verifyParticipation(p, u, k) : challenge ? participationCert(challenge) : Promise.resolve(null);
    go.then((r) => setCert(r && r.valid ? r : null), () => setCert(null)).finally(() => setLoaded(true));
  }, [isVerify, p, u, k, challenge]);

  if (!loaded) return <StatusNote className="py-20">Loading…</StatusNote>;

  if (!cert) {
    return (
      <div className="mx-auto max-w-lg py-20 text-center">
        <h1 className="text-[24px] font-bold tracking-tight">
          {isVerify ? "We can’t confirm this certificate" : "Certificate unavailable"}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          {isVerify
            ? "The code on this certificate doesn’t match anything we issued. Check you’ve copied it exactly — every character matters."
            : "Sign in to see a certificate you hold, or check the link. You hold one for every challenge you have entered."}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          {!isLoggedIn() && !isVerify && <Button href="/login/" size="lg">Sign in</Button>}
          <Button variant="outline" href="/challenges/" size="lg">See the challenges</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-8">
      {isVerify && (
        <p className="aq-no-print mx-auto rounded-pill border border-yang/40 bg-yang/10 px-4 py-1.5 text-[13px] font-semibold text-yang" role="status">
          Confirmed genuine — issued by the ArtaQuest Foundation
        </p>
      )}
      <ParticipationDoc cert={cert} />
      <div className="aq-no-print mx-auto flex flex-wrap items-center justify-center gap-3">
        <Button onClick={() => window.print()} className="h-10 px-5 text-[14px]">Print / Save as PDF</Button>
        {cert.work_url && <Button variant="outline" href={cert.work_url} className="h-10 px-5 text-[14px]">See the work</Button>}
      </div>
      {!isVerify && cert.verify_url && (
        <p className="aq-no-print text-center text-[12px] text-ink-3">
          Anyone can confirm this is genuine at{" "}
          <a href={cert.verify_url} className="text-yin-light underline-offset-2 hover:underline" data-ay-skip="1">
            artaquest.com{cert.verify_url.split("?")[0]}
          </a>
        </p>
      )}
    </div>
  );
}
