# FINORA — PWA / Offline Notes

## Files added
- `manifest.json` — installability, icons, theme/background color, standalone display
- `service-worker.js` — caching + offline fallback + background sync for the AI proxy
- `offline.html` — shown only if a page navigation fails *and* nothing is cached yet
- `icons/icon-192.png`, `icons/icon-512.png` — home-screen/app icons (regenerated from the FINORA mark already embedded in `index.html`'s favicon)
- `icons/icon-192-maskable.png`, `icons/icon-512-maskable.png` — safe-zone padded versions so Android's adaptive-icon shapes don't crop the mark

## Files modified
None. `index.html` already had the manifest link, icon links, service-worker registration, an IndexedDB (`WDP_IDB`) queue/cache layer, and online/offline UI toasts wired up — it was just missing the actual `manifest.json` / `service-worker.js` / `icons/*` files it points to. This service worker's IndexedDB schema (`wdp-offline-db`, stores `wdp_sync_queue` / `wdp_data_cache`) and message protocol (`wdp-flush-queue`, `wdp-request-queued`, `wdp-sync-complete`) match what `index.html` already expects, so no page-side changes were needed.

## How offline mode works
- All app data (banks, daily transactions, site custody, savings, etc.) already lives in `localStorage` on the device — there's no backend for this data, so it was already 100% offline-capable before this change.
- On first successful load, the service worker precaches the app shell (`index.html`, `manifest.json`, `offline.html`, icons). Every reload after that is served from cache first for navigations that are online-but-slow, and served from cache only when offline.
- Same-origin static assets (e.g. `assets/brands/*.svg` brand logos) are cache-first and get cached the first time they're used.
- Google Fonts use stale-while-revalidate; the `xlsx` export library (cdnjs) is cache-first; FX/gold rate lookups are network-first with a cache fallback — matching how `index.html` already treats them (best-effort, already degrades gracefully in the UI).
- `offline.html` only appears if someone navigates to a URL that was never cached *and* they're offline — normal reloads of the app itself never hit it.

## How synchronization works
- The only real "mutation" traffic is POST requests to your AI proxy worker (`AI_PROXY_URL` in `index.html`) — used for receipt scanning, AI Quick Entry, and AI insights.
- If a POST fails because the device is offline, the service worker stores it in IndexedDB (`wdp_sync_queue`) and returns a `202 {queued:true}` response instead of letting it error out. It also messages the page (`wdp-request-queued`) so the existing toast ("Saved offline — will retry automatically...") fires.
- On reconnect, Chrome/Edge/Android fire Background Sync automatically; Safari doesn't support that API, so `index.html`'s own `online` event listener explicitly asks the worker to flush (`wdp-flush-queue`) as a fallback — both paths call the same flush logic.
- Queued requests are retried in order; on success the page gets `wdp-sync-complete` (existing "✓ Synced" toast). If still offline, the flush stops after the first failure and retries next time, so items don't get silently dropped or reordered.

## How to test offline functionality
1. Load the app once over a real connection (required for the first precache).
2. Chrome DevTools → Application tab → confirm `service-worker.js` shows "activated and is running", and Cache Storage shows `finora-shell-v1`.
3. DevTools → Network tab → set to "Offline" (or Application → Service Workers → check "Offline").
4. Reload — app should load instantly with no browser error page.
5. Use the app normally (add a transaction, switch months, etc.) — everything works since it's all `localStorage`.
6. If you use AI Quick Entry while offline, confirm the "Saved offline" toast appears.
7. Go back online — confirm the "Back online — syncing…" and "✓ Synced" toasts appear and the queued AI request actually goes through (check Application → IndexedDB → `wdp-offline-db` → `wdp_sync_queue` is empty afterward).
8. Test "Add to Home Screen" on Android and "Add to Home Screen" via Safari's Share sheet on iOS — confirm it launches in standalone mode (no browser chrome).
9. Refresh multiple times while offline to confirm nothing regresses.

## Limitations
- Safari/iOS has no Background Sync API — the reconnect flush there depends on the app tab actually being open when connectivity returns (already handled via the `online` listener), not a true background retry while the app is fully closed.
- The AI proxy calls themselves obviously can't produce a result while offline — they're queued and retried, not answered locally.
- `assets/brands/*.svg` brand logos only get cached opportunistically (the ones actually viewed) — a brand logo never seen while online won't render offline the first time it's needed. This matches the existing behavior of that feature (it already has multi-candidate fallback + graceful failure).
- Deploy `manifest.json`, `service-worker.js`, `offline.html`, and `icons/` at the same path level as `index.html` (i.e. next to it, not in a subfolder) since the registration and manifest links use relative paths.
