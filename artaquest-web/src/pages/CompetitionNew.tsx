import { useState } from "react";
import { Competitions } from "../lib/api";
import { Button, Card, ErrorNote, Field, Input, Textarea } from "../components/ui";
import { WithRail, RailInline } from "../components/PageRail";
import { isLoggedIn, localePath } from "../lib/wp";

/* The one contextual card on this page: how a dataset actually gets uploaded. It answers the
   question the form provokes ("where do I put the files?") without being a step OF the form, so it
   belongs beside it, not under it. Defined once and rendered by both <WithRail> and <RailInline> —
   two copies drift.

   A component, not a bare const: localePath() reads window.AQ_I18N, so a const would freeze the
   link's locale at MODULE-EVALUATION time. It happens to be safe today (the shell sets AQ_I18N
   inline before the bundle runs, and switchLang() does a full location.assign rather than mutating
   it), but the card used to resolve its href on render and there is no reason to make that depend
   on script ordering. */
function DatasetHelp() {
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">Uploading a dataset</h2>
      <p className="text-[13px] leading-relaxed text-ink-3">
        Custom dataset uploads are set up by hand for now. Once your competition exists, reach us via{" "}
        <a href={localePath("/faq-contact/")} className="text-yin-light hover:underline">FAQ &amp; contact</a>{" "}
        with your train/test files and the target you want scored, and we&rsquo;ll wire in the hidden holdout.
      </p>
    </section>
  );
}

/* /competitions/new — a minimal host form. Title + one-line blurb create the competition and its
   leaderboard; the dataset itself is set up manually for v1 (a "contact us" note explains it). */
export default function CompetitionNewPage() {
  const [title, setTitle] = useState("");
  const [blurb, setBlurb] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (!isLoggedIn()) {
    const login = (typeof window !== "undefined" && (window as unknown as Record<string, string>).AQ_LOGIN_URL) || "/login/";
    const redirect = typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
    return (
      <div className="mx-auto max-w-lg py-10">
        <Card className="p-8 text-center">
          <p className="text-[15px] font-semibold text-ink">Sign in to host a competition</p>
          <p className="mt-1.5 text-[13px] text-ink-3">You need an account to publish a dataset — it&rsquo;s free.</p>
          <Button href={`${login}?redirect_to=${encodeURIComponent(redirect)}`} className="mt-4">Sign in</Button>
        </Card>
      </div>
    );
  }

  async function create() {
    const t = title.trim();
    if (!t) { setErr("Give your competition a title."); return; }
    setBusy(true); setErr("");
    try {
      const { slug } = await Competitions.create({ title: t, blurb: blurb.trim() });
      window.location.assign(localePath(`/competition/?slug=${encodeURIComponent(slug)}`));
    } catch (e) {
      setErr((e as Error).message || "Couldn't create the competition. Please try again.");
      setBusy(false);
    }
  }

  return (
    /* No max-width and no px-* here: AppShell already centres the page in max-w-content with
       px-gutter, and <WithRail> needs the full width to seat its 320px rail. The form keeps its own
       max-w-lg on the content column below — it is deliberately narrower than the shell. */
    <div className="flex flex-col">
      <WithRail label="Hosting a competition" rail={<DatasetHelp />}>
        <div className="mx-auto max-w-lg">
          <a href={localePath("/competitions/")} className="mb-5 inline-flex text-[13px] text-ink-3 hover:text-yin-light"><span aria-hidden className="inline-block rtl:-scale-x-100">←</span> Competitions</a>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">New competition</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-3">
            Host a dataset with a hidden holdout and let others compete on it. Name it and describe it in a line;
            we&rsquo;ll set the leaderboard up straight away.
          </p>

          <div className="mt-6 space-y-4">
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Forecast the lunar-trend series" maxLength={120} />
            </Field>
            <Field label="One-line blurb" optional>
              <Textarea rows={3} value={blurb} onChange={(e) => setBlurb(e.target.value)}
                placeholder="What competitors are predicting, and why it matters." maxLength={280} className="w-full" />
            </Field>
            {err && <ErrorNote>{err}</ErrorNote>}
            <Button onClick={create} disabled={busy}>{busy ? "Creating…" : "Create competition"}</Button>
          </div>
        </div>
      </WithRail>

      {/* Below lg the rail leaves the flow, so the same card rides under the form instead — aligned
          to the form's own column, not the full shell width. */}
      <RailInline>
        <div className="mx-auto mt-6 w-full max-w-lg"><DatasetHelp /></div>
      </RailInline>
    </div>
  );
}
