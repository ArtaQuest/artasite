import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, Pill } from "../components/ui";
import { RailInline, WithRail } from "../components/PageRail";
import { apiDocs, type ApiDocs, type ApiDocsRoute } from "../lib/api";
import { localePath } from "../lib/wp";

/**
 * /developers — the API documentation + token guide. The prose explains the contract;
 * the endpoint reference below is fetched LIVE from GET /api/docs (generated from
 * Rest::ROUTES + Api::TOKEN_ROUTES on the server), so it can never drift from the code.
 *
 * The page is six long anchored sections and the reader arrives looking for one of them, so the
 * jump-list lives in the shared right rail (<WithRail>) where it stays on screen for the whole
 * scroll; <RailInline> puts the same card back in the flow below `lg`, where the rail leaves it.
 * OnThisPage is defined ONCE and rendered in both, so the two copies cannot drift.
 */

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "https://artaquest.com";
const BASE = `${ORIGIN}/wp-json/aq/v1`;

function Kicker({ children }: { children: ReactNode }) {
  return <div className="text-[13px] font-semibold uppercase tracking-[0.22em] text-ink-3">{children}</div>;
}

function H2({ id, children }: { id: string; children: ReactNode }) {
  return <h2 id={id} className="scroll-mt-24 text-[20px] font-bold tracking-tight text-ink">{children}</h2>;
}

/**
 * The six anchored sections, in page order. The ids are exactly the ones already carried by the
 * <H2>s below (which is why those carry `scroll-mt-24`) — nothing here invents an anchor.
 */
const SECTIONS: { id: string; label: string }[] = [
  { id: "auth", label: "Authentication" },
  { id: "quick-start", label: "Quick start" },
  { id: "publishing", label: "The gate — two keys, neither of them an API call" },
  { id: "examples", label: "Examples" },
  { id: "conventions", label: "Conventions & limits" },
  { id: "reference", label: "Endpoint reference (live)" },
];

/** The rail card: a plain fragment jump-list, no scroll-spy, no state. */
function OnThisPage() {
  // No aria-label on the <nav>: WithRail's <aside> already carries "On this page", and nesting the
  // same name makes a screen reader announce the landmark twice. The visible <h2> names the card.
  return (
    <nav className="flex flex-col gap-2 rounded-card border border-line bg-space-2 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">On this page</h2>
      <ul className="flex flex-col gap-1.5">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`} className="block text-[14px] leading-snug text-ink-2 hover:text-yin-light hover:underline">
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-card border border-line bg-space-2 p-4 text-[13px] leading-relaxed text-ink-2">
      <code>{code}</code>
    </pre>
  );
}

const CURL_EXAMPLE = `# 1 — sanity-check your credential
curl -H "Authorization: Bearer aq_YOUR_TOKEN" \\
  ${BASE}/api/ping

# 2 — create a draft from a public Kaggle notebook you have already run
curl -X POST -H "Authorization: Bearer aq_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://www.kaggle.com/code/yourname/tidal-constituents/output"}' \\
  ${BASE}/studio/kernels

# 3 — the reproducibility checklist, read straight off Kaggle's public API (free)
curl -X POST -H "Authorization: Bearer aq_YOUR_TOKEN" \\
  ${BASE}/studio/notebooks/123/check
curl ${BASE}/notebooks/123          # every check, with the evidence it read

# 4 — pick which of the run's output files to publish
curl -X POST -H "Authorization: Bearer aq_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"files":["constituents.csv","harmonics.png"]}' \\
  ${BASE}/studio/notebooks/123/select

# 5 — REQUEST publication (the author gets the confirm email; this call never publishes)
curl -X POST -H "Authorization: Bearer aq_YOUR_TOKEN" \\
  ${BASE}/studio/notebooks/123/publish`;

const PY_EXAMPLE = `import requests

S = requests.Session()
S.headers["Authorization"] = "Bearer aq_YOUR_TOKEN"
API = "${BASE}"

me = S.get(f"{API}/api/ping").json()          # {'ok': True, 'user': …, 'scopes': […]}

# a draft is just the URL of a public Kaggle notebook that has been run
nb = S.post(f"{API}/studio/kernels",
            json={"url": "https://www.kaggle.com/code/yourname/my-computed-essay"}).json()

S.post(f"{API}/studio/notebooks/{nb['id']}/check")  # re-read Kaggle, re-run every check (free)

# read every check and the exact evidence it was read from
work = S.get(f"{API}/notebooks/{nb['id']}").json()
for c in work["checks"]["items"]:
    print(c["group"], c["id"], c["severity"], c["state"], c["detail"], c["evidence"])

# choose which of the run's output files to publish
S.post(f"{API}/studio/notebooks/{nb['id']}/select",
       json={"files": ["essay.md", "figure-1.png"]})

# request publication — this emails the AUTHOR a single-use secret; their click on
# it, signed by their device passkey, is the ONLY thing that publishes + mints the DOI.
S.post(f"{API}/studio/notebooks/{nb['id']}/publish")`;

const JS_EXAMPLE = `const API = "${BASE}";
const headers = { Authorization: "Bearer aq_YOUR_TOKEN", "Content-Type": "application/json" };

const nb = await (await fetch(\`\${API}/studio/kernels\`, {
  method: "POST", headers,
  body: JSON.stringify({ url: "https://www.kaggle.com/code/yourname/seeded-orbital-pinball" }),
})).json();

// run the checklist, then read it back with its evidence
await fetch(\`\${API}/studio/notebooks/\${nb.id}/check\`, { method: "POST", headers });
const work = await (await fetch(\`\${API}/notebooks/\${nb.id}\`)).json();
console.log(work.checks.items);`;

const AGENT_NOTE = `You hold an ArtaQuest personal access token for your principal (the member).
Contract: ${BASE}/api/docs   OpenAPI: ${BASE}/api/openapi
A work here is a public Kaggle notebook that has been run. You can create drafts
from a notebook URL, run the reproducibility checklist, pick which output files
to publish, and post, comment and heart on their behalf. You can REQUEST
publication (POST /studio/notebooks/{id}/publish) — but publication itself needs
the member to open a single-use secret emailed to THEIR address and to sign it
with their device passkey; nothing else publishes. Never claim a work is
published until GET /notebooks/{id} shows status "published".`;

function MethodPill({ m }: { m: string }) {
  return (
    <span className={`inline-block w-14 rounded-pill px-1.5 py-0.5 text-center text-[11px] font-bold ${m === "GET" ? "bg-yin-light/10 text-yin-light" : "bg-yang/10 text-yang"}`}>
      {m}
    </span>
  );
}

function RouteRow({ r }: { r: ApiDocsRoute }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/60 py-2 last:border-b-0">
      <MethodPill m={r.method} />
      <code className="text-[13px] text-ink">{r.path}</code>
      <span className="ml-auto flex items-center gap-2">
        {r.auth === "public" && <Pill className="text-[11px]">public</Pill>}
        {r.auth === "user" && r.token_scope && <Pill className="text-[11px]">token · {r.token_scope}</Pill>}
        {r.auth === "user" && !r.token_scope && <Pill className="text-[11px] opacity-70">session only</Pill>}
        {r.auth === "admin" && <Pill className="text-[11px] opacity-70">operator</Pill>}
        {r.auth === "worker" && <Pill className="text-[11px] opacity-70">internal</Pill>}
      </span>
    </div>
  );
}

/** The live endpoint reference, grouped: token-eligible first, then public reads, then session-only. */
function EndpointReference() {
  const [docs, setDocs] = useState<ApiDocs | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { apiDocs().then(setDocs).catch(() => setErr(true)); }, []);
  if (err) {
    return <p className="text-[14px] text-ink-3">The live reference could not load — the same data is at <a className="text-yin-light hover:underline" href={`${BASE}/api/docs`}>{`${BASE}/api/docs`}</a>.</p>;
  }
  if (!docs) return <p className="text-[14px] text-ink-3">Loading the live endpoint table…</p>;
  const tokenable = docs.endpoints.filter((r) => r.token_scope);
  const publics = docs.endpoints.filter((r) => r.auth === "public");
  const sessionOnly = docs.endpoints.filter((r) => r.auth === "user" && !r.token_scope);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="mb-2 text-[15px] font-bold text-ink">Token-eligible endpoints ({tokenable.length})</h3>
        <p className="mb-2 text-[13.5px] text-ink-3">The complete allow-list. A route not shown here never accepts a token, whatever its scopes.</p>
        <Card className="p-4">{tokenable.map((r, i) => <RouteRow key={i} r={r} />)}</Card>
      </div>
      <div>
        <h3 className="mb-2 text-[15px] font-bold text-ink">Public endpoints ({publics.length})</h3>
        <p className="mb-2 text-[13.5px] text-ink-3">No auth needed; sending your token personalises them (your own drafts resolve, responses become private).</p>
        <Card className="max-h-96 overflow-y-auto p-4">{publics.map((r, i) => <RouteRow key={i} r={r} />)}</Card>
      </div>
      <div>
        <h3 className="mb-2 text-[15px] font-bold text-ink">Session-only endpoints ({sessionOnly.length})</h3>
        <p className="mb-2 text-[13.5px] text-ink-3">Signed-in browsers only — account security, payments, identity, chat keys, token management and operator surfaces are deliberately out of any token's reach.</p>
        <Card className="max-h-96 overflow-y-auto p-4">{sessionOnly.map((r, i) => <RouteRow key={i} r={r} />)}</Card>
      </div>
    </div>
  );
}

export default function Developers() {
  return (
    <WithRail label="On this page" rail={<OnThisPage />}>
      <div className="mx-auto flex max-w-3xl flex-col gap-12 pb-16">
        <header className="flex flex-col gap-3 pt-2">
          <Kicker>Developers</Kicker>
          <h1 className="text-[clamp(1.8rem,4vw,2.6rem)] font-extrabold leading-tight text-ink">
            Build on ArtaQuest — or hand your AI agent the keys
          </h1>
          <p className="max-w-2xl text-[16px] leading-relaxed text-ink-2">
            Everything on the platform runs through one open REST API. With a personal access token you — or
            an app or AI agent acting for you — can turn a public Kaggle notebook you have already run into a
            draft, read its reproducibility checklist, pick which output files to publish, post, comment and
            enter challenges. Submitting and checking are free. Publication alone stays human: it takes a
            single-use secret emailed to your own registered address plus a signature from your device passkey,
            and nothing else can stand in for either.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button href={localePath("/user-account/")} size="sm">Create a token</Button>
            <Button href={`${BASE}/api/docs`} variant="outline" size="sm">Machine contract (JSON)</Button>
            <Button href={`${BASE}/api/openapi`} variant="outline" size="sm">OpenAPI 3.1</Button>
          </div>
        </header>

        {/* Below lg the rail is out of the flow, so the same card rides here — the jump-list at the
            top of the page, where a phone reader can still pick a section. */}
        <RailInline><OnThisPage /></RailInline>

        <section className="flex flex-col gap-3">
          <H2 id="auth">Authentication</H2>
          <p className="text-[15px] leading-relaxed text-ink-2">
            Create a token under <a className="text-yin-light hover:underline" href={localePath("/user-account/")}>Account → API tokens</a>.
            It is shown once — the server keeps only a hash — and you can revoke it any time. Send it on every request as
            a bearer header (or <code>X-AQ-Token</code>, if a proxy strips <code>Authorization</code>):
          </p>
          <CodeBlock code={`Authorization: Bearer aq_…\n\n# equivalent\nX-AQ-Token: aq_…`} />
          <p className="text-[15px] leading-relaxed text-ink-2">
            A token signs requests in as you, within its scopes: <b>read</b> (your studio, wallet, feed,
            notifications), <b>write</b> (create drafts, run the checklist, pick output files, request
            publication, post, comment, heart, follow)
            and <b>economy</b> (challenges, coin buy/sell, payouts, bursary applications — this one moves real value,
            so it is a separate opt-in). Tokens can never touch account security, payments, chat keys, identity documents or token
            management, and a token owned by an operator still carries no operator powers.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <H2 id="quick-start">Quick start</H2>
          <CodeBlock code={CURL_EXAMPLE} />
        </section>

        <section className="flex flex-col gap-3">
          <H2 id="publishing">The gate — two keys, neither of them an API call</H2>
          <p className="text-[15px] leading-relaxed text-ink-2">
            Every submission is a public Kaggle notebook that has been run. The API can create the draft,
            run the reproducibility checklist and choose the output files — all free, all programmatic. Then
            the machine's authority ends:
          </p>
          <Card className="p-5">
            <ol className="flex list-decimal flex-col gap-3 pl-5 text-[15px] leading-relaxed text-ink-2">
              <li>
                <b className="text-ink">The checklist.</b> About twenty deterministic checks in four groups —
                can anyone open it, can anyone re-run it, did that run produce these files, how repeatable is
                the result. Each one names the exact evidence it read from Kaggle's public API, which answers
                with no credential at all, so a stranger can re-run the whole thing and contradict us. Blocking
                checks must all pass; warnings are shown loudly and never block. Nothing is scored or ranked.
              </li>
              <li>
                <b className="text-ink">You request.</b> <code>POST /studio/notebooks/{"{id}"}/publish</code> — by
                session or token — moves a passing draft to <i>pending</i>. Nothing is public yet.
              </li>
              <li>
                <b className="text-ink">You confirm from your inbox — and that publishes.</b> A single-use secret
                goes to the account's own registered address. The page it opens shows the files you picked and
                the checklist as a stranger would read it; your click there, signed by your device passkey, is
                the sole path that publishes the work, lists its files in the Library and mints its permanent
                DOI (declining keeps it a private draft). The server keeps only a hash of the secret and never
                holds the passkey's private key, so no code running anywhere can forge either half.
              </li>
            </ol>
          </Card>
          <p className="text-[15px] leading-relaxed text-ink-2">
            The confirmation binds to the exact notebook version and file selection you were shown — change
            either and it voids — and it lands in the public ledger. An integrity sweep continuously demotes
            anything marked published that lacks both proofs, so even a direct database write cannot stick.
            Enforced by construction: a token can author, check and ask; only the author can publish. The
            Kaggle kernel is the provenance — anyone can hit Copy & Edit, then Run All, from the same public
            inputs. The DOI at <code>/d/n{"{id}"}</code> is the citation of record, because a kernel stays
            editable and deletable by its owner and a DOI does not.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <H2 id="examples">Examples</H2>
          <h3 className="text-[15px] font-bold text-ink">Python</h3>
          <CodeBlock code={PY_EXAMPLE} />
          <h3 className="text-[15px] font-bold text-ink">JavaScript</h3>
          <CodeBlock code={JS_EXAMPLE} />
          <h3 className="text-[15px] font-bold text-ink">Briefing an AI agent</h3>
          <p className="text-[14px] leading-relaxed text-ink-2">
            Give your agent the token plus this note (also see <a className="text-yin-light hover:underline" href="/llms.txt">/llms.txt</a>):
          </p>
          <CodeBlock code={AGENT_NOTE} />
        </section>

        <section className="flex flex-col gap-3">
          <H2 id="conventions">Conventions & limits</H2>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-[15px] leading-relaxed text-ink-2">
            <li>Errors are <code>{`{ "error": code, "message": text }`}</code> with an honest HTTP status.</li>
            <li>Lists return <code>{`{ items, next }`}</code> keyset cursors — pass <code>next</code> back as <code>?cursor=</code>; there are no page numbers.</li>
            <li>1,000 requests per hour per token, plus per-action limits (20 kernel imports per hour, 40 checklist re-runs per 10 minutes). A 429 means pause and retry.</li>
            <li>A draft is a Kaggle notebook URL: the <code>/code/{"{owner}"}/{"{slug}"}</code> form and its <code>/output</code> page both resolve. The notebook must be public and finished, and so must every dataset, model and notebook it takes as an input.</li>
            <li>We never execute anything. Kaggle ran it; we read its public record and report what it says — including whether the run had the internet switched off, which is Kaggle's flag, not our promise.</li>
            <li>Reproducible here means anyone can copy the notebook on Kaggle and run it from public inputs and get this. It is weaker than a claim about identical bytes and stronger than trusting a laptop, and we state it that way everywhere.</li>
            <li>The whole database is public by design (see <a className="text-yin-light hover:underline" href={localePath("/data/")}>Open data</a>) — write nothing into a work you would not publish.</li>
          </ul>
        </section>

        <section className="flex flex-col gap-3">
          <H2 id="reference">Endpoint reference (live)</H2>
          <EndpointReference />
        </section>
      </div>
    </WithRail>
  );
}
