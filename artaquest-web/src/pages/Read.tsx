import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { localePath } from "../lib/wp";
import {
  getBook, generateBook, publishBook, deleteBook, addBookSource, removeBookSource,
  listIllustrations, type IllustrationCard,
  type Book, ApiError,
} from "../lib/api";
import { Button, Card, Field, StatusNote, Pill, BackLink, LinkButton } from "../components/ui";
import { ReadMode, ReadingToc, containWideTables, type ReaderDoc, type TocItem } from "../components/reader";
import { SharePanel } from "../components/SharePanel";
import ReviewRecord from "../components/ReviewRecord";
import { WorkHeart } from "../components/studio";
import { watchMath } from "../lib/math";

/** Absolute, locale-correct URL for a page path — used for share links + OG unfurl. */
function shareUrl(path: string): string {
  const p = localePath(path);
  return typeof window !== "undefined" ? window.location.origin + p : "https://artaquest.com" + p;
}

function fmtWhen(ts: number): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Adapt a Book to the generic reader content shape (so the SAME ReadMode the Journal uses drives it). */
function toReaderDoc(book: Book): ReaderDoc {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    created: book.created,
    abstract: book.summary || "",
    eyebrow: "ArtaQuest Library · Book",
    license: book.author ? `© ${book.author.name}` : "",
    narrate: { type: "book", id: book.id }, // ArtaVoice read-along narrations
  };
}

/** The book, read with the SAME reader as the Journal: an inline reading column (shared .aq-article-body
 *  styling, KaTeX-typeset, wide-table containment, the progress-spine ReadingToc) plus the shared
 *  distraction-free ReadMode overlay — identical to ArticleReader's "Read mode". */
function BookBody({ book }: { book: Book }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const readBtnRef = useRef<HTMLButtonElement | null>(null);
  const [reading, setReading] = useState(false);
  const body = book.body_html || "";

  // Build the contents from the book's own headings — the same TocItem shape the Journal feeds ReadingToc.
  const toc = useMemo<TocItem[]>(() => {
    const out: TocItem[] = [];
    const re = /<(h2|h3)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const label = m[3].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ");
      if (label) out.push({ id: m[2], label, level: m[1].toLowerCase() === "h3" ? 3 : 2 });
    }
    return out;
  }, [body]);

  // Typeset math + contain wide tables in the inline body, exactly like the Journal inline reader.
  useEffect(() => {
    containWideTables(bodyRef.current);
    return watchMath(bodyRef.current, "auto");
  }, [book.id, body]);

  // In-body anchor links (chapter cross-refs) scroll smoothly, matching the reader behaviour.
  const onBodyClick = (e: ReactMouseEvent) => {
    const a = (e.target as HTMLElement).closest?.("a") as HTMLAnchorElement | null;
    const href = a?.getAttribute("href") || "";
    if (href.startsWith("#")) {
      e.preventDefault();
      document.getElementById(href.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const prose = "[&_h2]:font-bold [&_h2]:tracking-tight [&_h2]:text-ink [&_h2]:scroll-mt-20 [&_h3]:font-bold [&_h3]:text-ink [&_h3]:scroll-mt-20 [&_a]:text-yin-ink [&_a]:font-medium hover:[&_a]:underline [&_blockquote]:my-6";

  return (
    <div className="aq-read-layout">
      {toc.length > 1 && <ReadingToc className="aq-read-toc sticky top-6 max-h-[calc(100vh-3rem)]" items={toc} />}
      <article className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <header className="flex flex-col gap-2 border-b border-line pb-5">
          <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-3">ArtaQuest Library · Book</p>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-[30px] font-bold leading-tight tracking-tight text-ink">{book.title}</h1>
            {book.status === "published" && <WorkHeart kind="book" id={Number(book.id)} authorSlug={book.author?.slug} />}
          </div>
          {book.author && (
            <p className="text-[14px] text-ink-3">
              by <Link to={localePath(`/u/${book.author.slug}/`)} className="font-medium text-ink hover:text-yin-ink">{book.author.name}</Link>
              {book.status === "published" ? <> · {fmtWhen(book.created)}</> : <> · draft preview</>}
              <> · {book.pages} pages</>
            </p>
          )}
          {book.summary && <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{book.summary}</p>}
          {body && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                ref={readBtnRef}
                type="button"
                onClick={() => setReading(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-[13px] font-semibold text-ink transition hover:border-yin/50"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M2 6h20M2 6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4a2 2 0 0 1-2-2zM12 6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v10a2 2 0 0 0-2 2h-6a2 2 0 0 0-2 2" /></svg>
                Read mode
              </button>
              {book.status === "published" && (
                <SharePanel title={book.title} url={shareUrl(`/read/${book.id}/`)}
                  message={`“${book.title}”${book.author ? ` by ${book.author.name}` : ""} — a book on ArtaQuest`} image={book.thumb} />
              )}
            </div>
          )}
        </header>
        {body
          ? <div ref={bodyRef} className={`aq-article-body ${prose}`} onClick={onBodyClick} dangerouslySetInnerHTML={{ __html: body }} />
          : <p className="text-ink-3">This book has no readable text yet.</p>}
      </article>
      {reading && (
        <ReadMode
          s={toReaderDoc(book)}
          body={body}
          onClose={() => setReading(false)}
          returnFocus={() => readBtnRef.current?.focus()}
        />
      )}
    </div>
  );
}

/** Owner-only studio: brief, private inspiration sources, and the write → review → publish flow. */
function OwnerStudio({ book, reload }: { book: Book; reload: () => void }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cost = book.cost ?? Math.max(1, book.pages);

  const act = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setErr(""); setBusy(label);
    try { await fn(); reload(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : "Something went wrong"); }
    finally { setBusy(""); }
  }, [reload]);

  const writing = book.book_state === "queued" || book.book_state === "processing";

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[18px] font-bold tracking-tight">Your book studio</h2>
        <Pill>{book.status === "published" ? "Published" : book.book_state === "review" ? "Ready to review" : writing ? "Writing…" : book.book_state === "failed" ? "Write failed" : "Draft"}</Pill>
      </div>

      {book.brief && (
        <Field label="Your brief"><p className="whitespace-pre-wrap rounded-md bg-space-2/60 p-3 text-[13px] text-ink-2">{book.brief}</p></Field>
      )}

      <Field label="Inspiration (private — never published)" optional>
        {book.sources && book.sources.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {book.sources.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 rounded-md bg-space-2/60 px-3 py-1.5 text-[13px]">
                <span className="truncate text-ink-2">{s.title} <span className="text-ink-3">· {s.pages}p</span></span>
                {book.status !== "published" && (
                  <LinkButton onClick={() => act("rm" + s.id, () => removeBookSource(book.id, s.id))} disabled={!!busy}>Remove</LinkButton>
                )}
              </li>
            ))}
          </ul>
        ) : <p className="text-[12.5px] text-ink-3">No inspiration files attached.</p>}
        {book.status !== "published" && (
          <div className="mt-2">
            <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) act("add", () => addBookSource(book.id, f)); if (fileRef.current) fileRef.current.value = ""; }} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={!!busy}>{busy === "add" ? "Uploading…" : "Add inspiration PDF"}</Button>
          </div>
        )}
      </Field>

      {err && <StatusNote error>{err}</StatusNote>}

      {/* The write → review → publish flow */}
      {writing && (
        <StatusNote>The editor is writing your book — long books are written part by part, so a short one takes minutes and a very long one can take hours. This page refreshes automatically; you can close it and come back.</StatusNote>
      )}
      {book.book_state === "failed" && (
        <Button onClick={() => act("gen", () => generateBook(book.id))} disabled={!!busy}>{busy === "gen" ? "Retrying…" : "Try writing again"}</Button>
      )}
      {!writing && book.book_state !== "review" && book.status !== "published" && book.book_state !== "failed" && (
        <Button onClick={() => act("gen", () => generateBook(book.id))} disabled={!!busy}>{busy === "gen" ? "Starting…" : "Write the book"}</Button>
      )}
      {book.book_state === "review" && book.status !== "published" && (
        <div className="flex flex-col gap-2 rounded-md border border-yin/30 bg-yin/[0.04] p-4">
          <p className="text-[14px] font-semibold text-ink">Your draft is ready below</p>
          <p className="text-[12.5px] text-ink-3">Publishing makes it public on the Library and your profile, and costs <strong>₳{cost}</strong> ({book.pages} pages × ₳1).</p>
          <div className="flex items-center gap-2">
            <Button onClick={() => act("pub", () => publishBook(book.id))} disabled={!!busy}>{busy === "pub" ? "Publishing…" : `Publish · ₳${cost}`}</Button>
            <Button variant="outline" onClick={() => act("gen", () => generateBook(book.id))} disabled={!!busy}>Rewrite</Button>
          </div>
        </div>
      )}

      <div className="mt-1 border-t border-line pt-3">
        <LinkButton
          onClick={() => { if (window.confirm("Delete this book? This cannot be undone.")) act("del", async () => { await deleteBook(book.id); }); }}
          disabled={!!busy} className="text-rose-400">
          Delete this book
        </LinkButton>
      </div>
    </Card>
  );
}

/** Published ArtaIllustration art made FOR this book — plates (and its cover) in a small gallery. */
function BookArt({ bookId, isOwner }: { bookId: number; isOwner: boolean }) {
  const [items, setItems] = useState<IllustrationCard[] | null>(null);
  useEffect(() => { listIllustrations({ book: bookId }).then((r) => setItems(r.items)).catch(() => setItems([])); }, [bookId]);
  if (!items || (items.length === 0 && !isOwner)) return null;
  return (
    <section aria-label="Illustrations for this book" className="flex flex-col gap-3">
      <h2 className="text-[15px] font-semibold text-ink-2">Illustrations</h2>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-3">No published art yet — <Link className="font-semibold text-yin-light hover:underline" to={localePath("/illustrations/")}>commission a cover or plates</Link> for this book in the art studio.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((i) => (
            <Link key={i.id} to={localePath(`/illustration/${i.id}/`)} className="group flex flex-col overflow-hidden rounded-card border border-line bg-space-1/40 transition-colors hover:border-yin/50">
              <span className="aspect-square w-full overflow-hidden bg-space-2"><img src={i.image} alt={i.summary || i.title} loading="lazy" className="h-full w-full object-cover" /></span>
              <span className="truncate p-2 text-[12.5px] font-medium text-ink-2 group-hover:text-ink">{i.title}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default function Read() {
  const { id } = useParams();
  const bookId = Number(id);
  const nav = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    getBook(bookId)
      .then((b) => { if (b && (b as unknown as { status?: string }).status === "removed") { nav(localePath("/library/")); return; } setBook(b); })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? "Book not found" : "Could not load this book"));
  }, [bookId, nav]);

  useEffect(() => { if (bookId) load(); }, [bookId, load]);

  // Poll while the AI editor is writing, so the page flips to the review state on its own.
  useEffect(() => {
    if (!book || (book.book_state !== "queued" && book.book_state !== "processing")) return;
    const h = setInterval(load, 8000);
    return () => clearInterval(h);
  }, [book, load]);

  if (err) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <BackLink href={localePath("/library/")}>Back to the library</BackLink>
        <StatusNote error className="mt-4">{err}</StatusNote>
      </div>
    );
  }
  if (!book) return <div role="status" aria-live="polite" className="mx-auto w-full max-w-3xl px-4 py-10 text-ink-3">Loading…</div>;

  const showReader = book.status === "published" || (book.is_owner && !!book.body_html);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <BackLink href={localePath("/library/")}>Library</BackLink>
      {book.is_owner && book.status !== "published" && <OwnerStudio book={book} reload={load} />}
      {showReader
        ? <BookBody book={book} />
        : <Card className="p-6 text-center text-ink-3">{book.is_owner ? "Write the book above to see the draft here." : "This book isn't available."}</Card>}
      {book.status === "published" && <BookArt bookId={book.id} isOwner={!!book.is_owner} />}
      {!!book.reviews?.length && <ReviewRecord reviews={book.reviews} kind="book" />}
      {book.is_owner && book.status === "published" && <OwnerStudio book={book} reload={load} />}
    </div>
  );
}
