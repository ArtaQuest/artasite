import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { dismissBootScreen } from './lib/boot'
import { applyContrast } from './lib/contrast'
import { installModelHost } from './lib/model-host'

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

  // The branded loader is now lifted by <BootGate> (App.tsx) the moment the matched route's lazy
  // chunk has loaded AND painted — so it covers the whole chunk-load gap instead of fading after
  // React's first commit (the bare <Suspense> "Loading…" line). This timer is only a safety net: if
  // that chunk never resolves (offline, a 404'd asset) and the error boundary doesn't fire either, it
  // still clears the loader so nobody is trapped. dismissBootScreen() is idempotent — the normal path
  // (BootGate) always wins the race.
  setTimeout(dismissBootScreen, 10000)
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
