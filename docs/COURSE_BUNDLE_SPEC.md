# ArtaQuest Course Bundle (.zip) — v1 specification

This is the **contract** between two systems:

1. The **generator** — an external script (typically run by an instructor)
   that takes a YouTube playlist URL and produces a ZIP. The generator is
   responsible for paraphrasing transcript snippets into TRUE/FALSE
   attention-quiz questions and writing all CSV rows.

2. The **importer** — the PHP handler attached to the instructor's
   *Add Course → drag-and-drop ZIP* upload on artaquest.org. The importer
   reads the ZIP verbatim; it does not call any external API and does no
   paraphrasing of its own.

If both sides obey this spec, instructors can mass-produce courses by
running the generator on a playlist URL and uploading the result.

Spec is versioned via the top-level `course.json#version` field. The
importer rejects any ZIP whose version it does not understand.

---

## Top-level layout

```
my-course-bundle.zip
├── course.json                  REQUIRED — course manifest
├── thumbnail.jpg                OPTIONAL — 16:9, ≥ 1280×720, ≤ 2MB
├── 01-how-power-works/          one folder per video, zero-padded order
│   ├── video.json               REQUIRED — video manifest (this video)
│   ├── transcript.srt           REQUIRED — raw .srt for the YouTube video
│   └── quizzes.csv              REQUIRED — TRUE/FALSE attention quizzes
├── 02-how-societies-collapse/
│   ├── video.json
│   ├── transcript.srt
│   └── quizzes.csv
└── …                            up to 999 video folders
```

### Folder naming — strict

Every video folder name MUST match:

```
^([0-9]{2,3})-([a-z0-9]+(?:-[a-z0-9]+)*)$
```

- A 2- or 3-digit zero-padded **order index** (`01`, `02`, …, `999`).
- A hyphen.
- A **slug** — lowercase ASCII letters, digits, and hyphens only.

Examples:
- `01-how-power-works` ✓
- `28-pax-judaica` ✓
- `1-intro` ✗ (zero-padding missing)
- `01_intro` ✗ (underscore not allowed)
- `01-How_Power_Works` ✗ (capitals and underscores)

The importer uses the numeric prefix as the curriculum section order. Two
folders with the same prefix are a hard error.

---

## `course.json` — top-level manifest

```jsonc
{
  "version": 1,
  "title": "Secret History with Prof Jiang",
  "slug": "secret-history-with-prof-jiang",
  "instructor_user_login": "jiang_prof",
  "summary": "What if everything you were taught about money, power, civilization, and history is wrong? In 28 hour-long lectures filmed live in a university classroom, Prof. Jiang methodically dismantles the stories we take for granted.",
  "level": "beginner",
  "language": "en",
  "category_slugs": ["philosophy", "history"],
  "thumbnail": "thumbnail.jpg"
}
```

### Required fields

| Field                  | Type     | Notes                                                                                  |
|------------------------|----------|----------------------------------------------------------------------------------------|
| `version`              | int      | Must be `1`. Spec-version handshake.                                                   |
| `title`                | string   | Plain text, ≤ 120 chars. Used as the WP post title.                                    |
| `slug`                 | string   | Lowercase-kebab; if a course post with this slug exists, importer aborts.              |
| `instructor_user_login`| string   | A WordPress login (not email). User must already exist on prod with the `ay_instructor` role (or above) or import fails. |
| `summary`              | string   | ≤ 500 chars. Used as the course excerpt and the first paragraph of post content.       |
| `level`                | string   | `beginner` \| `intermediate` \| `advanced`.                                            |
| `language`             | string   | ISO 639-1 (`en`, `es`, `ar`, …).                                                       |
| `category_slugs`       | string[] | Each must be an existing `stm_lms_course_category` term-slug; importer rejects unknown slugs (does not auto-create). |

### Optional fields

| Field          | Type    | Notes                                                                                      |
|----------------|---------|--------------------------------------------------------------------------------------------|
| `thumbnail`    | string  | Relative path inside the ZIP. Becomes the WP featured image.                               |
| `external_id`  | string  | Stored as post meta `ay_external_id`. Re-imports with the same value overwrite the course. |

**Pricing is NOT in `course.json`.** It is computed by the importer from
the total of `video.json#duration_seconds` × $1 / 3600, rounded up to the
nearest dollar. Written to the linked WC product's `_regular_price` after
import.

---

## `<NN>-<slug>/video.json` — per-video manifest

```jsonc
{
  "title": "How Power Works: The Nature of Power",
  "youtube_id": "lt8XLz78ZvY",
  "duration_seconds": 4274,
  "lesson_count": 5
}
```

| Field              | Type   | Notes                                                                                       |
|--------------------|--------|---------------------------------------------------------------------------------------------|
| `title`            | string | Becomes the curriculum **section** title and the prefix of each lesson's title.             |
| `youtube_id`       | string | 11-char YouTube video ID. Stored as `lesson_youtube_url` meta on every lesson in this section. |
| `duration_seconds` | int    | Total length of the YouTube video. Must equal the last SRT cue's end time, ± 5 seconds.     |
| `lesson_count`     | int    | How many bite-sized lessons this video is divided into. Required so the importer can compute lesson boundaries even before reading `quizzes.csv`. Must be 1 ≤ lesson_count ≤ 20. |

Lesson boundaries are linear:

```
lesson_index ∈ [1 … lesson_count]
seg_start  = round((lesson_index - 1) / lesson_count × duration_seconds)
seg_end    = round( lesson_index      / lesson_count × duration_seconds)
```

The importer creates `lesson_count` `stm-lessons` posts per section,
each pointing at the same `youtube_id` but with distinct
`ay_transcript_seg_start` and `ay_transcript_seg_end` meta.

---

## `<NN>-<slug>/transcript.srt` — raw subtitles

Standard SRT format. Required so:

1. The course player can show captions (`<track kind=subtitles>` injected).
2. Auditors can verify the quiz `explanation` text exists in the lecture.
3. The importer can populate `ay_transcript` meta per lesson — by slicing
   the SRT cues whose start_time falls inside `[seg_start, seg_end]`.

Encoding: UTF-8. BOM is allowed. Filename: literally `transcript.srt`.

The generator is expected to fetch this from YouTube (or wherever it
sources captions). The importer does not download anything.

---

## `<NN>-<slug>/quizzes.csv` — attention-quiz questions

UTF-8 CSV, comma-delimited, double-quote-quoted, RFC 4180 dialect (one
escaped `""` for literal quotes). First row is the **literal** header:

```csv
lesson_index,marker_seconds,question,answer,explanation
```

| Column           | Type         | Notes                                                                                                                                                                                                                                              |
|------------------|--------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `lesson_index`   | int          | 1-based lesson within this video. Must be in `[1, lesson_count]`. Rows are grouped by `lesson_index` (sort order: ascending).                                                                                                                      |
| `marker_seconds` | int          | Absolute seconds from the start of the full YouTube video where this question fires. Must be within `[seg_start, seg_end]` of `lesson_index`, otherwise the importer rejects the row.                                                              |
| `question`       | string       | A single declarative statement, ≤ 240 chars. The student picks TRUE or FALSE — there are exactly two choices, no shuffling. The generator paraphrases what the instructor said; for FALSE rows it negates the statement.                            |
| `answer`         | string       | Exactly `TRUE` or `FALSE` (uppercase). Mixed case is rejected to avoid generator drift.                                                                                                                                                            |
| `explanation`    | string       | ≤ 600 chars. The verbatim section of the transcript that supports (or, for FALSE, that the question's negation contradicts). Shown to the student after they submit. The importer verifies this substring exists in the SRT (≥ 60% token overlap).|

Each lesson SHOULD have exactly **15 rows** (the LMS template assumes 15
attention questions per lesson). The importer allows 5–25; outside that
range it errors.

`marker_seconds` values within a lesson MUST be strictly increasing — no
ties, no out-of-order rows.

### Negation discipline

The generator alternates `TRUE` and `FALSE` rows pseudo-randomly per
lesson to avoid pattern-recognition cheating. A reasonable target is
roughly 50/50 ± 20% per lesson. The importer does NOT enforce a ratio
but **does** verify that across the whole course, the global ratio is
between 30% and 70% TRUE — a course with 100% TRUE or 100% FALSE is
rejected as a generator bug.

### Example

```csv
lesson_index,marker_seconds,question,answer,explanation
1,53,"Power and authority mean the same thing in Prof. Jiang's framework.",FALSE,"Power is the ability to compel; authority is power that has been freely granted. Jiang draws a sharp line between the two from the first minute."
1,108,"Authority is freely granted by the people who recognise it.",TRUE,"Authority depends on the recognition of those who accept it; the moment that consent is withdrawn the authority evaporates."
1,165,"Jiang argues that power and authority are interchangeable.",FALSE,"Throughout the opening, Jiang stresses that conflating power and authority is the first mistake of political analysis."
```

---

## Importer behavior

When the instructor uploads the ZIP on `/user-account/courses/add/`:

1. Validate signature (magic bytes), size ≤ 500 MB, no path traversal in
   any inner filename.
2. Parse `course.json`. Reject on version mismatch or missing required
   fields. Reject if `slug` already exists AND `external_id` is unset.
3. List video folders, sort by numeric prefix. Reject duplicate prefixes.
4. For each folder, parse `video.json` + `quizzes.csv` + `transcript.srt`
   in one pass. Collect all errors before failing — the response payload
   lists every problem with `folder:line:column` coordinates.
5. If validation passes:
   - Create or update the `stm-courses` post.
   - For each video folder, create a curriculum section.
   - For each lesson within a video, create an `stm-lessons` post with
     `lesson_youtube_url` set to the YouTube URL, `ay_transcript`,
     `ay_transcript_seg_start`, `ay_transcript_seg_end` set per the
     linear split.
   - For each `quizzes.csv` row, insert a row into
     `wp_artaquest_lesson_marker_questions` with `marker = marker_seconds`,
     `type = single_choice`, `answers = serialize([True, False])` with
     the correct one flagged from the `answer` column, `caption =
     explanation`.
6. Sum `duration_seconds` across videos → divide by 3600 → `ceil` →
   `_regular_price` on the linked WC product. Set `pricing_mode =
   subscription` (not free), `single_sale = on`. Course is now paywalled.
7. Return a JSON receipt with the new course post ID, the lesson IDs,
   and the total marker-question count.

The importer is idempotent on `external_id` — re-uploading the same
bundle with the same `course.json#external_id` updates the existing
course in place rather than creating a duplicate.

---

## Generator checklist (for the external script)

Before zipping, the generator should self-check:

- [ ] Every folder name matches the strict regex.
- [ ] Every folder has all three files (`video.json`, `transcript.srt`,
      `quizzes.csv`).
- [ ] Every CSV row has exactly 5 columns; quotes are properly escaped.
- [ ] Every `answer` cell is literally `TRUE` or `FALSE` (uppercase).
- [ ] Each lesson has between 5 and 25 questions; ideally 15.
- [ ] Each lesson's `marker_seconds` values are strictly increasing.
- [ ] Each `marker_seconds` lies inside its lesson's
      `[seg_start, seg_end]` window.
- [ ] Global TRUE-row ratio is in `[0.30, 0.70]`.
- [ ] Each `explanation` shares ≥ 60% of its tokens with at least one
      SRT cue inside the same lesson window.
- [ ] `course.json#instructor_user_login` corresponds to a real user on
      the target site (the script should check via the public
      `/wp-json/wp/v2/users?slug=…` endpoint before zipping).
- [ ] Total ZIP size ≤ 500 MB.

A reference generator lives outside this repo. Anything that produces a
ZIP matching this spec will import cleanly.

---

## Versioning

This file is **v1**. Any backwards-incompatible change to folder shape,
CSV columns, or manifest fields requires bumping `course.json#version`
and the importer to handle the new version explicitly. The importer must
continue to read v1 bundles after any future bump.
