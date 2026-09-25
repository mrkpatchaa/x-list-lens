# ListLens for X

A Chrome extension that shows, inline on X/Twitter, which of **your** Lists each account belongs to.

Every account you come across gets a small list badge next to its handle. Hover, focus, or tap it to see the list names. Badges appear on timeline posts, profile headers, and user cells (followers, search results, and “who to follow”).

---

## How it works

X has no public API for reading your Lists, so ListLens reads them the same way the X web app does — by calling X’s internal GraphQL endpoints with your existing browser session.

Those endpoints are versioned by an opaque query ID that changes whenever X ships a new build, so the IDs can’t be hardcoded. Instead, the extension watches X make the calls itself and learns the current IDs. That is why there is a one-time setup step.

Four pieces run in separate extension contexts:

| File | Context | Job |
|---|---|---|
| `src/intercept.ts` | page (MAIN world) | Observes `fetch`/`XHR` to learn GraphQL query IDs and notice successful list add/remove operations |
| `src/content.ts` | content script | Validates the page bridge and paints accessible badges |
| `src/background.ts` | service worker | Calls X’s API, paginates safely, coordinates sync work, and commits the local cache |
| `src/popup.ts` | popup | Setup guidance, progress, recovery, and sync status |
| `src/x-api.ts` | shared parser | Strictly validates GraphQL responses before they can affect the cache |
| `src/shared.ts` | all extension contexts | Message names, storage keys, and persisted types |

`intercept.ts` deliberately has **no runtime imports**. A content script with imports gets wrapped in an async dynamic-import loader, which would leave `window.fetch` unpatched during early page load. It uses a type-only import so the build still fails if the message names drift.

### Syncing

- **Full sync** — triggered from the popup. Walks every list and every page of members. It stages the complete result and commits the cache, names, and sync timestamp together only after everything succeeds.
- **Targeted sync** — automatic. When you add or remove someone from a list in the X UI, the interceptor notices only after the request and GraphQL response succeed, then the service worker re-reads that list.
- **Durable recovery** — changed-list work is persisted, and an interrupted service-worker sync is reported as interrupted instead of leaving the popup stuck on “Running.” The previous cache remains available.
- **Safe cancellation** — cancellation is persisted while a sync is running. Stopping leaves the previous cache intact.

There is no scheduled background sync. The extension only talks to X when you ask it to, or right after you change a list yourself.

### Where your data lives

Everything stays in `chrome.storage.local` on your machine. Nothing is sent anywhere except to x.com, using the session cookies your browser already has. The cache maps a lowercased handle to a set of **list IDs**; names are resolved at render time from a separate ID→name map.

---

## Install

Requires Node `^20.19.0` or `>=22.12.0`.

```bash
npm install
npm test
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

For development with hot reload, use `npm run dev` instead of `npm run build`.

## First run

The extension needs to observe two different X requests before it can sync:

1. Open your Lists page.
2. Open any one list from that page.

The popup shows which setup step is still missing. If X changes its internal request format, the popup preserves the previous cache and offers a Reconnect action instead of silently replacing your badges.

After setup, hit **Sync lists**. A full sync can take a few minutes for large lists; progress and the list currently being read are shown, and you can stop it at any point.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Holding the list cache and small sync recovery state locally |
| `cookies` | Reading the `ct0` CSRF token so X accepts API calls |
| `*://*.x.com/*`, `*://*.twitter.com/*` | Running the content script and calling X’s API |

## Known limitations

- **It depends on X’s internals.** The GraphQL payload shape, `data-testid` attributes used to find handles, and the public web bearer token are X implementation details. The parser fails closed when it no longer recognizes a response, but a large enough X redesign will still require an update.
- **The cache goes stale.** Changes made from another device or the mobile app won’t show until you re-sync. The popup nudges you after a week.
- **Large lists are expensive to re-read.** A targeted sync re-reads the whole list, so changing membership on a list with thousands of members costs many requests.
- **List renames require a full sync.** Membership changes are detected automatically, but list names are refreshed during a full sync.
- Only your own lists — not lists you merely follow.

## Project layout

```text
src/
  background.ts   service worker: API calls, sync, recovery, cache
  content.ts      badge rendering + page↔worker bridge
  dom-badge.ts    safe handle extraction and label formatting
  intercept.ts    MAIN-world fetch/XHR observation
  popup.ts        popup UI and recovery states
  shared.ts       messages, validation, and persisted types
  sync-state.ts   sync state transitions
  x-api.ts        strict X response parsers and cache helpers
  badge.css       injected badge + tooltip styles
  index.css       Tailwind entry for the popup
index.html        popup markup
manifest.config.ts
public/           extension action icons
```

Built with Vite, stable CRXJS, Tailwind CSS v4, TypeScript, and Vitest.
