#!/usr/bin/env bash
# ── ArtaQuest scalability benchmark ────────────────────────────────────────────
# The platform must read-scale to millions of courses, billions of users, trillions
# of comments/votes/ledger rows. The one thing that breaks at that size is a read
# whose cost grows with the TOTAL row count: a full-table SUM/COUNT, a GROUP-BY over
# every row, a deep OFFSET, a whole-table sort. This tool finds those reads two ways,
# both reliable and engine-faithful:
#
#   1. QUERY PLAN (the verdict)  — `EXPLAIN QUERY PLAN`. A full SCAN of a big table or a
#      TEMP B-TREE sort/group is O(rows) = HOTSPOT; an index SEARCH / ordered index walk
#      with a LIMIT early-out is O(log n + page) = SCALABLE. Plan shape is the same on
#      SQLite (dev) and MySQL (prod), so the verdict carries to production.
#   2. WALL-CLOCK (corroboration) — real seconds at LARGE N, native sqlite3 (no PHP-WASM
#      timer noise, no 120s WP-CLI ceiling). A scan visibly costs ms; a seek ~0.
#
# Why standalone sqlite3 and not `studio wp eval`: the WP SQLite integration STRIPS
# `EXPLAIN QUERY PLAN` (returns nothing) and silently skips the secondary indexes prod
# MySQL has — so in-WP planning is doubly unreliable. Here we build the schema WITH the
# indexes prod has and let the same engine dev uses report the real plan.
#
# For each hot path it benches the CURRENT query and the PROJECTED query (against the
# denormalized projection tables added in Schema.php), proving each hotspot went flat.
#
#   tools/bench.sh            # default N = 1,000,000 rows per table
#   N=4000000 tools/bench.sh  # heavier
set -euo pipefail
N="${N:-1000000}"
USERS=$(( N / 20 < 50 ? 50 : N / 20 ))
COURSES=$(( N / 200 < 10 ? 10 : N / 200 ))
DEEP=$(( N - 50 ))
DB="$(mktemp -t aqbench).sqlite"
trap 'rm -f "$DB"' EXIT

echo ""
echo "=== ArtaQuest scalability benchmark ==="
echo "engine: sqlite3 $(sqlite3 --version | cut -d' ' -f1)   N=${N} rows/table   users≈${USERS}   courses≈${COURSES}"
echo ""

# ── build + seed (recursive-CTE seeding is all native, ~seconds for 1M) ─────────
sqlite3 "$DB" >/dev/null <<SQL
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;

CREATE TABLE coin_ledger ( id INTEGER PRIMARY KEY, user_id INT, delta INT, reason TEXT, ref TEXT, created INT );
CREATE INDEX cl_user ON coin_ledger (user_id, id);
CREATE TABLE points_ledger ( id INTEGER PRIMARY KEY, user_id INT, delta INT, track TEXT, ref TEXT, created INT );
CREATE INDEX pl_user ON points_ledger (user_id, id);
CREATE TABLE comments ( id INTEGER PRIMARY KEY, context_type TEXT, context_id INT, course_id INT, parent_id INT, author_id INT, votes INT, flagged INT, created INT );
CREATE INDEX c_course ON comments (course_id, author_id);
-- the real board index (Schema.php aq_comments.ctx_parent_votes): equality on the board, ordered by votes.
CREATE INDEX c_board ON comments (context_type, context_id, parent_id, votes);
CREATE TABLE votes ( id INTEGER PRIMARY KEY, user_id INT, target_type TEXT, target_id INT, val INT, course_id INT, context_id INT, created INT );
CREATE INDEX v_target ON votes (target_type, target_id);
CREATE TABLE big ( id INTEGER PRIMARY KEY, a INT, b TEXT, created INT );
CREATE TABLE lessons ( id INTEGER PRIMARY KEY, course_id INT, idx INT, comment_count INT );
CREATE INDEX l_course ON lessons (course_id, idx);
CREATE TABLE courses ( id INTEGER PRIMARY KEY, status TEXT, enroll_count INT, rank_score INT );
CREATE INDEX co_enroll ON courses (status, enroll_count, id);

-- projections under test (the "after" state)
CREATE TABLE balances ( user_id INTEGER PRIMARY KEY, coins INT, points INT );
-- NOTE on index fidelity: InnoDB (prod) appends the table PRIMARY KEY columns to every secondary
-- index, so MySQL KEY (track, points) is really (track, points, user_id) and can reverse-walk
-- ORDER BY points DESC, user_id DESC with no filesort. SQLite appends the rowid instead, NOT the PK
-- columns — so to predict the MySQL plan we spell the PK columns into the index here. (This is the same
-- dev/prod divergence the header warns about; modelling it is what makes the verdict carry to prod.)
CREATE TABLE standing ( track TEXT, user_id INT, points INT, PRIMARY KEY (track, user_id) );
CREATE INDEX st_board ON standing (track, points, user_id);
CREATE TABLE qstand ( season_key INT, course_id INT, user_id INT, votes INT, comments INT, PRIMARY KEY (season_key, course_id, user_id) );
CREATE INDEX qs_board ON qstand (season_key, course_id, votes, comments, user_id);
CREATE TABLE counters ( name TEXT PRIMARY KEY, value INT );

WITH RECURSIVE s(i) AS ( SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i < ${N}-1 )
INSERT INTO coin_ledger (user_id, delta, reason, ref, created)
  SELECT CASE WHEN i%10=0 THEN 1 ELSE (i%${USERS})+1 END, (i%7)-3, 'x', 'r'||i, 0 FROM s;
WITH RECURSIVE s(i) AS ( SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i < ${N}-1 )
INSERT INTO points_ledger (user_id, delta, track, ref, created)
  SELECT CASE WHEN i%10=0 THEN 1 ELSE (i%${USERS})+1 END, (i%5)+1,
         CASE i%4 WHEN 0 THEN 'learn' WHEN 1 THEN 'donate' WHEN 2 THEN 'bug' ELSE 'feature' END, 'r'||i, 0 FROM s;
WITH RECURSIVE s(i) AS ( SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i < ${N}-1 )
INSERT INTO comments (context_type, context_id, course_id, parent_id, author_id, votes, flagged, created)
  SELECT 'section', (i%30)+1, CASE WHEN i%5<2 THEN 1 ELSE (i%${COURSES})+1 END, 0, (i%${USERS})+1, i%9, CASE WHEN i%50=0 THEN 1 ELSE 0 END, 0 FROM s;
-- votes: concentrate ~10% onto comment #1 to model a VIRAL comment (a single target accruing
-- millions of votes) — the case where re-SUMming a comment's whole vote set on each new vote is a
-- per-key scan, even though the plan calls it an index seek. The rest spread uniformly.
WITH RECURSIVE s(i) AS ( SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i < ${N}-1 )
INSERT INTO votes (user_id, target_type, target_id, val, course_id, context_id, created)
  SELECT (i%${USERS})+1, 'comment', CASE WHEN i%10=0 THEN 1 ELSE (i%${N})+1 END, 1, 1, 1, 0 FROM s;
WITH RECURSIVE s(i) AS ( SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i < ${N}-1 )
INSERT INTO big (a, b, created) SELECT i, 'row'||i, 0 FROM s;
-- one course row per id up to N, to model a catalogue of millions sorted by popularity (enroll_count).
WITH RECURSIVE s(i) AS ( SELECT 0 UNION ALL SELECT i+1 FROM s WHERE i < ${N}-1 )
INSERT INTO courses (status, enroll_count, rank_score) SELECT 'publish', i%100000, i%1000 FROM s;

INSERT INTO balances (user_id, coins, points) SELECT user_id, SUM(delta), 0 FROM coin_ledger GROUP BY user_id;
INSERT INTO standing (track, user_id, points) SELECT track, user_id, SUM(delta) FROM points_ledger GROUP BY track, user_id;
INSERT INTO standing (track, user_id, points) SELECT 'all', user_id, SUM(delta) FROM points_ledger GROUP BY user_id;
INSERT INTO qstand (season_key, course_id, user_id, votes, comments)
  SELECT 1, c.course_id, c.author_id, COALESCE(SUM(v.val),0), COUNT(DISTINCT c.id)
    FROM comments c LEFT JOIN votes v ON v.target_type='comment' AND v.target_id=c.id
   WHERE c.context_type='section' AND c.flagged=0 GROUP BY c.course_id, c.author_id;
INSERT INTO counters (name, value) VALUES ('coins_issued', (SELECT SUM(delta) FROM coin_ledger));
-- lessons projection: one row per (course, section) carrying the denormalized section comment total,
-- so a course page badges every board from an O(lessons) ranged read instead of GROUP-BY-ing the
-- course's whole comment set on each pageview. Seed the 30 sections of course #1 from the comments.
INSERT INTO lessons (course_id, idx, comment_count)
  SELECT 1, context_id, COUNT(*) FROM comments WHERE context_type='section' AND course_id=1 GROUP BY context_id;
ANALYZE;
SQL

# ── probe runner: classify by plan, time by wall-clock. Echoes "<verdict> <ms>". ─
# (bash 3.2 on macOS: no associative arrays — verdicts are captured via the echoed line.)
RULE='HOTSPOT = full SCAN or TEMP B-TREE over a big table (O(rows)) · SCALABLE = index seek / ordered walk + LIMIT (O(log n))'
probe () { # $1=name $2=kind $3=sql  → prints the report row, sets REPLY=verdict
  local name="$1" kind="$2" sql="$3" plan verdict why secs
  plan=$(sqlite3 "$DB" "EXPLAIN QUERY PLAN $sql" 2>/dev/null || true)
  if echo "$plan" | grep -qi 'USE TEMP B-TREE'; then
    verdict=HOTSPOT; why='sorts/groups whole table (temp b-tree)'
  elif echo "$plan" | grep -i 'SCAN' | grep -qvi 'USING'; then
    verdict=HOTSPOT; why='full table scan'
  else
    verdict=SCALABLE; why='index seek / ordered walk'
  fi
  secs=$( sqlite3 "$DB" <<EOF 2>/dev/null | grep -i 'Run Time' | sed -E 's/.*real ([0-9.]+).*/\1/' | sort -n | sed -n '2p'
.timer on
$sql;
$sql;
$sql;
EOF
)
  printf "%-22s %-5s %-9s %10ss   %s\n" "$name" "$kind" "$verdict" "${secs:-?}" "$why"
  REPLY="$verdict"
}

printf "%-22s %-5s %-9s %11s   %s\n" "probe" "kind" "verdict" "wall(real)" "why"
hr () { local i=0; while [ $i -lt 92 ]; do printf '─'; i=$((i+1)); done; echo ""; }
hr

SCORE=""
pair () { # base, curSql, projSql
  probe "$1" CUR  "$2"; local c="$REPLY"
  probe "$1" PROJ "$3"; local p="$REPLY"
  local ok; if [ "$p" = SCALABLE ]; then ok=OK; else ok="✗ STILL A HOTSPOT"; fi
  SCORE="${SCORE}$(printf '  %-20s %-9s → %-9s %s' "$1" "$c" "$p" "$ok")
"
}

pair reserve           "SELECT SUM(delta) FROM coin_ledger" \
                       "SELECT value FROM counters WHERE name='coins_issued'"
pair balance           "SELECT SUM(delta) FROM coin_ledger WHERE user_id=1" \
                       "SELECT coins FROM balances WHERE user_id=1"
# PROJ queries below mirror the REAL ORDER BY in the code (incl. the secondary tiebreaks), so the
# benchmark proves the tiebreak doesn't reintroduce a filesort over the whole matching set.
pair leaderboard       "SELECT user_id, SUM(delta) s FROM points_ledger GROUP BY user_id ORDER BY s DESC LIMIT 50" \
                       "SELECT user_id, points FROM standing WHERE track='all' ORDER BY points DESC, user_id DESC LIMIT 50"
pair leaderboard_track "SELECT user_id, SUM(delta) s FROM points_ledger WHERE track='learn' GROUP BY user_id ORDER BY s DESC LIMIT 50" \
                       "SELECT user_id, points FROM standing WHERE track='learn' ORDER BY points DESC, user_id DESC LIMIT 50"
pair podium            "SELECT c.author_id, COALESCE(SUM(v.val),0) vv FROM comments c LEFT JOIN votes v ON v.target_type='comment' AND v.target_id=c.id WHERE c.context_type='section' AND c.course_id=1 AND c.flagged=0 GROUP BY c.author_id ORDER BY vv DESC LIMIT 50" \
                       "SELECT user_id, votes, comments FROM qstand WHERE season_key=1 AND course_id=1 ORDER BY votes DESC, comments DESC, user_id DESC LIMIT 50"
pair course_ccount     "SELECT context_id, COUNT(*) n FROM comments WHERE context_type='section' AND course_id=1 GROUP BY context_id" \
                       "SELECT id, comment_count FROM lessons WHERE course_id=1 ORDER BY idx"
pair comment_votes     "SELECT COALESCE(SUM(val),0) FROM votes WHERE target_type='comment' AND target_id=1" \
                       "SELECT votes FROM comments WHERE id=1"
pair board_top         "SELECT * FROM comments WHERE context_type='section' AND context_id=1 AND parent_id=0 ORDER BY votes DESC, id ASC LIMIT 30" \
                       "SELECT * FROM comments WHERE context_type='section' AND context_id=1 AND parent_id=0 ORDER BY votes DESC, id DESC LIMIT 30"
pair courses_popular   "SELECT id, enroll_count FROM courses WHERE status='publish' ORDER BY enroll_count DESC LIMIT 100" \
                       "SELECT id, enroll_count FROM courses WHERE status='publish' ORDER BY enroll_count DESC, id DESC LIMIT 100"
pair explorer_page     "SELECT * FROM big ORDER BY id LIMIT 25 OFFSET ${DEEP}" \
                       "SELECT * FROM big WHERE id>${DEEP} ORDER BY id LIMIT 25"
probe explorer_count CUR "SELECT COUNT(*) FROM big"; COUNT_V="$REPLY"

hr
echo ""
echo "rule: $RULE"
echo ""
echo "fix scorecard (CURRENT → PROJECTED):"
printf '%s' "$SCORE"
echo "  explorer_count       ${COUNT_V}   (COUNT(*) — Iteration 3 serves an O(1) approximate count)"
echo ""
if printf '%s' "$SCORE" | grep -q 'HOTSPOT$\|✗'; then echo "SOME PROJECTIONS STILL HOTSPOTS ✗"; else echo "ALL PROJECTIONS SCALABLE ✓"; fi
echo ""
