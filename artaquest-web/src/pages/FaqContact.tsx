import { type ReactNode, useEffect, useRef } from "react";
import { Button, Card } from "../components/ui";
import { localePath } from "../lib/wp";

type QA = { q: string; a: ReactNode };
type Section = { title: string; items: QA[] };

// FAQ content — the EXACT same strings as the server's aq_faq_items() (theme aq-app.php), kept
// plain-text so the crawler layer, the FAQPage JSON-LD, and this rendered page are one set of
// strings sharing one translation-cache entry each. Keep the two in lockstep.
const SECTIONS: Section[] = [
  {
    title: "The feed & publishing",
    items: [
      { q: "What is ArtaQuest?", a: "A social feed of citable, reproducible work. Every submission is a public Kaggle notebook that has been run: you paste the link to its output page, pick which of its output files to publish, and a reproducibility checklist runs against Kaggle's public API before anything goes out. Published files land in the Library, where any member can attach them to their posts. Reading, playing and running everything is free, no account needed." },
      { q: "How do I publish?", a: "Paste the link to your notebook's output page on Kaggle, pick the files you want to publish, read the checklist, then request publication. Requesting is not publishing: a single-use secret goes to your own registered email address, and your click on it, signed by your device passkey, is what publishes the work and mints its permanent citation link. No token, no agent, no relay and no operator can take that step for you." },
      { q: "What does reproducible mean here?", a: "That anyone can press Copy and Edit, then Run All, on your public Kaggle notebook, from public inputs, and get this. That is weaker than a promise of identical bytes, and much stronger than asking the world to trust a run on somebody's laptop. We do not execute anything ourselves. Kaggle does, and we read its public record." },
      { q: "What does the checklist actually check?", a: "About twenty deterministic checks in four groups: can anyone open it, can anyone re-run it, did that run produce these files, and how repeatable is the result. Every check names the exact evidence it read, so you can go and read it yourself. The blocking checks must all pass; warnings are shown loudly and never block. Nothing is scored, ranked, graded or judged." },
      { q: "Was the internet switched off during the run?", a: "The checklist reports what Kaggle's own record says. Kaggle enforces that switch, not us — so a work either ran with the internet switched off, on Kaggle's own record, or the page says plainly that it did not. Either way you are told, and you can check the same record we did." },
      { q: "Why a Kaggle notebook and a DOI as well?", a: "The Kaggle notebook is the provenance: public code, public inputs, and a public run anyone can repeat without asking us for anything. The DOI — a permanent citation link — is the citation of record, because a notebook belongs to its owner and can be edited or deleted at any time, and a DOI cannot." },
      { q: "Do I need an account?", a: "You can read, play and run everything without one. A free account is needed to post, heart, publish and enter challenges. Signing up takes under a minute and needs only an email address; there are no passwords, ever." },
      { q: "Can I join if I am under 18?", a: "Members aged 13 and over may register with parental or guardian consent. Buying Arta Coins, or any other payment, requires the account holder to be 18 or older, or a parent or guardian to complete the transaction." },
    ],
  },
  {
    title: "Challenges, hearts & coins",
    items: [
      { q: "How do challenges work?", a: "A challenge is founded by a member: pick a sitewide topic and a full-moon deadline, set the entry fee, and open it with your own published work — the founder pays in like everyone else. Every entrant's fee goes straight into the pool, and at the full moon the most-hearted entry takes the whole pool; an exact tie splits it evenly. The Foundation never takes a cut." },
      { q: "How do I enter a challenge?", a: "With work of your own that is already published: a public Kaggle notebook that has passed the checklist and been confirmed from your inbox. Pay the entry fee — all of it goes into the pool — one entry per member per challenge. At the deadline only the hearts decide." },
      { q: "Why hearts instead of up and down votes?", a: "Because taste needs no negative. You heart what you love — one heart per member per reply or work, never your own — and the counts rank the boards. There is nothing to downvote: content that trades in hate or fear is handled by ArtaMod, not by pile-ons, and everything else deserves to stand on the love it earns. Every heart is public in the Data explorer." },
      { q: "What's the difference between coins and points?", a: "Two different things. Arta Coins are money — gold-backed, spendable, cashable; you win them by taking a challenge pool. Points are standing — a lifetime tally of what you've contributed that sets your rank (Quester to Legend). You earn points by creating (publishing works), engaging (a point for each reply you post), donating (a point per coin given), and volunteering (resolved contributions, shares, referrals). Spending coins never lowers your points." },
    ],
  },
  {
    title: "Donations & coins",
    items: [
      { q: "How do I donate?", a: "Go to the Donate page, pick or enter an amount, and continue to checkout. Pay by Interac e-Transfer or card; you will see payment instructions immediately. We confirm receipt within 1–2 business days." },
      { q: "What is Arta Coin (₳)?", a: "Arta Coin (₳) is ArtaQuest's currency. Each coin is a claim on one milligram of real gold, and the Reserve page publishes the live ratio of gold held to coins issued — so you can check the backing yourself instead of taking our word for it. A coin is worth the same in every country. You win coins by taking challenge pools, and you can buy or cash them out at the live gold rate from your Wallet." },
      { q: "Why is the donation in CAD?", a: "The foundation banks in Canada, so checkout is denominated in Canadian dollars. Card payments convert your local currency automatically; Interac is for Canadian bank accounts." },
      { q: "What can I do with Arta Coins?", a: "Found or enter challenges, donate them to the member fund (which also earns you donor points), or cash them out for ordinary money at the live gold rate from your Wallet. Every coin is a claim on one milligram of gold; the live backing ratio is on the Reserve page." },
      { q: "Can I get a tax receipt?", a: "Not an official one, and we would rather say so plainly than leave you to find out at tax time. ArtaQuest Foundation is a Canadian non-profit corporation, not a registered charity, and CRA does not permit a non-profit to issue official donation receipts — so a gift to us is not tax-deductible. Every donation does trigger an email confirmation you can keep as a record, and every cent of it appears in the Foundation's published books, on the Finances page." },
      { q: "Can I get my donation back?", a: "Donations are non-refundable in general (see the Refund Policy), except for duplicate or unauthorised payments. Coins minted for a refunded donation are reversed." },
    ],
  },
  {
    title: "Bursaries & financial support",
    items: [
      { q: "What is a bursary for?", a: "So that cost never decides who takes part. Through the Sponsors programme, donors earmark Arta Coins to a community, and bursaries draw on that fund. Where it stands today: the bursary form still covers the retired course fee, not a challenge entry, so it cannot pay a challenge fee yet — we would rather say so than send you to a form that cannot help. Every coin in the fund is public in the ledgers meanwhile." },
      { q: "What proof of income do I need for a bursary?", a: "One document is enough: a CRA Notice of Assessment, a government benefit letter (AISH, Alberta Works, Income Support, or equivalent), a credit rating report classifying your income as Low, or another means-tested document." },
    ],
  },
  {
    title: "About ArtaQuest",
    items: [
      { q: "Is ArtaQuest a registered organisation?", a: "Yes. ArtaQuest Foundation is a registered Canadian non-profit. It operates exclusively for educational purposes and distributes no profit to members. The non-profit structure is deliberate — it protects the platform's independence from being acquired, monetised, or quietly steered off its mission." },
      { q: "What is ArtaQuest's position on AI?", a: "An AI is trained to give you its single most likely answer — to collapse a world of possibilities into one. As a tool, that is powerful. As a substitute for thinking, it quietly narrows what people believe is possible, and rewards accepting the average answer over working one out. It also burns a great deal of energy. ArtaQuest was built in response — not against the technology, but for the human faculty it cannot replace: the ability to think for yourself, and to widen a question the machine has narrowed." },
      { q: "Does ArtaQuest promote a particular ideology or worldview?", a: "No. We do not advocate for any tradition, denomination, or political position, and we accept no funding that would pull us toward one. We bring you the best free knowledge we can find, present the strongest honest case for competing positions, and let you reach your own conclusion rather than handing you one. No fear-mongering, no hate speech, no propaganda." },
      { q: "Where does ArtaQuest's funding come from?", a: "Donations. Submitting, checking and publishing are all free, and challenge pools are never touched: 100% of entry fees returns to the winning entrants. Every gift, every coin and every gold figure is in the open ledgers — see the live Reserve and the Data explorer." },
      { q: "Does ArtaQuest have charitable status for tax receipts?", a: "No. We are incorporated as a Canadian non-profit and rely on the paragraph 149(1)(l) income-tax exemption; we have not obtained charitable registration from the Canada Revenue Agency, and until we do we cannot issue official donation receipts. If that ever changes, this page will say so first." },
    ],
  },
];

// Stable slug for any heading/question — shared by the quick-jump nav, section anchors, and
// per-question deep-link ids.
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function FaqItem({ q, a, id }: QA & { id: string }) {
  return (
    // Deep-linkable: opening a question reflects it in the URL hash (so the address bar is
    // shareable), and a shared #id is opened + scrolled to on load (see the page effect below).
    <details id={id} className="group scroll-mt-24 border-b border-line/70"
      onToggle={(e) => { if (e.currentTarget.open && window.location.hash !== "#" + id) history.replaceState(null, "", "#" + id); }}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-[15.5px] font-semibold text-ink marker:content-none [&::-webkit-details-marker]:hidden">
        {q}
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-ink-3 transition-transform duration-200 group-open:rotate-180" aria-hidden><path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </summary>
      <div className="pb-4 pe-8 text-[15px] leading-relaxed text-ink-2">{a}</div>
    </details>
  );
}

export default function FaqContact() {
  // Emit FAQPage structured data (eligible for FAQ rich results) built from the RENDERED Q&A —
  // a single source that can't drift from the visible content and handles answers containing links.
  // Google's renderer reads React-injected JSON-LD; the node is removed on unmount.
  const faqRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = faqRef.current;
    if (!root) return;
    const qa = [...root.querySelectorAll("details")]
      .map((d) => ({ q: d.querySelector("summary")?.textContent?.trim() || "", a: d.querySelector("div")?.textContent?.trim() || "" }))
      .filter((x) => x.q && x.a);
    if (!qa.length) return;
    const el = document.createElement("script");
    el.type = "application/ld+json";
    el.id = "aq-faq-schema";
    el.textContent = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: qa.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })),
    });
    document.head.appendChild(el);
    return () => { el.remove(); };
  }, []);

  // Deep-link to a specific question: a shared URL ending in #<question-slug> (e.g. from support)
  // opens that <details> and scrolls to it. Runs on mount and on in-page hash changes.
  useEffect(() => {
    function openFromHash() {
      const id = decodeURIComponent(window.location.hash.slice(1));
      const el = id ? document.getElementById(id) : null;
      if (el instanceof HTMLDetailsElement) {
        el.open = true;
        el.scrollIntoView({ block: "start" });
        // Move keyboard focus to the opened question (not just scroll) so the next Tab resumes from
        // here and a screen reader announces it — the WCAG 2.4.3 focus-order fix pass-16 applied to
        // the sections, now also for shareable per-question deep-links. preventScroll keeps the
        // scrollIntoView positioning instead of focus() re-scrolling.
        el.querySelector("summary")?.focus({ preventScroll: true });
      }
    }
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  return (
    <div className="flex flex-col gap-12 pb-12">
      <header className="max-w-2xl">
        <h1 className="text-[clamp(2rem,4vw,2.75rem)] font-extrabold leading-tight">FAQ & contact</h1>
        <p className="mt-3 text-[16px] leading-relaxed text-ink-2">Answers to the most common questions about ArtaQuest — publishing, the reproducibility checklist, Arta Coins, bursaries, and what we believe about knowledge, AI, and thinking for yourself.</p>
      </header>

      {/* quick-jump to a topic — uses the section anchors already in the accordion below */}
      <nav aria-label="Jump to a topic" className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <a key={s.title} href={`#${slugify(s.title)}`} className="inline-flex min-h-[34px] items-center rounded-pill border border-line bg-space-2 px-3.5 text-[13px] font-semibold text-ink-2 transition-colors hover:border-yang/50 hover:text-yang">{s.title}</a>
        ))}
      </nav>

      <div className="grid gap-10 lg:grid-cols-[1fr_300px] lg:items-start">
        {/* FAQ accordion */}
        <div ref={faqRef} className="flex flex-col gap-9">
          {SECTIONS.map((s) => (
            // tabIndex=-1 so a quick-jump anchor moves keyboard FOCUS to the section (not just the scroll)
            // — otherwise the next Tab resumes from the nav link, not where the user jumped (WCAG 2.4.3).
            // It's a scroll target, not a control, so the focus ring is suppressed.
            <section key={s.title} id={slugify(s.title)} tabIndex={-1} className="scroll-mt-24 outline-none">
              <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-[0.18em] text-ink-3">{s.title}</h2>
              <div>{s.items.map((it) => <FaqItem key={it.q} id={slugify(it.q)} {...it} />)}</div>
            </section>
          ))}
        </div>

        {/* Contact rail */}
        <aside className="lg:sticky lg:top-20">
          <Card className="p-6">
            <h2 className="text-[18px] font-bold">Still need help?</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">Email us and we will respond within 3–5 business days.</p>
            <Button href="mailto:support@artaquest.org?subject=ArtaQuest%20support" size="md" className="mt-4 w-full">Email support</Button>
            <p className="mt-3 text-center text-[13px] text-ink-3">support@artaquest.org</p>
            <div className="mt-5 border-t border-line pt-4 text-[14px]">
              <p className="text-ink-3">Looking for something specific?</p>
              <ul className="mt-2 flex list-none flex-col gap-1.5">
                <li><a href={localePath("/bursaries/")} className="text-yang hover:underline">Bursary program</a></li>
                <li><a href={localePath("/donate/")} className="text-yang hover:underline">Donate</a></li>
                <li><a href={localePath("/about/")} className="text-yang hover:underline">About ArtaQuest</a></li>
              </ul>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
