import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { dismissBootScreen } from './lib/boot'
import { applyContrast } from './lib/contrast'
import { installModelHost } from './lib/model-host'

// ARM THE SAFETY NET FIRST. Everything below this line can throw — installModelHost() and
// applyContrast() both touch the DOM and storage, and render() runs the whole app — and until 2026-08-13
// the net was armed AFTER all of it. A throw in any of them left the branded boot screen covering the
// site with nothing left running to lift it, which reads to a visitor as "the site is down". The
// shell arms its own, later net too (template-aq-app.php), for the case where this bundle never
// executes at all; this one is for a bundle that starts and then falls over.
setTimeout(dismissBootScreen, 10000)

// A DEPLOY REPLACES EVERY HASHED CHUNK. A page whose HTML predates it — a tab left open, or the
// edge serving a STALE copy for its revalidation window (observed 2026-10-08: x-ac STALE, the old
// entry loaded, and /lab's lazy Lab-<old hash>.js answered 404) — then dies the moment it imports a
// route it has not visited yet. Vite raises vite:preloadError for exactly that; reload once so the
// fresh HTML names the fresh chunks. Guarded per URL for a minute, so a chunk that is genuinely
// missing produces one reload and then the real error, never a loop.
// The shell's stale-asset net (template-aq-app.php) reloads with a throwaway ?aqv= to get past a
// stale edge copy; drop it before the router reads the URL, so it is never shared or bookmarked.
if (new URLSearchParams(location.search).has('aqv')) {
  const q = new URLSearchParams(location.search)
  q.delete('aqv')
  const s = q.toString()
  history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + location.hash)
}

window.addEventListener('vite:preloadError', (e) => {
  const key = 'aq-chunk-reload:' + location.pathname
  try {
    const last = Number(sessionStorage.getItem(key) || 0)
    if (Date.now() - last < 60000) return
    sessionStorage.setItem(key, String(Date.now()))
  } catch { return }   // no storage → no loop guard → do not risk a reload loop
  e.preventDefault()
  location.reload()
})

// Point every on-device model download at Kaggle (artafather) BEFORE anything can import a model
// loader — kokoro-js and @huggingface/transformers build HuggingFace URLs inside their own bundles,
// so this has to be in place first or their first fetch escapes to a host the CSP no longer allows.
installModelHost()

// Apply the saved text-contrast level (lib/contrast) against the pre-painted theme BEFORE first
// render, so the chosen --color-ink is live on the very first frame (no contrast flash). The theme
// attribute is already set by the shell's inline boot script; this reads the resulting canvas.
applyContrast()

// Mount into the WordPress-provided container in production (the [aq_app] shortcode
// prints <div id="aq-app-root">), or the dev index.html #root during `npm run dev`.
const mount = document.getElementById('aq-app-root') ?? document.getElementById('root')
if (mount) {
  createRoot(mount).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )

  // The branded loader is normally lifted by <BootGate> (App.tsx) the moment the matched route's
  // lazy chunk has loaded AND painted — covering the whole chunk-load gap rather than fading after
  // React's first commit (the bare <Suspense> "Loading…" line). The safety net is armed at the top of
  // this file instead of here, so it survives a throw on the way to this point.
}

// Register the PWA service worker so the app is installable and boots offline (the shell + assets
// are cached by /sw.js; learning DATA is served from IndexedDB by src/lib/offline). Production only —
// in dev the file is served by Studio WP, not Vite. Failures are non-fatal (the app works without it).
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Auto-reload ONCE when an updated worker takes control, so a redeploy's fresh chunks load without a
  // manual hard-refresh (chunk-only deploys don't change sw.js, but a version bump does → controllerchange).
  // Guarded against loops; only armed when a worker was already controlling us (a real update, not the
  // first install — that would reload pointlessly on a brand-new visit).
  if (navigator.serviceWorker.controller) {
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return
      refreshing = true
      window.location.reload()
    })
  }
  window.addEventListener('load', () => {
    // Served by the plugin from the root-path query URL (the host 404s a root /sw.js before WP sees it).
    // The script path is "/", so its control scope is the whole site.
    navigator.serviceWorker.register('/?aq_sw=1', { scope: '/' })
      .then(() => autoPrepareOffline())
      .catch(() => { /* offline mode unavailable — app still works online */ })
  })
}

/**
 * Make EVERY page work offline automatically — after a single online visit, with no button to press.
 *
 * Each route is a separate lazy-loaded chunk, so offline a route the user never opened online would
 * otherwise fail to load (a blank/"couldn't load" page — the "can't navigate offline" report). The
 * Download Center has always had a manual "Download app for offline", but most people never tap it,
 * so we run the SAME build-aware precache here in the background on every online load: it caches the
 * whole built app (all route chunks + CSS + fonts + the shell) into Cache Storage, idempotently and
 * cheaply (it skips files already cached for the current build, and prunes old builds). The result:
 * once you've opened ArtaQuest online even once, you can open any page with the internet off.
 *
 * Also asks for PERSISTENT storage up front so iOS/Safari (which evicts ordinary site data under
 * pressure, and especially when the PWA isn't added to the Home Screen) keeps the cached app + the
 * downloaded courses/videos around. Both are best-effort and never block or surface errors.
 */
async function autoPrepareOffline() {
  if (!navigator.onLine) return
  // NOT on a first anonymous visit. This precache is ~28 MB across ~368 files, and it was running
  // for every stranger who merely opened the landing page — competing for bandwidth on the one
  // visit that decides whether they stay, and spending a phone's data allowance on an app they have
  // not signed up for. Offline mode is a MEMBER's feature, so wait for a session; anyone else can
  // still start it deliberately from the Download Center on /offline. Data-saver and 2g are
  // honoured regardless of who is asking — the browser is telling us not to.
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection
  if (conn?.saveData === true) return
  if (conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return
  const loggedIn = (window as unknown as { AQ_LOGGED_IN?: boolean }).AQ_LOGGED_IN
  if (loggedIn === false) return
  // Ask the browser to keep our cached app + downloads (best-effort; iOS retention).
  try { await navigator.storage?.persist?.() } catch { /* not supported */ }
  const run = async () => {
    try {
      const m = await import('./lib/offline/store')
      const status = await m.appFilesStatus()
      if (status.complete) return // current build already fully cached — nothing to do
      await m.downloadAppFiles() // caches shell + every route chunk for THIS build; prunes older ones
    } catch { /* offline / storage blocked — the app still works online and retries next load */ }
  }
  // Defer to idle so it never competes with first paint — but keep the budget short so the cache is
  // populated quickly (mobile visits are brief; the sooner this finishes, the sooner offline works).
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback
  if (ric) ric(() => { void run() }, { timeout: 3000 })
  else setTimeout(() => { void run() }, 1500)
}
