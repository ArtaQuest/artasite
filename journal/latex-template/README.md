# Journal of Seasonality — LaTeX submission template

Journal of Seasonality is an open journal with a **fully automated, AI-run review process**. Your
submission is reviewed *by running it*: an AI clones your code, fetches your open data, executes it,
and checks that your manuscript's results actually reproduce — across as many rounds as it takes.

This template is a complete, **compiling** journal class (`artaquest.cls`) plus a worked exemplar
(`main.tex`). The exemplar is also your guide-by-example — read it, then replace its content.

It is **maths-first** and **visualisation-first**: the class loads `amsmath`/`amssymb`/`mathtools`/
`amsthm` and `tikz`/`pgfplots` for you (you do *not* `\usepackage` them), ships a documented maths
helper set and brand-styled theorem environments, and defines a reusable colour-blind-safe figure
"house style" (`[aq]`) — see below.

## What you submit

Three public URLs:

1. **Manuscript** — this LaTeX project, zipped (an "Overleaf project" `.zip`).
2. **Code** — a public git repository (ideal) or archive that runs.
3. **Data** — a public, downloadable URL for your open data.

Open data **and** open code are mandatory. Nothing is reviewed on description alone.

## Compile it

```sh
tectonic main.tex          # self-contained: one binary, fetches packages, no TeX install
```

Or, with a TeX Live install: `latexmk -pdf main.tex` (or `pdflatex; bibtex main; pdflatex; pdflatex`).
On **Overleaf**: New Project → *Upload Project* → upload this `.zip` → *Recompile*; then Menu →
*Download Source* gives you the `.zip` you submit. Keep `artaquest.cls` in the project root — it uses
only common CTAN packages (Times via `newtx`, falling back to Latin Modern).

## Write your paper

Edit `main.tex`. The title block, abstract, headings, citations and cross-references all come out in
house style if you use the macros below.

### Title block

```latex
\title{A clear, specific statement of your result}
\runningtitle{Short title for the page header}   % optional; defaults to \title
\author{First Author\affmark{1}\orcid{0000-0000-0000-0000} \and Second\affmark{2}}
\affiliation{\affmark{1}First affiliation \quad \affmark{2}Second affiliation}
\keywords{three to eight; comma-separated; lowercase}
```

`\maketitle` prints the masthead ("Journal of Seasonality · Open access · CC BY 4.0"), a gold-ruled
title, the authors, affiliations and date.

### Abstract & keywords

Wrap your abstract in `\begin{abstract} … \end{abstract}` (a gold-ruled italic lead block). The
`\keywords{…}` you set are printed automatically at the foot of the abstract.

### Structured end-matter macros

Set the two availability statements anywhere before `\declarations` (review checks they are real):

```latex
\dataavailability{The data are openly available at \url{…}.}
\codeavailability{The code is openly available at \url{…}.}
```

Then call, after the body:

```latex
\declarations                 % prints Data availability + Code availability
\authorcontributions{…}       % who did what
\competinginterests{…}        % e.g. "The authors declare no competing interests."
\funding{…}                   % funding sources, or "none"
\acknowledgements{…}          % optional (\acknowledgments alias accepted)
\bibliography{references}
```

### Figures, tables, maths, cross-references

| You write | You get |
|-----------|---------|
| `\includegraphics` inside `figure`; `\caption` below; `subcaption` for sub-figures | a captioned float in house style — ship image files in the zip |
| `booktabs` rules (`\toprule`/`\midrule`/`\bottomrule`); **no vertical lines**; caption above | a clean table; align numbers with a `siunitx` `S` column |
| `equation` with a `\label`; define symbols on first use | a numbered display equation |
| `\cref{eq:…}`, `\cref{fig:…}`, `\cref{tab:…}` (cleveref) | "Equation 1", "Figure 2", "Table 3" — clickable. Label everything you reference |
| `\num{1173}`, `\SI{7}{\day}`, `\SI{63}{\percent}` (siunitx) | consistently formatted numbers and units |
| `\citep{key}` / `\citet{key}` (numeric natbib) | `[3]` / "Harris et al. [3]" — clickable, with DOI links in the reference list |
| `lstlisting` | a brand-styled code block for the one command that reproduces your results |

The exemplar `main.tex` exercises every one of these.

### Mathematics

The class is maths-first. State every model and metric as a typeset equation.

- **Always loaded:** `amsmath`, `amssymb`, `mathtools`, `amsthm`; `\allowdisplaybreaks` is on, so a
  long aligned display breaks across a page instead of overrunning. Displays are right-numbered as
  `(1)`; `cleveref` knows equations, figures, tables, sections **and** the theorem-like environments.
- **Helper macros** (use them — they keep notation consistent and upright where it should be):
  `\abs{x}`, `\norm{v}` (auto-sizing paired delimiters; star `\abs*{…}` for fixed size); `\E`, `\Var`,
  `\Cov`, `\Corr`, `\argmin`, `\argmax`, `\tr`, `\diag`, `\sign`; the upright metrics `\RMSE`, `\MAE`,
  `\MAPE`, `\Rsq`; vectors `\vect{x}` and matrices `\mat{A}` with transpose `\mat{A}\T`; sets `\R`,
  `\N`, `\Z`; the upright differential `\dd`.
- **Theorem-like environments** in brand style (blue run-in head for results, gold for definitions):
  `theorem`, `lemma`, `proposition`, `corollary`, `definition`, `remark`, `assumption`, plus `proof`
  (with a gold ∎). They share one counter and number within the section; reference them with
  `\cref{def:…}`, `\cref{thm:…}`, etc.

### Visualisation — the `aq` figure house style

Draw figures with `pgfplots` and apply `[aq]` to every axis:

```latex
\begin{tikzpicture}
  \begin{axis}[aq, xlabel={…}, ylabel={…}, legend pos=north west]
    \addplot[aq emphasis] {…};        % the exemplar / median / "answer" curve
    \addplot[aq warm, dashed] {…};    % a secondary series, in gold
    \addplot[aq muted] {…};           % a muted, dashed comparison series
    \addplot[aq rule, samples=2] {0}; % a reference line (baseline / threshold)
    \legend{…, …, …}
  \end{axis}
\end{tikzpicture}
```

`[aq]` gives a light grid, tidy legend, sensible default size and a **colour-blind-safe cycle list**
where each series differs by **colour *and* line dash *and* marker** — so a figure stays readable in
greyscale and for colour-vision deficiency. Named colours `aqgold`/`aqblue` (+ `…light` tints and
`aqgreydark`) and the per-plot styles `aq emphasis` / `aq warm` / `aq muted` / `aq rule` / `aq band`
(a translucent confidence band, used with the `fillbetween` library) are all available. The exemplar
draws one full figure in this style; copy it as a starting point.

## Class options

```latex
\documentclass[11pt]{artaquest}              % single column, the default
\documentclass[11pt,review]{artaquest}       % + line numbers + double spacing for drafting
\documentclass[11pt,twocolumn]{artaquest}    % two-column body
```

Any standard `article` option (`a4paper`, `letterpaper`, `12pt`, …) is passed through.

## references.bib

Every entry must be **real and verifiable**, with a DOI where one exists. The class provides `\doi{…}`,
so a `doi = {…}` field in an entry renders as a clickable `doi:…` link in the reference list. Replace
the bundled well-known references with your own.

## How review works

Each round, the reviewer (ArtaScience) compiles your LaTeX, reads the manuscript, then **runs your
code on your open data** and compares the outputs to your claims. It returns: **reproduced** (yes/no —
a paper that does not reproduce cannot be accepted), a **score** (0–100), and a **report** with exactly
what it ran, what reproduced, what did not, and how to fix it. Address the report and resubmit.
Everything is public.

## Files

| File | What |
|------|------|
| `artaquest.cls` | the journal document class (brand-styled; do not edit) |
| `main.tex` | the worked exemplar — replace with your manuscript |
| `references.bib` | your bibliography (every entry must be real) |

## Checklist before you submit

- [ ] `main.tex` compiles cleanly with `artaquest.cls` (`tectonic main.tex`), no errors.
- [ ] Abstract states the headline result and the numbers that should reproduce.
- [ ] Data + Code availability statements point at the exact public URLs you submit.
- [ ] One command/notebook regenerates every figure and number from the open data.
- [ ] Every citation, DOI, and URL is real and verifiable.
- [ ] British spelling; no trailing full stops on headings; every figure and table captioned.

Full style guide: <https://artaquest.org/papers/style-guide.html>
