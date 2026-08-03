/**
 * DEV-ONLY lorem mode. When enabled, list pages render placeholder content so we can
 * check layout and density without a fully populated database.
 *
 * Triggered by `?aqlorem=1` (or window.AQ_LOREM). NEVER on for real users —
 * production URLs never carry the flag.
 */
import type { CourseCard, RankRow, Thread, ThreadData, ThreadComment, DiscussionsData, Forum, CourseDetail } from "./wp";

export function isLorem(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { AQ_LOREM?: boolean };
  if (w.AQ_LOREM) return true;
  try { return new URLSearchParams(window.location.search).has("aqlorem"); } catch { return false; }
}

// Item counts chosen to over-fill the first viewport, so list layouts can be checked
// at a realistic content density.
export const LOREM_COUNTS = {
  courses: 20,    // datasets grid cards
  ranks: 50,      // rankings rows
  threads: 24,    // discussion thread rows
  comments: 20,   // thread comments
  curriculum: 24, // course-detail lesson rows
};

const WORDS = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud " +
  "exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure " +
  "reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint"
).split(" ");

let _seed = 0;
function reset(s = 0) { _seed = s; }
function words(n: number, cap = true): string {
  const a: string[] = [];
  for (let k = 0; k < Math.max(1, n); k++) a.push(WORDS[_seed++ % WORDS.length]);
  const s = a.join(" ");
  return cap ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
// Deterministic pseudo-varied integer in [base, base+mod) from index — stable across renders.
function num(i: number, mod: number, base = 0): number { return base + (((i + 1) * 9301 + 49297) % mod); }

export function loremCourses(n = LOREM_COUNTS.courses): CourseCard[] {
  reset(3);
  return Array.from({ length: n }, (_, i) => ({
    title: words(num(i, 4, 4)),               // 4–7 words
    url: "#",
    excerpt: words(num(i, 8, 10), false),
    image: "",                                 // empty → component gradient fallback
    instructor: words(2),
    lessons: num(i, 30, 6),
    category: words(1),
  }));
}

export function loremRanks(n = LOREM_COUNTS.ranks): RankRow[] {
  reset(7);
  return Array.from({ length: n }, (_, i) => {
    const total = Math.max(0, 52000 - i * (300 + num(i, 600)));
    const tier = total >= 1000000 ? "Legend" : total >= 100000 ? "Pioneer" : total >= 10000 ? "Expert" : total >= 1000 ? "Creator" : "Quester";
    return {
      rank: i + 1,
      name: words(num(i, 2, 2)),               // 2–3 words
      points: total,
      tier,
      joined: ["Jan 2024", "Mar 2023", "Sep 2022", "Jun 2024", "Nov 2021"][i % 5],
      avatar: "",
      country: "", // placeholder rows are never verified → no flag
      profile_url: "#",
    };
  });
}

export function loremThreads(n = LOREM_COUNTS.threads): Thread[] {
  reset(11);
  return Array.from({ length: n }, (_, i) => ({
    slug: "lorem-" + i,
    title: words(num(i, 6, 5)),                // 5–10 words
    excerpt: words(num(i, 14, 12), false),
    author: words(2),
    votes: num(i, 80, 1),
    replies: num(i, 30, 0),
    views: num(i, 900, 30),
    last_at: "1d ago",
    last_by: words(2),
    pinned: i === 0,
    url: "#",
  }));
}

export function loremThread(nComments = LOREM_COUNTS.comments): ThreadData {
  reset(13);
  const comments: ThreadComment[] = Array.from({ length: nComments }, (_, i) => ({
    id: "c" + i,
    author: words(2),
    votes: num(i, 40, 0),
    parent: i > 2 && i % 3 === 0 ? "c" + (i - 2) : "",  // light nesting
    body_html: "<p>" + words(num(i, 40, 20), false) + "</p>",
    time: "1d ago",
  }));
  return {
    forum: "general", slug: "lorem", id: "lorem", title: words(7), author: words(2), time: "1d ago",
    votes: 42,
    body_html: "<p>" + words(60, false) + "</p><p>" + words(50, false) + "</p>",
    comments,
  };
}

/** Curriculum lesson list for the course-detail page. */
export function loremLessons(n = LOREM_COUNTS.curriculum): { id: number; title: string; url: string; video: string; commentsPerDay: number; done: boolean; complete: boolean; locked: boolean }[] {
  reset(17);
  // Sequential-unlock demo state: first two sections complete (watched + commented + upvoted), next open, rest locked.
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1, title: words(num(i, 5, 4)), url: "#", video: "", commentsPerDay: 0,
    done: i < 2, complete: i < 2, locked: i > 2,
  }));
}

export function loremDiscussions(n = LOREM_COUNTS.threads): DiscussionsData {
  reset(11);
  const forums: Forum[] = ["General", "Getting Started", "Product Feedback", "Questions & Answers", "Course Help"]
    .map((t) => ({ slug: t.toLowerCase().replace(/\W+/g, "-"), title: t, desc: words(8, false) }));
  return { forums, forum: forums[0], threads: loremThreads(n), next: null };
}

export function loremCourse(): CourseDetail {
  reset(19);
  return {
    id: 0,
    title: words(5), url: "#", start_url: "#",
    excerpt: words(16, false),
    description: "<p>" + words(70, false) + "</p><p>" + words(60, false) + "</p>",
    image: "", instructor: words(2), instructor_avatar: "", category: words(1),
    lessons_total: LOREM_COUNTS.curriculum,
    lessons: loremLessons(),
    // Courses cost an entry fee (coins) that funds the seasonal prize pool — preview a priced course.
    is_free: false, price: 9, currency: "ARTA", product_id: 0,
    price_display: "₳9", price_symbol: "₳", coin_buy_price: 0.13, coin_fiat: "CAD",
    has_access: false, logged_in: false, bursary_url: "#",
  };
}
