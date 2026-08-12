/**
 * The three tiers of running a work (operator, 2026-07-29): *"3 tiers of dev mode, locally first,
 * then heavy in Colab, final deploy in Kaggle"*.
 *
 * They are a LADDER, not three equivalent buttons, and the order is the point: each tier costs more
 * and proves more than the one before it, so the card says what each is FOR rather than only where
 * it goes. The last rung is the only one the platform reads — a run anywhere else convinces nobody,
 * because nobody else can check it.
 *
 *   1. **Here, in this tab.** Pyodide in a worker (`/lab`, `lib/pykernel.ts`) — free, instant, no
 *      account, nothing leaves the device. Pure-Python and anything with a wheel. This is where the
 *      writing and the light checks happen.
 *   2. **Colab.** GPU and heavy installs, when tier 1 cannot hold the work.
 *   3. **Kaggle.** The final run. It is the submission itself: the reproducibility checklist reads
 *      Kaggle's public API, so this is the only tier that produces evidence a stranger can re-check.
 *
 * **Why the Colab rung downloads instead of deep-linking.** Colab opens notebooks from Drive,
 * GitHub, a gist, or an upload — there is no "open this URL" deep link. This project's legacy
 * `colab_url` values are all `colab.research.google.com/gist/…`, which is exactly why: the gist WAS
 * the workaround, and that pipeline was purged. So this rung does the honest thing it can do with
 * no new credential and no external account: it downloads the exact `.ipynb` and opens Colab, and
 * the copy says so. A one-click Colab link would need the gist pipeline back — an operator call,
 * not something to reinstate quietly.
 */
import { ipynbHref, kaggleRunHref, labRunUrl } from "../lib/pykernel";
import { cx } from "./ui";

/**
 * Download the notebook, then open Colab. Two user-visible things happen, so both are triggered
 * from the same gesture — a popup blocker only ever stops the second, and the file is already
 * saved by then.
 */
function openInColab(id: number, slug: string) {
  const a = document.createElement("a");
  a.href = ipynbHref(id, slug);
  a.download = `${slug || "notebook"}.ipynb`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.open("https://colab.research.google.com/#create=true", "_blank", "noopener,noreferrer");
}

type Props = { id: number; slug: string; kaggleUrl?: string; colabUrl?: string; className?: string };

export function RunTiers({ id, slug, kaggleUrl, colabUrl, className }: Props) {
  const kaggle = kaggleRunHref(kaggleUrl || "");
  // A real one-click Colab link exists once the submission has been mirrored to its gist
  // (Gist::sync_row, server side). Without a gist — no GITHUB_GIST_TOKEN in the Vault, or a
  // submission that predates the mirror — the rung falls back to download-and-open, which is the
  // only honest alternative: Colab has no open-by-URL form.
  const colab = (colabUrl || "").startsWith("https://colab.research.google.com/") ? colabUrl! : "";

  const rung = "flex flex-wrap items-baseline gap-x-2 gap-y-1";
  const num = "grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-[11px] font-bold text-ink-3";
  // inline-block + py-1: these were 20px-tall text runs, and running the work is the whole point
  // of the page — the primary action should not be the hardest thing on it to tap.
  const act = "inline-block py-1 text-[13px] font-semibold text-yin-ink underline-offset-2 hover:underline";

  return (
    <aside className={cx("flex flex-col gap-3 rounded-card border border-line bg-space-2 p-4", className)}>
      <div>
        <h2 className="text-sm font-bold uppercase tracking-wider text-ink-3">Run it yourself</h2>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-3">
          Three tiers, cheapest first. Each one proves more than the last.
        </p>
      </div>

      <ol className="flex flex-col gap-3">
        <li className="flex gap-2.5">
          <span aria-hidden className={num}>1</span>
          <div className="min-w-0">
            <p className={rung}>
              <a className={act} href={labRunUrl(id, slug)}>Run here, in this tab</a>
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">
              Free, instant, no account, and nothing leaves your device. Good for reading the code
              and light changes; it cannot do a GPU.
            </p>
          </div>
        </li>

        <li className="flex gap-2.5">
          <span aria-hidden className={num}>2</span>
          <div className="min-w-0">
            <p className={rung}>
              {colab !== "" ? (
                <a className={act} href={colab} target="_blank" rel="noopener noreferrer">Open it in Colab</a>
              ) : (
                <button type="button" className={act} onClick={() => openInColab(id, slug)}>
                  Take it to Colab
                </button>
              )}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">
              {colab !== ""
                ? "For the heavy work — a GPU, large installs. Opens straight in Colab from the copy of the notebook we keep on GitHub."
                : "For the heavy work — a GPU, large installs. This saves the notebook and opens Colab; drop the file in there (Colab opens notebooks from Drive, GitHub or an upload, so there is no one-click link we can honestly give you)."}
            </p>
          </div>
        </li>

        <li className="flex gap-2.5">
          <span aria-hidden className={num}>3</span>
          <div className="min-w-0">
            <p className={rung}>
              {kaggle !== "" ? (
                <a className={act} href={kaggle} target="_blank" rel="noopener noreferrer">
                  Run it on Kaggle
                </a>
              ) : (
                <span className="text-[13px] font-semibold text-ink-2">Run it on Kaggle</span>
              )}
            </p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">
              The one that counts. Copy &amp; Edit, then Run All, from the same public inputs — this
              is the tier the reproducibility checklist reads, so it is the only run a stranger can
              check for themselves.
            </p>
          </div>
        </li>
      </ol>

      <p className="border-t border-line pt-3 text-[12.5px] text-ink-3">
        Or take the file:{" "}
        <a className="font-semibold text-yin-ink hover:underline" href={ipynbHref(id, slug)} download={`${slug || "notebook"}.ipynb`}>
          download the .ipynb
        </a>
        {" "}and run it wherever you like.
      </p>
    </aside>
  );
}
