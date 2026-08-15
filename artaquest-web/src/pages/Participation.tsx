import { useEffect, useState } from "react";
import { participationCert, verifyParticipation, type PartCert } from "../lib/api";
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
 * Paste the verification address; we pull the three values out of it and go.
 *
 * Deliberately accepts the WHOLE address rather than asking for three fields — what a person has is
 * a line of text they copied or typed off a document, not three labelled values, and asking them to
 * take it apart is asking them to do the parsing. A bare code alone cannot work: the check is an
 * HMAC over (challenge, member, code), so it needs all three, which is exactly why the certificate
 * now shows the full address instead of its first half.
 */
function VerifyPaste() {
  const [raw, setRaw] = useState("");
  const [bad, setBad] = useState(false);
  function go(e: React.FormEvent) {
    e.preventDefault();
    // Tolerant on purpose: a full URL, a path, or just the query — anything that carries the three
    // values. Somebody retyping this from paper will not reproduce the scheme and host exactly.
    const s = raw.trim();
    const qs = s.includes("?") ? s.slice(s.indexOf("?") + 1) : s;
    const q = new URLSearchParams(qs);
    const p = Number(q.get("p") || 0), u = Number(q.get("u") || 0), k = (q.get("k") || "").trim();
    if (!p || !u || !k) { setBad(true); return; }
    window.location.href = `/verify/?p=${p}&u=${u}&k=${encodeURIComponent(k)}`;
  }
  return (
    <form onSubmit={go} className="mt-5 flex flex-col gap-2 text-start">
      <label htmlFor="aq-cert-paste" className="text-[13px] font-semibold text-ink">Verification address</label>
      <input id="aq-cert-paste" value={raw} onChange={(e) => { setRaw(e.target.value); setBad(false); }}
        placeholder="artaquest.com/verify/?p=…&u=…&k=…" spellCheck={false} autoCapitalize="off"
        className="h-11 w-full rounded-field border border-line bg-space-2 px-4 text-[15px] text-ink outline-none transition-colors focus:border-yin-light" />
      {bad && (
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          That address is missing part of the code. Copy the whole line from the certificate — it ends
          with three values after the question mark.
        </p>
      )}
      <Button type="submit" className="h-11 self-start px-6">Check it</Button>
    </form>
  );
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
          {isVerify ? "We can’t confirm this certificate" : "Check a certificate"}
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-2">
          {isVerify
            ? "The code on this certificate doesn’t match anything we issued. Check you’ve copied it exactly — every character matters."
            : "Paste the full verification address from the certificate and we’ll check it against what we issued. You don’t need an account — that is the point of this page."}
        </p>
        {/* THE FORM THIS PAGE ALWAYS NEEDED. `participation/verify` is a 'public' route whose entire
            reason to exist is a stranger holding a certificate somebody else earned, checking it
            against an HMAC they cannot forge. Bare /verify answered that person with "Sign in to see
            a certificate you hold" — the one thing they neither have nor want. Signed-in members
            reach their own certificate from the challenge, not from here. */}
        {!isVerify && <VerifyPaste />}
        <div className="mt-6 flex justify-center gap-3">
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
        /* THE WHOLE URL, including its query. The link had always carried ?p=&u=&k=, but the visible
           text was `verify_url.split("?")[0]` — so what a reader could copy, read down a phone or
           type from a printout was "artaquest.com/verify", which is precisely the part that does not
           work: bare /verify has no certificate to check and used to answer a stranger by asking them
           to sign in. The address is long; being able to act on what you can see matters more. */
        <p className="aq-no-print break-all text-center text-[12px] text-ink-3">
          Anyone can confirm this is genuine at{" "}
          <a href={cert.verify_url} className="text-yin-light underline-offset-2 hover:underline" data-ay-skip="1">
            artaquest.com{cert.verify_url}
          </a>
        </p>
      )}
    </div>
  );
}
