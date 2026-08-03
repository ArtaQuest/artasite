// Route-chunk prefetch on intent (hover / focus). The route components are lazy()-loaded in App.tsx,
// so the first visit to a course/lesson/profile waits on a network round-trip for its chunk. Warming
// that chunk when the user signals intent (hovers or tab-focuses a link) means the code is usually
// already parsed by the time they click — snappier navigation (a better INP/engagement profile, which
// feeds Core Web Vitals). Calling the SAME dynamic import the router uses is deduped by the bundler,
// so this only warms the cache; it never double-loads.

const ROUTES: Record<string, () => Promise<unknown>> = {
  course: () => import("../pages/CourseDetail"),
  lesson: () => import("../pages/Lesson"),
  profile: () => import("../pages/Profile"),
  courses: () => import("../pages/Courses"),
  thread: () => import("../pages/Thread"),
};

const warmed = new Set<string>();

/** Prefetch a route's chunk once. Safe to call repeatedly (no-op after the first). */
export function prefetchRoute(name: keyof typeof ROUTES | string): void {
  if (warmed.has(name)) return;
  const load = ROUTES[name];
  if (!load) return;
  warmed.add(name);
  // Swallow failures (offline / chunk 404 after a deploy) and allow a later retry.
  load().catch(() => warmed.delete(name));
}

/** Handler props to spread onto a link so hovering/focusing it warms a route chunk. */
export function prefetchProps(name: keyof typeof ROUTES | string) {
  const go = () => prefetchRoute(name);
  return { onMouseEnter: go, onFocus: go } as const;
}
