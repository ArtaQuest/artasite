/**
 * Does the curated course a topic points at actually exist yet?
 *
 * Topics in the typology JSON carry an *aspirational* `course` URL — the codebase is "working
 * toward a full course per system", so most of those URLs have no course on the backend yet.
 * Trusting the field blindly makes the topic page show a "Take the course" button that 404s
 * (ticket #132 — e.g. "Mercury sign · Sidereal"). This checks the slug against the catalogue
 * (GET /courses/slug/<slug>, public + CDN-cacheable) so callers can offer "Take the course" only
 * when there's really a course, and fall back to the instructor video / search otherwise.
 *
 * Defaults to false so a broken course link is never shown, even for a frame. Pass `undefined`
 * (e.g. for a collapsed card) to skip the check entirely. Results are memoised per slug across the
 * whole app: many topics share the same not-yet-built course URL (15 point at one Vedic course, 14
 * at one Western one), so the whole catalogue collapses to one request per distinct slug.
 */
import { useEffect, useState } from "react";
import { Courses } from "./api";

const cache = new Map<string, Promise<boolean>>();

/** The slug inside a topic's `course` URL ("/courses/<slug>"), or null if it isn't one. */
function slugOf(courseUrl?: string): string | null {
  const m = courseUrl?.match(/^\/courses\/([a-z0-9-]+)\/?$/);
  return m ? m[1] : null;
}

export function useCourseExists(courseUrl?: string): boolean {
  const slug = slugOf(courseUrl);
  const [exists, setExists] = useState(false);
  useEffect(() => {
    setExists(false);
    if (!slug) return;
    let on = true;
    let p = cache.get(slug);
    if (!p) {
      p = Courses.bySlug(slug).then(() => true, () => false);
      cache.set(slug, p);
    }
    p.then((ok) => { if (on) setExists(ok); });
    return () => { on = false; };
  }, [slug]);
  return exists;
}
