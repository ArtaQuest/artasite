%% artaquest.cls — the official document class for Journal of Seasonality.
%% A clean, single-column (two-column optional) article class in the journal's two-colour
%% brand (gold #E8B923 · the why, blue #2352E8 · the how). Times-like text + matching maths,
%% generous margins, a running header, numbered clickable references, cleveref cross-refs and
%% a structured title block + end-matter. Drop it next to your main.tex (Overleaf: "Upload
%% Project" the whole zip). Standard CTAN packages only; compiles with tectonic or pdflatex.
%%
%%   Class options:
%%     [review]     line numbers + double spacing (handy while drafting / for review)
%%     [twocolumn]  two-column body (single column is the default)
%%     any article option (a4paper, letterpaper, 10pt, 11pt, 12pt …)
\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{artaquest}[2026/06/27 v2.0 Journal of Seasonality article class]

\newif\ifaq@review\aq@reviewfalse
\DeclareOption{review}{\aq@reviewtrue}
% Pass any unknown option straight to article (e.g. a4paper, 12pt, twocolumn).
\DeclareOption*{\PassOptionsToClass{\CurrentOption}{article}}
\ProcessOptions\relax
\LoadClass[11pt]{article}

% ── Page geometry — generous, readable margins. ──────────────────────────────────
\RequirePackage[a4paper,margin=1in,headsep=16pt,footskip=28pt]{geometry}

% ── Fonts: Times-like text + matching maths (academic standard), graceful fallback. ─
\RequirePackage[T1]{fontenc}
\RequirePackage{textcomp}
% Maths symbols must load BEFORE newtxmath (else \Bbbk and friends clash). amsmath first.
\RequirePackage{amsmath}
\RequirePackage{amssymb}
\IfFileExists{newtxtext.sty}{%
  \RequirePackage{newtxtext}%
  \IfFileExists{newtxmath.sty}{\RequirePackage[varvw]{newtxmath}}{}%
}{%
  \RequirePackage{lmodern}% fallback when newtx is unavailable
}
\RequirePackage{microtype}

% ── Core typesetting packages. ───────────────────────────────────────────────────
\RequirePackage{graphicx}
\RequirePackage{xcolor}
\RequirePackage{titlesec}
\RequirePackage{titling}        % gives us \thetitle/\theauthor for the running header
\RequirePackage{enumitem}
\RequirePackage{booktabs}
\RequirePackage{array}
\RequirePackage{subcaption}
\RequirePackage[font=small,labelfont={bf,color=aqblue},labelsep=period,
                margin=1em,justification=justified,skip=6pt]{caption}
\RequirePackage{siunitx}
\sisetup{detect-all,group-separator={,},group-minimum-digits=4}
\RequirePackage{listings}
\RequirePackage{fancyhdr}
\RequirePackage[numbers,sort&compress,square,comma]{natbib}
\bibliographystyle{plainnat}    % numbered references; overridable in main.tex
\RequirePackage[colorlinks=true,unicode]{hyperref}
\RequirePackage[nameinlink,capitalise]{cleveref} % MUST be after hyperref + amsmath

% A \doi{…} helper for the bibliography (clickable DOI links in references.bib).
\providecommand{\doi}[1]{\href{https://doi.org/#1}{doi:#1}}

% ── Brand: gold (the why) + blue (the how). The only two accents. ────────────────
\definecolor{aqgold}{HTML}{E8B923}
\definecolor{aqblue}{HTML}{2352E8}
\definecolor{aqink}{HTML}{16181D}
\definecolor{aqgrey}{HTML}{5B6066}
\hypersetup{
  linkcolor=aqblue, citecolor=aqblue, urlcolor=aqblue, breaklinks=true,
  pdfborderstyle={/S/U/W 0},
  pdftitle={\@title}, pdfsubject={Journal of Seasonality}, pdfcreator={artaquest.cls}}

% ── Comfortable reading measure. ─────────────────────────────────────────────────
\linespread{1.05}
\setlength{\parskip}{0.2\baselineskip}
\setlength{\parindent}{0pt}
\setlist{leftmargin=1.4em,itemsep=0.2em,topsep=0.3em}
\frenchspacing

% ── Float defaults — keep floats near their reference, no orphaned pages. ─────────
\renewcommand{\topfraction}{0.9}
\renewcommand{\bottomfraction}{0.8}
\renewcommand{\textfraction}{0.07}
\renewcommand{\floatpagefraction}{0.7}
\setlength{\textfloatsep}{16pt plus 2pt minus 2pt}
\setlength{\abovecaptionskip}{6pt}

% ── Code listings — brand-styled (a gold left rule), for reproducible snippets. ───
\lstdefinestyle{aq}{
  basicstyle=\ttfamily\footnotesize, keywordstyle=\color{aqblue}\bfseries,
  commentstyle=\color{aqgrey}\itshape, stringstyle=\color{aqgold!75!black},
  numbers=left, numberstyle=\tiny\color{aqgrey}, numbersep=8pt,
  frame=leftline, framerule=2pt, rulecolor=\color{aqgold}, xleftmargin=1.2em,
  breaklines=true, showstringspaces=false, columns=fullflexible, keepspaces=true,
  backgroundcolor=\color{aqblue!3}, aboveskip=0.8em, belowskip=0.4em}
\lstset{style=aq}

% ── Section headings — numbered, brand blue; tight, confident spacing. ───────────
\titleformat{\section}{\normalfont\large\bfseries\color{aqblue}}{\thesection}{0.6em}{}
\titleformat{\subsection}{\normalfont\normalsize\bfseries\color{aqblue}}{\thesubsection}{0.5em}{}
\titleformat{\subsubsection}{\normalfont\normalsize\itshape\color{aqink}}{\thesubsubsection}{0.5em}{}
\titleformat{\paragraph}[runin]{\normalfont\bfseries\color{aqink}}{}{0pt}{}[.\;]
\titlespacing*{\section}{0pt}{1.6ex plus .2ex}{0.7ex}
\titlespacing*{\subsection}{0pt}{1.2ex plus .2ex}{0.5ex}
\titlespacing*{\subsubsection}{0pt}{1.0ex plus .2ex}{0.4ex}

% ── Running header (journal · short title · page) + a licence footer on page 1. ──
% Optional short running title for the header; defaults to the full \title.
\newcommand{\aq@runtitle}{}
\newcommand{\runningtitle}[1]{\renewcommand{\aq@runtitle}{#1}}
\newcommand{\aq@headtitle}{\ifx\aq@runtitle\empty\thetitle\else\aq@runtitle\fi}

\pagestyle{fancy}\fancyhf{}
\renewcommand{\headrulewidth}{0.4pt}\renewcommand{\footrulewidth}{0pt}
\fancyhead[L]{\footnotesize\color{aqgrey}Journal of Seasonality}
\fancyhead[C]{\footnotesize\itshape\color{aqgrey}\aq@headtitle}
\fancyhead[R]{\footnotesize\color{aqgrey}\thepage}
\fancypagestyle{plain}{\fancyhf{}\renewcommand{\headrulewidth}{0pt}%
  \fancyfoot[L]{\footnotesize\color{aqgrey}Journal of Seasonality \textbullet\ open access \textbullet\ CC\,BY\,4.0}%
  \fancyfoot[R]{\footnotesize\color{aqgrey}\thepage}}

% ── Title-block metadata. ────────────────────────────────────────────────────────
\newcommand{\aq@affiliation}{}
\newcommand{\affiliation}[1]{\renewcommand{\aq@affiliation}{#1}}
\newcommand{\aq@keywords}{}
\newcommand{\keywords}[1]{\renewcommand{\aq@keywords}{#1}}

% Author/affiliation superscript marker → a small raised number, used both after an
% author name and at the head of each affiliation line. Render the digits at a fixed
% small size and raise them (don't rely on \textsuperscript alone: with newtx, wrapping
% the argument in \normalfont disables the font's superior figures and the marker drops
% to the baseline — the bug this macro exists to avoid):
%   \author{Alice\affmark{1}\orcid{0000-…} \and Bob\affmark{2}}
%   \affiliation{\affmark{1}Institute A \quad \affmark{2}Institute B}
\newcommand{\affmark}[1]{\raisebox{0.55ex}{\scriptsize#1}}
% ORCID helper: \orcid{0000-0000-0000-0000} → a small gold "iD" link (no extra package).
\newcommand{\orcid}[1]{\,\href{https://orcid.org/#1}{\textcolor{aqgold}{\raisebox{0.55ex}{\textsc{\tiny iD}}}}}

% Render the title block. Call \maketitle after \title/\author/\affiliation, in document.
% The block ends with ONE thin gold rule; the abstract follows directly (no second rule,
% no empty gap). Author line slightly larger; affiliation small italic grey; date small.
\renewcommand{\maketitle}{%
  \thispagestyle{plain}%
  \begingroup\renewcommand{\and}{\unskip\quad}% authors may use \and; space them along the line
  {\footnotesize\color{aqblue}\textsc{Journal of Seasonality}\hfill
    \footnotesize\color{aqgrey}Open access \textbullet\ CC\,BY\,4.0\par}
  \vspace{0.35em}{\color{aqgold}\rule{\linewidth}{2pt}}\par\vspace{0.85em}
  {\raggedright\bfseries\fontsize{20}{24}\selectfont\color{aqink}\@title\par}
  \vspace{0.7em}
  {\raggedright\large\color{aqink}\@author\par}
  \ifx\aq@affiliation\empty\else
    \vspace{0.3em}{\raggedright\footnotesize\itshape\color{aqgrey}\aq@affiliation\par}\fi
  \vspace{0.5em}
  {\raggedright\footnotesize\color{aqgrey}\@date\par}
  \endgroup
  \vspace{0.7em}{\color{aqgold}\rule{\linewidth}{0.4pt}}\par
  \vspace{0.6em}
}

% ── Abstract: an italic lead block; keywords styled beneath it; one closing gold rule. ─
% (The opening rule is the single one drawn by \maketitle, so the masthead → abstract is
% one clean rule, not two with a gap.)
\renewenvironment{abstract}{%
  \noindent{\sffamily\bfseries\color{aqblue}Abstract.\ }\itshape\ignorespaces
}{%
  \upshape
  \ifx\aq@keywords\empty\else\par\vspace{0.55em}%
    \noindent{\small\color{aqgrey}\textbf{\color{aqblue}Keywords} \textemdash\ \aq@keywords}\fi
  \par\vspace{0.5em}{\color{aqgold}\rule{\linewidth}{0.4pt}}\par\vspace{0.6em}
}

% ── Structured end-matter. ───────────────────────────────────────────────────────
% Data/Code availability are collected and printed by \declarations; the rest are
% inline declaration macros you call after it.
\newcommand{\aq@data}{}
\newcommand{\dataavailability}[1]{\renewcommand{\aq@data}{#1}}
\newcommand{\aq@code}{}
\newcommand{\codeavailability}[1]{\renewcommand{\aq@code}{#1}}

\newcommand{\aq@decl}[2]{\par\noindent{\sffamily\bfseries\color{aqink}#1.}\ #2\par\vspace{0.3em}}
\newcommand{\declarations}{%
  \section*{Declarations}%
  \ifx\aq@data\empty\else\aq@decl{Data availability}{\aq@data}\fi
  \ifx\aq@code\empty\else\aq@decl{Code availability}{\aq@code}\fi
}
\newcommand{\authorcontributions}[1]{\aq@decl{Author contributions}{#1}}
\newcommand{\competinginterests}[1]{\aq@decl{Competing interests}{#1}}
\newcommand{\funding}[1]{\aq@decl{Funding}{#1}}
\newcommand{\acknowledgements}[1]{\aq@decl{Acknowledgements}{#1}}
\newcommand{\acknowledgments}[1]{\acknowledgements{#1}}% US-spelling alias

% Tidy the bibliography heading + spacing.
\renewcommand{\bibsection}{\section*{\refname}}
\setlength{\bibsep}{0.4ex plus 0.2ex}

% ── [review] option → double spacing + line numbers for reviewer/author reference. ─
\ifaq@review
  \RequirePackage{setspace}\AtBeginDocument{\doublespacing}
  \RequirePackage[mathlines]{lineno}\AtBeginDocument{\linenumbers}
\fi

\endinput
