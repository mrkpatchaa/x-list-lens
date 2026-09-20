# ListLens for X

A Chrome extension that shows, inline on X/Twitter, which of **your** Lists each account belongs to.

Every account you come across gets a small `📋 3` badge next to its handle. Hover it to see the list
names. Badges appear on timeline posts, profile headers, and user cells (followers, search results,
"who to follow").

---

## How it works

X has no public API for reading your Lists, so ListLens reads them the same way the X web app does —
by calling X's internal GraphQL endpoints with your existing browser session.

Those endpoints are versioned by an opaque query ID that changes whenever X ships a new build, so the
IDs can't be hardcoded. Instead the extension watches X make the calls itself and learns the current
IDs. This is why there is a one-time setup step (see below).

Three pieces, running in three different contexts:

| File | Context | Job |
|---|---|---|
| `src/intercept.ts` | page (MAIN world) | Patches `fetch`/`XHR` to learn GraphQL query IDs and notice list add/remove |
| `src/content.ts` | content script | Bridges page → service worker, and paints the badges |
| `src/background.ts` | service worker | Calls X's API, builds and patches the cache |
| `src/popup.ts` | popup | Sync controls, progress, status |
| `src/shared.ts` | all | Message names and types, shared so the three worlds can't drift apart |

`intercept.ts` deliberately has **no runtime imports**. A content script with imports gets wrapped in
an async dynamic-import loader, which would leave `window.fetch` unpatched during early page load. It
uses a type-only import so the build still fails if the message names drift.

### Syncing

- **Full sync** — triggered from the popup. Walks every list and every page of members. Paced to
  avoid rate limits, with exponential backoff on 429/5xx, and cancellable.
- **Targeted sync** — automatic. When you add or remove someone from a list in the X UI, the
  interceptor notices *after the request succeeds* and the service worker re-reads just that one
  list. Rapid changes are debounced so adding five people is one refetch, not five.

There is no scheduled background sync. The extension only talks to X when you ask it to, or right
after you change a list yourself.

### Where your data lives

Everything stays in `chrome.storage.local` on your machine. Nothing is sent anywhere except to x.com,
using the session cookies your browser already has. The cache maps a lowercased handle to a set of
**list IDs**; names are resolved at render time from a separate ID→name map, so renaming a list on X
is picked up without a re-sync.

---

## Install

Requires Node 18+.

```bash
npm install
npm run build
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `dist/` folder

For development with hot reload, `npm run dev` instead of `npm run build`.

## First run

The extension can't sync until it has seen X load your Lists at least once — that's how it learns the
current GraphQL query IDs. The popup detects this and will show a **one-time setup** prompt with a
button that takes you straight there. The Sync button stays disabled until setup is done.

After that: open the popup and hit **Sync Lists Now**. A full sync takes a few minutes if you have
many lists; progress and the list currently being read are shown, and you can stop it at any point
(stopping leaves your previous cache intact rather than saving a partial one).

## Permissions

| Permission | Why |
|---|---|
| `storage` | Holding the list cache locally |
| `cookies` | Reading the `ct0` CSRF token so API calls are accepted |
| `*://*.x.com/*`, `*://*.twitter.com/*` | Running the content script and calling the API |

## Known limitations

- **It depends on X's internals.** The GraphQL payload shape, the `data-testid` attributes used to
  find handles, and the public web bearer token are all X implementation details. A big enough
  redesign will break this. The response parser handles both the current and legacy user shapes and
  falls back to a deep scan, but it isn't future-proof.
- **The cache goes stale.** Changes made from another device or the mobile app won't show until you
  re-sync. The popup nudges you after a week.
- **Large lists are expensive to re-read.** A targeted sync re-reads the whole list, so changing
  membership on a list with thousands of members costs many requests.
- Only your own lists — not lists you merely follow.

## Project layout

```
src/
  background.ts   service worker: API calls, sync, cache
  content.ts      badge rendering + page↔worker bridge
  intercept.ts    MAIN-world fetch/XHR interception
  popup.ts        popup UI
  shared.ts       message names, shared types
  badge.css       injected badge + tooltip styles
  index.css       Tailwind entry for the popup
index.html        popup markup
manifest.config.ts
```

Built with Vite + `@crxjs/vite-plugin` and Tailwind CSS v4.
