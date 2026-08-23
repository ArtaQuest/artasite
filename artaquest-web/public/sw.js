/*
 * ArtaQuest service worker — the PWA / offline shell.
 *
 * Served at the site ROOT (/sw.js) by the plugin (AQ\Offline::serve_pwa_assets) so its scope is the
 * whole SPA. It makes the app installable and boots it with no network; the actual learning DATA
 * (courses, transcripts, language packs, the public DB) is served from IndexedDB by the app's own
 * offline layer (src/lib/offline). The worker handles three things only — the app shell (HTML),
 * the build assets (JS/CSS), and images — and deliberately leaves /wp-json to the app, so it never
 * caches a stale personalised API response.
 */
// Bump the version to force every device onto this worker and PURGE the old caches — a previously
// cached shell can reference build-asset hashes that no longer exist (after a redeploy), and serving
// that stale shell offline boots into a dead <script> → blank screen before React can even mount an
// error boundary. A clean slate (re-cached on the next online visit) avoids that.
// v3: purge caches that may hold a STALE aq-precache.json (see the network-first manifest
// handler below — ticket #26 "courses page not available offline after download").
// v4: the topic-art icon SVGs have STABLE (non-hashed) filenames but their CONTENT changed
// (ticket #97 — background-less + theme-adaptive marks). Build assets under app/ and images are
// both served cache-FIRST below, so a returning visitor keeps the old dark-disc SVGs forever
// unless we purge: bumping the version evicts the v3 runtime caches on activate (see KEEP).
// v5: chunk-only deploys (new JS hashes, an UNCHANGED sw.js) gave the worker no reason to re-install,
// so a device could keep serving the previous precached shell/assets after a redeploy. Bumping forces a
// fresh install (re-precache the current build) + purges the stale shell/assets caches on activate; the
// page (src/main.tsx) now also auto-reloads once when this new worker takes control.
// v6: ship the study-compass rebuild (house-based phases, precise dates, days-only, the fine-tune slider) to
// already-cached devices — the version bump force-reinstalls the worker, and src/main.tsx auto-reloads once
// when it takes control, so the new build lands without a manual hard-refresh.
// v7: the Studio "House" picker fix (#142 — list the universal What·field names Psychology/Engineering/Science…
// instead of the old zodiac signs) shipped as a CHUNK-ONLY deploy: new JS hashes, an UNCHANGED sw.js. That is
// the v5 failure mode above — SW-cached devices had no reason to re-install, so they kept serving the pre-fix
// bundle and the picker still showed the old options ("still same" after the deploy). The picker source is
// already correct in the shipped build; bumping forces those devices to re-install, purge the stale shell/asset
// caches, re-precache the current build, and auto-reload once onto it (src/main.tsx), so the fix finally lands.
// v8: #142 again — the v7 picker showed the right field NAMES but still went stale WITHIN a session. The picker
// read a frontend FIELDS const computed ONCE at page load (from window.AQ_LABELS); the "Courses balance" wheel
// refetches the live registry. So after an operator renamed fields in Studio's Labels tab, the wheel updated but
// the picker kept the page-load snapshot ("same old hard coded values" — the two no longer in sync). The picker
// now sources its options from that SAME live registry (Disciplines.list() → houses), a chunk-only change — the
// v5/v7 failure mode — so bump to force SW-cached devices to re-install, purge the stale shell/asset caches,
// re-precache the current build, and auto-reload once onto it (src/main.tsx), landing the fix on cached devices.
// v9: ticket #146 — the South Park character topic-art SVGs were redrawn (background-less so they fit the
// circular frame, frame-filling, + the topic icon now shows the lead character like Rick & Morty). These are
// STABLE non-hashed filenames whose CONTENT changed, so — exactly like the v4 dark-disc redraw — a returning
// visitor keeps the old discs forever unless we purge: bumping forces SW-cached devices to re-install, purge the
// stale shell/asset caches, re-precache the current build (whose JS now stamps the new ICON_REV=3 ?v= on the SVG
// URLs, defeating the 1-yr immutable HTTP cache too), and auto-reload once onto it (src/main.tsx).
// v10: ticket #146 again — v9 redrew the South Park topic-art transparent + bumped ICON_REV to 3, but the new
// SVG BYTES never reached prod (the deployed app/ kept serving the FIRST ship's grey-disc files). So every cache —
// the v9 ASSETS cache AND the 1-yr immutable HTTP cache — pinned `…__stan.svg?v=3` to the grey-disc bytes, and the
// member still saw nothing new ("I dont see them"). This deploy actually rebuilds app/topic-art/ with the transparent
// SVGs AND stamps a fresh ICON_REV=4 `?v=` (a url no cache has). Bumping the worker purges the v9 ASSETS cache (so the
// stale `?v=3`→grey-disc entry is evicted), force-reinstalls, re-precaches the current build (the ICON_REV=4 bundle),
// and auto-reloads once (src/main.tsx) — so the transparent characters finally land on already-cached devices.
// v11: ticket #148 — the journal article reader scrambled on phones: a wide data table / display equation
// forced the reading column past the viewport (a flex min-content blowout) so every line of text shifted and
// clipped. The fix is CSS + a render-time table-scroll wrap → new JS/CSS hashes with an otherwise UNCHANGED
// sw.js, i.e. the v5/v7/v8 chunk-only failure mode (SW-cached devices keep serving the pre-fix shell, "still
// same"). Bumping forces a fresh install, purges the stale shell/asset caches, re-precaches the current build,
// and auto-reloads once onto it (src/main.tsx) — so the readable layout lands on already-cached devices.
// v12: ticket #161 — Messages gained sealed video + file attachments (a new t:"file" payload the OLD
// Messages chunk renders as an EMPTY bubble). Chat is peer-to-peer, so build skew is user-visible the moment
// one side updates: bump so already-cached devices install the new chunk instead of showing blank bubbles.
// v13: ticket #162 — the feed gained a collapse toggle for the kind-filter chips (a Feed-chunk-only change,
// the v5/v7/v8 failure mode: new JS hashes, an otherwise unchanged sw.js). The member who asked is on the
// mobile site, exactly where a SW-cached device would keep the pre-fix shell ("still same") — bump so cached
// devices re-install, purge the stale shell/asset caches, and auto-reload once onto the build with the toggle.
// v14: ticket #158 — the Studio create row clipped the gold "Create" button off the right viewport edge on
// phones ≤360px (the title input's intrinsic size=20 min-width won the flex fight). The cure — `min-w-0 flex-1`
// on the input + `shrink-0` on the button — is ALREADY live on prod (verified in real WebKit at 320/360/390px:
// fits; with the old classes reverted it clips exactly as the member's screenshot shows). But it shipped
// chunk-only (new JS hashes, an UNCHANGED sw.js) — the v5/v7/v8/v11/v13 failure mode — so the member's
// SW-cached device still runs the pre-fix NotebookStudio chunk. Bump so cached devices re-install, purge the
// stale shell/asset caches, re-precache the current build, and auto-reload once onto it (src/main.tsx).
// v15: ticket #159 — the bottom tab bar's second slot dropped Create's old sparkle (which read as a leftover
// glyph after #156 centred the A button) for the sidebar-matching Studio book icon. An AppShell-chunk-only
// change — the v5/v7/… failure mode — and the reporter is on a phone, exactly where a SW-cached device keeps
// the pre-fix shell ("still same"). Bump so cached devices re-install, purge the stale shell/asset caches,
// re-precache the current build, and auto-reload once onto it (src/main.tsx).
// v16: ticket #160 — the rebuilt Messages screen (WhatsApp-style sent/received bubbles + per-message
// sent/delivered/read ticks off the aq_chats read watermarks) is complete in SOURCE, but the deployed app/
// build is several ships behind (its Messages chunk predates the receipts; its sw.js is still v11) — so the
// member asking for bubbles + receipts is describing the STALE BUILD, the v10 "bytes never reached prod"
// failure mode. This deploy rebuilds app/ from the current source; bump so SW-cached devices re-install,
// purge the stale shell/asset caches, and auto-reload once onto the receipts build (src/main.tsx). Urgent
// beyond cosmetics: chat is peer-to-peer and the pre-#161 chunk renders newer sealed payload kinds
// (reactions/edits/files) as EMPTY bubbles, so every day of build skew is user-visible in live chats.
// v17: ticket #158 re-queued — the member's phone still clipped the Studio create row's gold "Create"
// button to "Creat" off the right viewport edge: their device was SW-pinned to the PRE-fix NotebookStudio
// chunk (the title input's intrinsic size=20 min-width wins the flex fight and shoves the button out).
// The cure — `min-w-0 flex-1` on the input + `shrink-0` on the button — is in source and verified LIVE on
// prod in real WebKit + Chromium at 320/360/390px (fits everywhere; stripping those classes in-page
// reproduces the member's clip pixel-for-pixel). This ship rebuilds app/ (new chunk hashes with an
// otherwise-unchanged worker = the v5/v7/v8/v11/v13 chunk-only failure mode — the very mechanism that
// stranded this member). Bump so every SW-cached device, theirs included, re-installs, purges the stale
// shell/asset caches, re-precaches the current build, and auto-reloads once onto it (src/main.tsx).
// v18: ticket #159 re-queued — the member's phone still shows the sparkle in the bottom bar's second
// slot. The fix (book/Studio icon, see v15) is in source AND verified live on prod (the served index
// chunk's tab array reads `{href:"/studio/",d:"book"}`), so the report describes a device pinned to a
// PRE-v15 cached shell — the v5/v7/… failure mode; the #160 note found devices as far back as v11 in
// the wild. This ship rebuilds app/ (new chunk hashes, an otherwise-unchanged worker would give cached
// devices no reason to re-install). Bump so every SW-cached device, the reporter's included, re-installs,
// purges the stale shell/asset caches, re-precaches the current build, and auto-reloads once onto it
// (src/main.tsx) — landing the sparkle-less bar on the phones that still show the leftover glyph.
// v19: ticket #160 completed — the WhatsApp-style Messages rebuild (sent/received bubble alignment +
// per-message sent/delivered/read ticks off the aq_chats watermarks) is verified live end-to-end in real
// WebKit (all four tick states walk clock → ✓ → ✓✓ → blue ✓✓ against the prod-identical bundle), and this
// ship adds a guard so a poll racing the send ack can't double a bubble under one id. A Messages-chunk-only
// change — the v5/v7/… failure mode, doubly visible in chat where build skew shows the moment one side
// updates (#161) — so bump: every SW-cached device (including any still pinned to a pre-receipts build,
// which is what the member was describing) re-installs, purges the stale shell/asset caches, re-precaches
// the current build, and auto-reloads once onto it (src/main.tsx).
// v20: ticket #156 — the member wants ArtaBot as the bottom bar's centre button (their /studio screenshot,
// 18:51 UTC 2026-07-16, shows the OLD bar: sparkle/Create raised in the centre, the floating A launcher
// covering the bar's right end). That exact rework IS the current build — BottomTabs centres the A button
// (AppShell.tsx, dispatching `aq:artabot`) and the floating launcher retires on signed-in phones
// (ArtaBot.tsx `max-md:hidden`) — and it's verified LIVE on prod: the served index chunk carries the
// `aq:artabot` centre slot and no sparkle/Create tab, deployed 22:46 UTC — four hours AFTER the member's
// screenshot. So the report predates the fixed deploy and describes a device SW-pinned to the pre-fix
// build — the v5/v7/…/v18 failure mode (chunk hashes change, the worker's bytes don't, pinned devices
// never re-install). Bump so every SW-cached device, the reporter's included, re-installs, purges the
// stale shell/asset caches, re-precaches the current build, and auto-reloads once onto it (src/main.tsx)
// — landing the ArtaBot-centred bar on the phones still showing the sparkle.
// v21: ticket #162 — the member wants the feed's kind-filter chips (All/Playlists/Books/Animations)
// hideable so the "What's happening?" composer is the focus. That exact rework IS the current build —
// Feed.tsx grew a chevron toggle on the title row that collapses the kind-chip row and persists the
// choice device-locally ("aq_feed_kinds", the aq_theme pattern) — and it's verified live on prod: the
// served Feed chunk (Feed-CXQLL_4e.js, deployed 23:27 UTC 2026-07-16) is hash-identical to current
// source, ~31 min AFTER the member's 22:56 screenshot of the old chip row. So the report predates the
// fixed deploy, which was CHUNK-ONLY (new JS hashes, an unchanged v20 worker) — the v5/v7/…/v20
// failure mode: SW-pinned devices, the reporter's included, never re-install. Bump so every SW-cached
// device re-installs, purges the stale shell/asset caches, re-precaches the current build, and
// auto-reloads once onto it (src/main.tsx) — landing the collapsible chips on their phone.
// v22: ticket #158 closed out — the Studio create row's gold "Create" button clipped to "Creat" off the
// right viewport edge on phones (the title input's intrinsic size=20 min-width won the flex fight and
// shoved the button out). The cure (`min-w-0 flex-1` input + `shrink-0` button) is in source AND verified
// live on prod TODAY, end-to-end: the served shell's entry (index-Bz0R7rGf.js) imports
// NotebookStudio-by9amRV1.js which carries both classes, index-DmRJsHfE.css defines them, and the live
// worker (/?aq_sw=1, no-cache) serves navigations network-first — an online device cannot render the old
// row. The member's screenshot predates the fix's deploy (the same evening the v20/v21 notes date their
// reports); prod's worker is still v19 while source is v21, i.e. the last two bumps haven't shipped yet.
// This ship also adds flex-wrap to the row (NotebookStudio.tsx) so even a pathological case (huge
// accessibility font scaling × a long translated "Create") wraps the button below the input instead of
// clipping it. Bump so this deploy is never chunk-only regardless of what lands first, and every
// SW-cached device — the reporter's included, however old its pinned build — re-installs, purges the
// stale shell/asset caches, re-precaches the current build, and auto-reloads once onto it (src/main.tsx).
// v23: ticket #161 (voice + media messages) re-queued — the feature itself is ALREADY live end-to-end
// (prod's Messages-CfwTXJz_.js carries the recorder/players, chat/blob is registered, worker v22 serves
// it), but the SPA had stopped BUILDING: a prior run died mid-land leaving NotebookStudio.tsx reading
// `nb.last_run` that neither NotebookFull nor the backend supplied — tsc failed, so every subsequent
// ticket's build+deploy died and the queue kept re-opening this one. This ship completes the half-landed
// field (owner-only `last_run` in Notebook::view + the type), un-blocking the pipeline, and bumps so the
// deploy is never chunk-only: every SW-cached device re-installs, purges the stale shell/asset caches,
// re-precaches the current build, and auto-reloads once onto it (src/main.tsx).
// v24: ticket #159 closed out — the member's phone still showed the leftover sparkle in the bottom
// bar's second slot beside the newly centred A (their 22:08 screenshot on /studio). The sparkle-less
// bar (book/Studio second slot, ArtaBot centred — the v15/v18/v20 rework) is in source AND verified
// live on prod end-to-end TODAY 2026-07-17: the live worker (/?aq_sw=1) is v23, the served shell's
// entry chunk (index-BLQMWgOF.js) carries `{href:"/studio/",d:"book"}` + the `aq:artabot` centre slot
// and NO sparkle tab, and aq-precache.json names exactly that build. So the report describes a device
// still on the pre-fix build — the screenshot predates the 22:46 UTC 2026-07-16 deploy that landed the
// fix (see v20), and the re-queues came from runs dying mid-land, not a fresh member report. Bump so
// this close-out deploy is never chunk-only (the v5/v7/…/v20 failure mode): every SW-cached device,
// the reporter's included, re-installs, purges the stale shell/asset caches, re-precaches the current
// build, and auto-reloads once onto it (src/main.tsx) — landing the sparkle-less bar on any phone
// still pinned to the leftover glyph.
// v25: ticket #160 closed out — the WhatsApp-style Messages rebuild the member asked for (sent bubbles
// right/blue-tinted, received left/neutral with avatars + grouping tails, and per-message ticks off the
// aq_chats watermarks: clock=sending → ✓ sent → ✓✓ delivered (presence) → blue ✓✓ read) is in source AND
// verified live on prod end-to-end TODAY 2026-07-17: the live worker (/?aq_sw=1) is v24, the served
// shell's entry (index-BLQMWgOF.js) and its Messages chunk (Messages-Ddp4LSwN.js) are BYTE-IDENTICAL to
// what current source builds (cmp'd against a fresh isolated build), tsc is clean, and Chat::messages
// serves the peer_read/peer_online watermarks the ticks read. So the re-queues came from prior runs
// dying before they could report — the v23 pattern — not from a missing or failed fix; the member's
// original ask described a device SW-pinned to a pre-receipts build (the v16 note found devices as far
// back as v11 in the wild). Bump so this close-out deploy is never chunk-only (the v5/v7/…/v20 failure
// mode) and every SW-cached device — the reporter's included, however old its pinned build — re-installs,
// purges the stale shell/asset caches, re-precaches the current build, and auto-reloads once onto it
// (src/main.tsx), landing the bubbles + read receipts on any phone still showing the old Messages screen.
// v26: ticket #156 closed out (re-queued a 4th time) — the member wants ArtaBot as the bottom bar's
// raised centre button instead of the sparkle, with the floating A launcher no longer sitting over the
// bar's right end (their 18:51 UTC 2026-07-16 /studio screenshot shows the OLD bar). That exact rework
// is in source AND byte-proven live on prod end-to-end TODAY 2026-07-17: the live worker (/?aq_sw=1) is
// v25 == source (zero skew), the served shell's entry chunk (index-BLQMWgOF.js) is HASH-IDENTICAL to a
// fresh isolated build of current source and carries BOTH sides of the wiring (the centred `aq:artabot`
// dispatcher with the raised gold/blue circle classes AND ArtaBot.tsx's listener; launcher retired via
// `max-md:hidden`), index-DmRJsHfE.css defines every class the button uses, aq-precache.json names that
// exact build, and tsc -b is clean. So the re-queues came from prior runs dying before they could report
// — the v23/v25 pattern — not from a missing or failed fix; the member's screenshot predates the
// 22:46 UTC 2026-07-16 deploy that landed the centred bar (see v20). Bump so this close-out deploy is
// never chunk-only (the v5/v7/…/v20 failure mode) and every SW-cached device — the reporter's included,
// however old its pinned build — re-installs, purges the stale shell/asset caches, re-precaches the
// current build, and auto-reloads once onto it (src/main.tsx), landing the A-centred bar on any phone
// still showing the sparkle in the centre slot.
// v27: ticket #159 closed out (re-queued a 5th time) — after #156 centred the A, the slot beside Home
// kept Create's old grey sparkle, which the member reports as a leftover glyph to remove (their /studio
// screenshot shows the sparkle in slot 2 NEXT TO the already-centred A — i.e. a device running the
// intermediate build between the two fixes). The fix — slot 2 is the Studio book icon, sparkle gone
// (AppShell.tsx BottomTabs, "Don't bring the sparkle back") — is in source AND verified live on prod
// end-to-end TODAY 2026-07-17: the live registered worker (/?aq_sw=1) is v26 == source (zero skew — the
// exact chunk-only condition that pins devices), the served shell's entry chunk (index-BLQMWgOF.js,
// build 4727bae8f8ee per aq-precache.json) already carries the fixed tab array
// ({href:`/studio/`,d:`book`,label:`Studio`} — no sparkle in the bar), and tsc -b is clean. So the
// re-queues came from prior runs dying before they could report — the v23/v25/v26 pattern — not from a
// missing or failed fix; the member's device is SW-pinned to the pre-#159 precache because the deploy
// that landed the book-icon chunk never changed this file. Bump so this close-out deploy is never
// chunk-only (the v5/v7/…/v20 failure mode) and every SW-cached device — the reporter's included —
// re-installs, purges the stale shell/asset caches, re-precaches the current build, and auto-reloads
// once onto it (src/main.tsx), landing the sparkle-less bar (Home · Studio book · A · Messages ·
// Profile) on any phone still showing the leftover glyph.
// v28: ticket #160 closed out (re-queued a 5th time) — WhatsApp-style chat bubbles + read receipts in
// Messages. The FULL feature is in source (Messages.tsx: mine/theirs bubble alignment with grouped
// tails, and the Ticks component — clock=sending · ✓=sent · ✓✓=delivered · blue ✓✓=read off the
// a_read/b_read watermark + presence-derived deliveredTo) AND verified live on prod end-to-end TODAY
// 2026-07-17: the served shell's entry chunk index-BLQMWgOF.js is HASH-IDENTICAL to a fresh isolated
// build of current source and names Messages-Ddp4LSwN.js, which byte-carries the feature ("Delivered"/
// "Sending"/double-tick paths); the backend watermarks are live (public DB explorer shows wp_aq_chats
// with a_read/b_read populated); aq-precache.json names build 4727bae8f8ee; tsc -b is clean. So the
// re-queues came from prior runs dying before they could report — the v23/v25/v26 pattern — not from a
// missing or failed fix. Crucially the v27 bump above was committed but NEVER DEPLOYED (the live
// registered worker is still v26), so every device whose SW installed before the bubbles chunk landed
// is STILL pinned to a pre-bubbles precache — the exact chunk-only condition v27's own comment warns
// about, and why the member reports the feature as absent. Bump again so THIS close-out deploy is
// never chunk-only regardless of v27's fate: every SW-cached device — the reporter's included —
// re-installs, purges the stale shell/asset caches, re-precaches the current build, and auto-reloads
// once onto it (src/main.tsx), landing the bubbled Messages screen with per-message ticks.
// v29: ticket #161 closed out (re-queued again; 3 prior runs died before reporting) — voice notes +
// media (photos/video/files) in Messages, WhatsApp-style with inline playback and previews. The FULL
// feature is in source (Messages.tsx: VoiceButton mic⇄send swap with MediaRecorder + tap-to-send/×-discard;
// paperclip/paste/drag-drop → sendFile seals per-attachment keys, 6 MB cap; Media renders img→lightbox,
// video→inline player, audio/voice→player with duration, else→download chip; e2ee.ts v2 payloads
// img/voice/file; Chat::blob with size+day quotas and unlink on unsend/expiry) AND byte-proven live on
// prod end-to-end TODAY 2026-07-17: the live registered worker (/?aq_sw=1) is v28 == source (zero skew),
// the served shell's entry chunk (index-BLQMWgOF.js) AND its Messages chunk (Messages-Ddp4LSwN.js) are
// HASH-IDENTICAL to a fresh isolated build of current source (the Messages chunk byte-carries the
// recorder/getUserMedia/"Video message" paths), POST /wp-json/aq/v1/chat/blob answers 401 (registered,
// auth-gated — not 404), index-DmRJsHfE.css resolves, and tsc -b is clean. So the re-queues came from
// prior runs dying before they could report — the v23/v25/v26/v27/v28 pattern — not from a missing or
// failed fix (v12 shipped the attachment kinds; v23 documents the one real blocker, another run's
// orphaned tsc break, long since repaired). Bump so this close-out deploy is never chunk-only (the
// v5/v7/…/v20 failure mode) — chat makes build skew uniquely member-visible (the v12/v16 notes: a device
// pinned to a pre-attachment Messages chunk renders a peer's t:"voice"/"file" payloads as EMPTY bubbles,
// i.e. exactly "media messages don't work") — so every SW-cached device, the reporter's included,
// re-installs, purges the stale shell/asset caches, re-precaches the current build, and auto-reloads
// once onto it (src/main.tsx), landing the recorder + inline media on any phone still showing blanks.
// v30: ticket #162 closed out (re-queued; 3 prior runs died before reporting) — the member wants the
// mobile home feed's kind-filter chips (All/Playlists/Books/Animations) HIDEABLE so the "What's
// happening?" composer is the focus. That exact rework is in source AND byte-proven live on prod
// end-to-end TODAY 2026-07-17: Feed.tsx grew an aria-labelled chevron toggle on the title row that
// collapses the kind-chip row (composer sits right under the title) and persists the choice
// device-locally ("aq_feed_kinds", the aq_theme pattern, never the public DB); the live registered
// worker (/?aq_sw=1) is v29 == source (zero skew), and the served Feed chunk (Feed-COlfAXMV.js, named
// by aq-precache.json's build 4727bae8f8ee) byte-carries the feature ("aq_feed_kinds" + the "Hide kind
// filters"/"Show kind filters" labels). So the re-queues came from prior runs dying before they could
// report — the v23/v25/v26/v27/v28/v29 pattern — not from a missing or failed fix; the member's 22:56
// screenshot of the old chip row predates the deploy that landed the toggle. Bump so this close-out
// deploy is never chunk-only (the v5/v7/…/v20 failure mode) and every SW-cached device — the
// reporter's included, however old its pinned build — re-installs, purges the stale shell/asset caches,
// re-precaches the current build, and auto-reloads once onto it (src/main.tsx), landing the
// collapsible kind chips on any phone still showing the fixed chip row.
// v31: ticket #158 closed out (re-queued a 5th time) — on /studio the gold "Create" button beside
// the working-title input clipped off the right viewport edge on phones, showing only "Creat". The
// fix — CreateForm's row is `flex flex-wrap gap-2`, the title input `min-w-0 flex-1` (so it shrinks
// below its intrinsic size=20 width instead of shoving the button out), the button `shrink-0` (keeps
// its natural width; wraps below only in a pathological font-scale × long-translation case) — is in
// source (NotebookStudio.tsx) AND byte-proven live on prod end-to-end TODAY 2026-07-17: the served
// chunk NotebookStudio-B2Cv7ZAS.js (named by aq-precache.json, on live worker v28) carries all three
// (`min-w-0 flex-1` input + `shrink-0` button + `flex flex-wrap gap-2` row), and the no-cache worker
// serves navigations network-first, so an online device cannot render the old clipping row. So the
// re-queues came from prior runs dying before they could report — the v23–v30 pattern — not a missing
// or failed fix; the member's screenshot predates the fix's deploy (source is 2 bumps ahead of the
// live v28 worker: the last close-outs haven't shipped yet). Bump so this deploy is never chunk-only
// (the v5/v7/…/v20 failure mode that strands SW-pinned devices) and every SW-cached device — the
// reporter's included, however old its pinned build — re-installs, purges the stale shell/asset
// caches, re-precaches the current build, and auto-reloads once onto it (src/main.tsx), landing the
// fully-visible Create button on any phone still clipping it to "Creat".
// v32: ticket #161 (voice + media messages) re-queued a 4th time — closed out. The WhatsApp-style
// feature is COMPLETE in source and byte-proven live on prod end-to-end TODAY 2026-07-17:
// Messages.tsx has the VoiceButton (mic⇄send swap, MediaRecorder + getUserMedia, tap-to-send /
// ×-discard, live mm:ss timer) and the Media renderer (image→lightbox, video/audio→inline players
// with duration, else→download chip); sendFile seals a per-attachment AES-GCM key, enforces the 6 MB
// cap, uploads via chat/blob and sends a v2 img/voice/file payload (paperclip + paste + drag-drop
// wired); e2ee.ts carries the t:"voice"/"img"/"file" union; Chat::blob is registered (POST answers
// 401, not 404) with size+day quotas and unlink on unsend/expiry. Proof: a fresh isolated `vite
// build` emits Messages-nq6V6Ghg.js — the SAME hash aq-precache.json names and the live worker
// (/?aq_sw=1, v30) serves — and tsc -b + vite build are both clean. So the re-queues came from prior
// runs dying before they could report (the v23/v25/v26/v27/v28/v29/v30/v31 pattern), not a missing or
// failed fix. Bump so this close-out deploy is never chunk-only (the v5/v7/…/v20 failure mode) — chat
// is peer-to-peer, so a device SW-pinned to a pre-attachment Messages chunk renders a peer's
// t:"voice"/t:"file" as an EMPTY bubble (exactly "media messages don't work"): every SW-cached
// device, however old its pinned build, re-installs, purges the stale shell/asset caches, re-precaches
// the current build, and auto-reloads once onto it (src/main.tsx), landing the recorder + inline media
// on any phone still showing blank bubbles.
// v33: ticket #156 closed out (re-queued a 5th time) — the member wants ArtaBot as the bottom
// bar's raised centre button instead of the sparkle, with the floating A launcher no longer
// sitting over the bar's right end (their 18:51 UTC 2026-07-16 /studio screenshot shows the OLD
// bar: sparkle/Create raised centre, the floating A covering the bar's right end). That exact
// rework is in source AND byte-proven live on prod end-to-end TODAY 2026-07-17: a fresh isolated
// `vite build` of current source emits index-Cy_XieEd.js, which is BYTE-IDENTICAL (cmp) to the
// entry chunk prod serves, and that deployed chunk carries BOTH the centred `aq:artabot` dispatcher
// (BottomTabs' raised gold/blue circle) AND the "Quick navigation" bar with NO sparkle/Create tab;
// ArtaBot.tsx retires the floating launcher on signed-in phones (`max-md:hidden`); tsc -b + the full
// build pipeline (contrast-ramp/topic-art/chart-layout checks + vite build) are all clean. So the
// re-queues came from prior runs dying before they could report — NOT a missing or failed fix; the
// member's screenshot predates the deploy that landed the centred bar (see v20). The one real blocker
// is the chunk-only failure mode: the live registered worker (/?aq_sw=1) is v32 == source (ZERO skew),
// so a device that precached a pre-#156 build has no reason to re-install and stays pinned to the
// sparkle bar — and the earlier #156 close-out bumps (v20, v26) were committed but NEVER DEPLOYED
// (v28 documents this: runs kept dying mid-land). Bump so THIS close-out deploy is never chunk-only:
// every SW-cached device — the reporter's included, however old its pinned build — re-installs, purges
// the stale shell/asset caches, re-precaches the current build (the Cy_XieEd bundle with the fix), and
// auto-reloads once onto it (src/main.tsx), landing the ArtaBot-centred bar on any phone still showing
// the sparkle in the centre slot.
// v34: the ArtaTTS paragraph + on-device-only pivot (2026-07-21) shipped as chunk-only deploys — the
// v5/v7/… failure mode again: SW-cached devices kept the retired cloud-tier reader (its info panel now
// dead-ends on "Could not load cloud pricing", the endpoint no longer exists). Bump so every cached
// device re-installs, purges the stale shell/asset caches, re-precaches the current build, and
// auto-reloads once onto the paragraph-band Kokoro-only reader (with the model download bar).
// v35: MULTILINGUAL reader (es/fr/hi/it/pt-BR + Farsi beta via the full espeak-ng pack at the app
// root) + the on-device NLLB translator (translate → show → speak) + the 510-token truncation fix
// (long paragraphs no longer cut off halfway). Chunk-only otherwise — bump so cached devices land it.
// v36: the translator is PINNED TO WASM (WebGPU seq2seq decode = token salad); v35 devices that
// installed during the ~30-min window got the broken-translator build — chunk-only fix, so bump.
// v37: Farsi voices moved to NATIVE Iranian-Persian Piper fa_IR VITS (the Hindi-style hack read with
// a Dari accent — operator); translation numerals masked verbatim + sentence-level chunking. Chunk-only.
// v38: download resilience — the operator's device hit a transient drop mid voice-pack fetch and the
// reader gave up with a generic error; cachedFetch now retries ×3 and the note says retry resumes
// from cache. Chunk-only — bump so cached devices land it.
// v39: ArtaRead — /artaread reads ANY uploaded PDF on-device (pdf.js) through the shared ReadMode
// (theme/ArtaContrast/Aa/ArtaTTS/translator). New route + chunks — bump to land it everywhere.
// v40: ArtaRead extracts MEDIA — figures cropped to sanitized data URIs + Florence-2 on-device alt
// text (weights mirrored on the platform: the HF xet CDN kills big fetches mid-stream); equations +
// tables rebuilt as currentColor SVG (theme/contrast-aware, selectable). Chunk-only — bump.
// v41: captioner phase marks + surfaced per-figure errors (support debuggability). Chunk-only.
// v42: ArtaRead media REWRITE — figures/equations/tables are now PIXEL-TRUE crops of the rendered
// page (glyph reconstruction mangled vector strokes); heavy models (Florence/NLLB) gated by device
// memory so they never OOM-crash; line-art crops invert in dark mode. Chunk-only — bump.
// v43: ArtaRead v4 — 2-column layout perfected (gutter-centred item partition, band reading order),
// PAGE-BY-PAGE streaming conversion (reader opens on page 1), and PDF→LaTeX: texify2 on-device
// equation OCR → live KaTeX + a compilable main.tex+figures zip download. Chunk-only — bump.
// v44: equation extraction quality — per-side gutter-split rule (an equation next to prose no longer
// swallows the other column), subscript/limit fragment rows absorbed fore+aft into the equation run
// (narrower-than-run containment; prose never eaten), clamp skips absorbed rows. Chunk-only — bump.
// v45: PDF→LaTeX tables — \begin{tabular} rebuilt POSITIONALLY (cell x-centres clustered into
// columns, ragged/merged rows realigned) instead of a naive per-row count; verified Table 1 of the
// OSU paper + all 7 arXiv tables reconstruct and compile. Chunk-only — bump.
// v46: memory safety — texify2 (~1.5 GB) is DISPOSED after equation OCR, before the Florence
// captioner (~1.8 GB) loads, so only one heavy model is resident at a time (cached weights make the
// later re-init fast). Honours the operator's "don't crash the system" directive. Chunk-only — bump.
// v47: ArtaRead is a BOOK — two-page spread with a 3D page-flip (desktop) / single leaf with a folded
// far edge (mobile), themed reflowed leaves (dark/light + ArtaContrast + Aa), only the visible spread
// + next processed (lazy openPdf), RTL books mirror, position survives rotation; scroll view stays as
// a toggle (with the LaTeX export + equation OCR). Chunk-only — bump.
// v48: the book feels REAL — DRAG a page edge to turn it (pointer-driven angle, release past 35%
// completes, else springs back), TRUE recto/verso (page 1 opens as a right-hand page), a page-jump
// slider, and resume-where-you-left (position persists per document). Chunk-only — bump.
// v49: REAL TYPESETTING (BookFlow) — no scrolling inside a page, ever: content is paginated into
// fixed leaves and a paragraph SPLITS at the exact word where the page ends (book pages ≠ PDF
// pages, like print); re-typesets on font/rotation keeping your place by block address; LISTEN in
// the book (reads itself, turns its own pages, voices + on-device translation); smooth accurate
// loaders for opening, typesetting and model downloads. Chunk-only — bump.
// v50: typesetting FITS — every page now fits with no clipping (a heading + oversized paragraph like
// References paginates; short blocks that don't fit the remaining space seal to a fresh leaf; crops
// capped to the leaf height; measure a full line shy of the leaf for render drift) + equations render
// as consistent legible cards (not the inverted black boxes). Chunk-only — bump.
// v51: CRISP NATIVE EQUATIONS in the book — texify2 OCRs every equation crop on-device → LaTeX →
// static KaTeX, then the book re-typesets with theme-native, scalable equations (no more blurry
// image cards). Runs once in the background, memory-gated, fails soft to crops; a "Sharpening
// equations" indicator shows progress. Chunk-only — bump.
// v59: NATIONALITY (2026-08-18) — the profile shows the member's flag after their date of birth,
// the header stops squeezing the name to one character beside the action buttons and never
// truncates a name, sign-up asks a nationality (defaulted from the visitor's country), and Donate
// aims a gift at a nationality instead of a gender. Two chunk-only deploys (theme 1.8.127/128) with
// an UNCHANGED sw.js — the v5/v7/… failure mode: the operator's own SW-cached browser kept the
// pre-fix Profile chunk (ellipsis in the name, "Book me" clipped, no flag) an hour after production
// was executing the fix. Bump so cached devices re-install, purge the stale shell/asset caches,
// re-precache the current build, and auto-reload once onto it (src/main.tsx).
// v60: the profile's action buttons sit at the right and the flag chip is smaller (operator
// 2026-08-18) — chunk-only again, so bump for SW-cached devices.
// v61: the profile header's standing line and buttons share a row, the flip hint moved to the
// avatar's bottom-left, social links right, the left rail reads like X (bold current row, no fill,
// 17px, no hairline) with a smaller "Create", and the top bar lost its hairline (operator
// 2026-08-18) — chunk-only, so bump for SW-cached devices.
// v62: the gold→blue hairline under the top bar (operator 2026-08-18) — chunk-only, bump.
// v63: the profile banner is member-set (Add/Change/Remove cover on your own profile), the social
// links and "Speaks" leave the profile page, facts read Born → Lives in → Relationship (operator
// 2026-08-18) — new chunk + a plugin route, bump for SW-cached devices.
// v64: ONE footer, pinned under the right column on every page (operator 2026-08-19) — chunk-only, bump.
// v65: /about is laid out by CONTAINER queries, so the founder's note stops rendering five words to
// a line inside the shell's ~614px card, and the rail's foot sits at the bottom of the column
// instead of the top of an empty one (operator 2026-08-21) — chunk-only, bump.
// v66: /about opens with the founder, and his picture is a ringed link to his profile (operator
// 2026-08-21) — chunk-only, bump.
// v67: /sponsors is a list, not a 760px-wide table crammed into a 410px column (operator
// 2026-08-21, "the sponsors page is messed up … the table specially") — chunk-only, bump.
// v68: the layout sweep — /reserve, /wallet, /data, /faq-contact, /donate, /finances, /studio,
// /topics and the notebook step rail stop splitting themselves on VIEWPORT breakpoints inside the
// shell's ~410px column (operator 2026-08-21) — chunk-only, bump.
// v69: the last two pages of the layout sweep — /user-account's stat tiles, identity form and ID
// previews, and /topics' forecast table and facts row (operator 2026-08-21) — chunk-only, bump.
const VERSION = "aq-sw-v69";
const SHELL = "aq-shell-v42";   // last good app-shell HTML (any route boots the SPA offline)
const ASSETS = "aq-assets-v42"; // hashed JS/CSS from the theme's app/ build dir
const IMG = "aq-img-v4";
// Oldest-first cap on the image cache. Cache Storage keys() returns insertion order, so dropping
// from the front is a true FIFO — good enough, and far better than unbounded.
const IMG_MAX = 300;
async function trimCache(cache, max) {
  try {
    const keys = await cache.keys();
    if (keys.length <= max) return;
    for (const k of keys.slice(0, keys.length - max)) await cache.delete(k);
  } catch { /* quota/racing eviction — never let housekeeping break a response */ }
}       // course thumbnails, avatars (incl. cross-origin, opaque) — unchanged, keep them
const KEEP = [SHELL, ASSETS, IMG];
// v52: MY LIBRARY (/my-library) — the member's own music, videos and PDFs, imported to this
// device (IndexedDB, atomic per file) and played offline: queue + shuffle/repeat, a persistent
// mini-player with lock-screen/headphone controls, video lightbox with PiP, PDFs open in the
// book reader. Nothing uploads. New route chunk — MUST bump so offline devices fetch it.
// v53: figures EMBED — every crop's background is removed at extraction (flood-fill for
// photos, a tight global colour key for charts whose plot area is fenced in by its axes), so a
// figure sits ON the page instead of in a coloured box; dark-mode flip is now decided by how much
// of the surviving ink is dark, so axis labels stay legible. Equations: KaTeX renders with
// throwOnError so a bad OCR keeps its crop instead of printing RED SOURCE, \mbox/\bm/… are
// shimmed, and only one \tag survives per expression (KaTeX rejects two).
// v54: ArtaCloud — My Library gains an OPTIONAL public cloud shelf. Private stays the default
// (browser storage, never uploaded); publishing is per-file, confirmed, and stated plainly as making
// the file public. Resumable chunked upload, storage meter, and capacity bought with ArtaCoin
// (100 MB free, 100 MB per coin). Served from Cloudflare R2 once its keys are in the Vault.
// v55: POCKET PLAYBACK — the player is mounted once in AppShell instead of inside the My
// Library page, so navigating no longer unmounts it and the music keeps going; plus Media Session
// setPositionState (live, draggable lock-screen scrubber) and playbackState (correct play/pause
// icon on the lock screen and car head units).
// v56: CONTINUE — one resume position per item (music, video, PDF), so a long listen or read
// picks up where it stopped; a Continue shelf at the top of My Library; local playlists; and a
// copy-public-link action on published items.

const APP_DIR = "/wp-content/themes/artaquest-theme/app/";
// HTML navigations that must NEVER become the cached app shell: they don't boot the SPA, so
// caching one would make every offline navigation land on wp-login / a feed instead of the app.
// `content` is in this list as a second line of defence behind the /wp-content/uploads/ bail-out in
// the fetch handler: a published file opened directly is an HTML-accepting navigation, and it must
// never be mistaken for the app shell.
const NON_SPA = /^\/wp-(admin|login|signup|cron|sitemap|content)|^\/xmlrpc|\/(feed|embed)\/?$/;

self.addEventListener("install", (e) => {
  // Pre-cache the app shell AND the whole built app immediately, so even the very first offline
  // cold-load (a full page reload with no network) boots the SPA on ANY route — React then serves
  // the learning data from IndexedDB. This runs independently of the page's own auto-precache
  // (src/main.tsx) so offline works even if the page never reaches its idle callback.
  e.waitUntil(
    (async () => {
      try {
        const c = await caches.open(SHELL);
        const r = await fetch("/", { credentials: "include" });
        if (r && r.ok) await c.put("shell", r.clone());
      } catch { /* offline at install — the first online navigation will populate it */ }
      await precacheApp(); // best-effort: cache every route chunk so all pages open offline
    })(),
  );
  self.skipWaiting();
});

// Precache the entire built app (all route chunks + CSS + fonts) from the build manifest into a
// build-versioned cache the asset handler already reads. Idempotent + cheap (skips files already
// present, prunes older builds). Shared cache-name scheme with the Download Center so the two never
// duplicate work. Best-effort — any failure just means a route may need the network until next load.
async function precacheApp() {
  try {
    const r = await fetch(APP_DIR + "aq-precache.json", { cache: "no-cache" });
    if (!r || !r.ok) return;
    const m = await r.json();
    const cacheName = "aq-app-" + m.build;
    const c = await caches.open(cacheName);
    // Cache the shell under '/' too, so a cold offline navigation has a same-build shell to boot from.
    try { const sh = await fetch("/", { credentials: "include" }); if (sh && sh.ok) await c.put("/", sh.clone()); } catch { /* offline */ }
    const have = new Set((await c.keys()).map((req) => new URL(req.url).pathname));
    // ORDER, then CONCURRENCY. The manifest is alphabetical, so this fetched About-*.js first and
    // reached the entry bundle — the one file without which nothing boots — somewhere in the middle
    // of 377. And it awaited each fetch in turn: on a 200 ms link that is over a minute of round
    // trips before any of it is useful, and a member who loses the connection part-way (the exact
    // member this feature exists for) was left holding an alphabetical prefix.
    //
    // Same files, same total, policy unchanged. Boot path first, so the app is offline-capable in
    // seconds; the optional runtimes (speech, ONNX, PDF, KaTeX — about a third of the bytes) last,
    // so an interrupted precache loses the part nobody needs in order to open a page.
    const weight = (u) => {
      const n = u.slice(u.lastIndexOf("/") + 1);
      if (/^index-.*\.css$/.test(n)) return 0;                              // first paint
      if (/^index-.*\.js$/.test(n)) return 1;                               // boot
      if (/\.(woff2?|ttf|otf)$/.test(n)) return 2;                          // text, without a reflow
      if (/(kokoro|transformers|ort\.|onnx|pdf-|katex)/.test(n)) return 4;   // optional runtimes
      return 3;                                                             // route chunks
    };
    const todo = (m.files || []).filter((u) => !have.has(u)).sort((a, b) => weight(a) - weight(b));
    // A small window: enough to hide latency, few enough that precaching never competes with
    // whatever the member is actually doing on the page.
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
      for (;;) {
        const k = next++;
        if (k >= todo.length) return;
        try { const f = await fetch(todo[k], { cache: "reload" }); if (f && f.ok) await c.put(todo[k], f.clone()); } catch { /* a missing chunk just won't be offline */ }
      }
    }));
    // Drop older app precaches to reclaim space.
    for (const k of await caches.keys()) { if (k.startsWith("aq-app-") && k !== cacheName) await caches.delete(k); }
  } catch { /* manifest unreachable — page-driven precache will cover it */ }
}

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) {
        // Keep our runtime caches AND the full-app precache (aq-app-*, versioned + pruned by the
        // Download Center itself) AND downloaded images. Only sweep stray old runtime caches.
        if (!KEEP.includes(k) && k.startsWith("aq-") && !k.startsWith("aq-app-")) await caches.delete(k);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

function isNavigation(req) {
  return req.mode === "navigate" || (req.method === "GET" && (req.headers.get("accept") || "").includes("text/html"));
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept the API — the app's offline layer owns data (and personal data must not be cached here).
  if (url.pathname.includes("/wp-json/")) return;

  // Never intercept uploads either. Published media now lives on THIS origin (Media::ORIGIN_SERVABLE)
  // instead of the CDN, which silently pulled every member-submitted file into this worker's scope
  // for the first time. Opening one directly is an HTML-accepting navigation, so without this the
  // shell branch below would cache that file's bytes as the canonical app shell and every later
  // offline cold launch would boot into it instead of ArtaQuest — bricking the offline app from one
  // ordinary "open the file" click. The origin's own byte cache serves these perfectly well.
  if (url.pathname.startsWith("/wp-content/uploads/")) return;

  // App shell (HTML navigations): network-first, cache the latest, fall back to it offline.
  if (isNavigation(req)) {
    e.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Only SPA-template pages may refresh the canonical shell — wp-admin/login, feeds and
          // embeds are real HTML navigations too, and caching one would boot the app into that
          // page on every offline launch.
          if (fresh && fresh.ok && !NON_SPA.test(url.pathname)) {
            const c = await caches.open(SHELL);
            c.put("shell", fresh.clone()); // single canonical shell — any route boots the SPA
          }
          return fresh;
        } catch {
          // Offline: any cached shell boots the SPA, which then routes client-side + reads IndexedDB.
          const shell = await caches.open(SHELL);
          return (
            (await shell.match("shell")) ||
            (await caches.match("/")) ||      // the Download Center caches '/' into the app precache
            (await caches.match(req)) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  // The precache manifest is the ONE mutable file under app/ — it names the CURRENT build's
  // files. It must be network-FIRST: served cache-first it pins the previous build after a
  // deploy, so appFilesStatus() sees the old build's cache as "complete", "Download app for
  // offline" no-ops, and offline navigation then dies on a missing new-build chunk ("This page
  // isn't available offline yet" — ticket #26). Fresh copy is kept only as the offline fallback.
  if (url.origin === self.location.origin && url.pathname === APP_DIR + "aq-precache.json") {
    e.respondWith(
      (async () => {
        try {
          const r = await fetch(req, { cache: "no-cache" });
          if (r && r.ok) { const c = await caches.open(ASSETS); c.put(req, r.clone()); }
          return r;
        } catch {
          return (await caches.match(req)) || Response.error();
        }
      })(),
    );
    return;
  }

  // Build assets (hashed → immutable). Cache-FIRST across ALL caches, so the full-app precache
  // (aq-app-<build>, populated by the Download Center for full offline self-sufficiency) is used
  // even for routes the user never visited online. Falls back to network → runtime cache.
  if (url.origin === self.location.origin && url.pathname.startsWith(APP_DIR)) {
    e.respondWith(
      (async () => {
        const hit = await caches.match(req); // checks aq-app-*, aq-assets-*, …
        if (hit) return hit;
        try {
          const r = await fetch(req);
          if (r && r.ok) { const c = await caches.open(ASSETS); c.put(req, r.clone()); }
          return r;
        } catch {
          return Response.error();
        }
      })(),
    );
    return;
  }

  // Images (incl. cross-origin thumbnails/avatars): cache-first, and BOUNDED.
  //
  // This cache was uncapped, which was survivable while it held avatars and course thumbnails. The
  // Library changed that: published images now come from the media CDN, cross-origin, so every one
  // is stored as an OPAQUE response — and an opaque response is charged against the origin's quota
  // with heavy padding (browsers commonly count ~7 MB for a small file). A member who scrolls a
  // feed of published art would silently fill their quota and start evicting the app shell itself.
  if (req.destination === "image") {
    e.respondWith(
      (async () => {
        const c = await caches.open(IMG);
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const r = await fetch(req);
          if (r && (r.ok || r.type === "opaque")) {
            await c.put(req, r.clone());
            trimCache(c, IMG_MAX);   // fire-and-forget; never blocks the response
          }
          return r;
        } catch {
          return hit || Response.error();
        }
      })(),
    );
  }
});
