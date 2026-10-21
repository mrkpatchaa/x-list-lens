# List extras Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fast re-sync, the unlisted marker, list colors, export and followed lists to ListLens.

**Architecture:** Move the sync logic out of `background.ts` into `src/sync.ts`, with its X calls and delays injected, so a test can drive a full or fast sync with a fake `fetch`. Pure helpers (`sync-plan.ts`, `export.ts`, `palette.ts`) hold the logic that tests pin. The content script and popup read new storage keys and render the new UI.

**Tech Stack:** TypeScript, Chrome MV3 (also Opera and Safari), Vite + CRXJS, Tailwind v4 (popup), Vitest with jsdom.

**Spec:** `docs/archive/SPEC-list-extras.md`

## Global Constraints

- All five features work in Chrome, Opera and Safari.
- `intercept.ts` keeps no runtime imports.
- Parsers fail closed on an unknown shape. They keep accepting `data` that comes with partial `errors` (code 214).
- Keep request pacing: random 800–1500 ms between member pages, 1000 ms between lists.
- A sync commits all-or-nothing. A cancelled or failed sync leaves the previous cache intact.
- No automatic or scheduled sync.
- No `downloads` permission.
- Badge styles live in `src/badge.css` and keep the reduced-motion and forced-colors rules.
- Tests follow `AGENTS.md`: only tests that protect a named behaviour.
- New storage keys: `lastFullSync`, `listCounts`, `listColors`, `followedLists`, `showUnlistedMarker`, `selfHandle`. `listMeta` stays list ID → name. No `CACHE_VERSION` bump.
- Commit messages end with the session attribution line given in the session.

## Review Focus

1. **Owned lists also carry `following: true`.** The real capture shows this. An owned list must never be classed as followed. Test in Task 8.
2. **A list record has no readable `member_count`.** Fast re-sync must re-read that list, not keep stale members. Test in Task 3.
3. **A list was deleted on X since the last sync.** Its members, name, count and color must go. Tests in Tasks 3 and 6.
4. **Your own handle in a different case** (`@MrK` on the page, `mrk` stored). The unlisted marker must still skip you. Test in Task 5.
5. **A list name with a comma, a quote, a line break or a leading `=`.** CSV must round-trip it, with `'` before the `=`. Test in Task 7.

---

## File map

| File | Status | Job |
|---|---|---|
| `src/fixtures/lists-management-timeline.json` | new | Anonymized real `ListsManagementPageTimeline` capture |
| `src/list-ownership.ts` | modify | Return `memberCount`, owner handle, and (Task 8) followed lists |
| `src/sync.ts` | new | `runSync()`: full and fast sync, with injected X calls |
| `src/sync-plan.ts` | new | Pure: choose lists to re-read, build the next cache |
| `src/background.ts` | modify | Auth, `fetchWithAuth`, message wiring only |
| `src/cache-delta.ts` | modify | Also adjust `listCounts` on a local add or remove |
| `src/shared.ts` | modify | New types, keys, `SyncMode`, `START_SYNC` payload |
| `src/content.ts`, `src/dom-badge.ts`, `src/badge.css` | modify | Marker, color dots, followed styling |
| `src/palette.ts` | new | The 8 list colors |
| `src/export.ts` | new | Pure CSV and JSON builders |
| `export.html`, `src/export-page.ts` | new | Fallback download page |
| `src/popup.ts`, `index.html` | modify | Full sync action, marker toggle, swatches, export, followed toggles |
| `README.md` | modify | Each task updates the lines it changes |

---

### Task 1: Parser keeps member counts, with a real fixture

**Files:**
- Create: `src/fixtures/lists-management-timeline.json`
- Modify: `src/list-ownership.ts` (`OwnedListSummary`, `readListRecord`)
- Test: `src/list-ownership.test.ts`

**Interfaces:**
- Produces: `type OwnedListSummary = { id: string; name: string; memberCount?: number; ownerHandle?: string }`. `memberCount` is set only when `member_count` is a finite integer ≥ 0. `ownerHandle` is the lowercased `user_results.result.core.screen_name` (or `legacy.screen_name`) when it passes `isValidHandle`.

- [ ] **Step 1: Build the fixture.** Trim the owner's capture from the spec session to: the `ListToFollow` module with 2 items, the `OwnedSubscribedList` module with all 4 items, the bottom cursor entry, and 1 entry of `errors`. Keep every key on each `list` object except banner and facepile media. Keep `user_results.result` with `__typename`, `rest_id` and `core.screen_name` / `core.name` only. Replace values:
  - owner: `rest_id` `"1000"`, handle `"listlens_owner"`
  - recommendation owners: `"2001"` / `"rec_owner_one"`, `"2002"` / `"rec_owner_two"`
  - owned list IDs `"3001"`–`"3004"`, names `"Alpha"`, `"Sport"`, `"Team"`, `"Tech"`, counts 14, 15, 96, 49
  - recommendation list IDs `"4001"`, `"4002"`, names `"Football"`, `"Racing"`
  - drop all image URLs and bios.
- [ ] **Step 2: Write the failing test** `it('reads owned lists and member counts from a real capture')`:
  ```ts
  const { lists } = parseListManagementPage(fixture, '1000')
  expect(lists.map((l) => [l.id, l.memberCount])).toEqual([['3001', 14], ['3002', 15], ['3003', 96], ['3004', 49]])
  expect(lists.every((l) => l.ownerHandle === 'listlens_owner')).toBe(true)
  ```
- [ ] **Step 3: Run** `npx vitest run src/list-ownership.test.ts`. Expected: FAIL on `memberCount`.
- [ ] **Step 4: Implement** the two fields in `readListRecord`. The `isOwnedListRecord` call site is unchanged.
- [ ] **Step 5: Run** the same command. Expected: PASS, with the existing tests still green.
- [ ] **Step 6: Commit** `feat(sync): keep list member counts from the lists response`.

### Task 2: Move sync into `src/sync.ts` and record counts

**Files:**
- Create: `src/sync.ts`
- Modify: `src/background.ts` (remove `fetchListMembers`, `fetchOwnedLists`, `syncLists` bodies), `src/shared.ts`
- Test: `src/sync.test.ts`

**Interfaces:**
- Consumes: `OwnedListSummary` (Task 1).
- Produces, in `shared.ts`:
  - `type SyncMode = 'fast' | 'full'`
  - `type ListCounts = Record<string, number>`
  - `SyncState` `done` variant gains `mode?: SyncMode; changedCount?: number`.
- Produces, in `sync.ts`:
  ```ts
  export type SyncDeps = {
      fetchJson: (url: string, signal: AbortSignal) => Promise<unknown>
      delay: (ms: number, signal: AbortSignal) => Promise<void>
      currentUserId: string
      queryIds: { lists: string; members: string; ownerships?: string }
      isCancelled: () => boolean
      signal: AbortSignal
  }
  export async function runSync(mode: SyncMode, deps: SyncDeps): Promise<void>
  ```
  `runSync` reads and writes `chrome.storage.local` and sets `syncState`, as `syncLists()` does today. It throws on failure. `background.ts` keeps `fullSyncRunning`, cancellation, `createErrorState` and the `cancelled` state, and passes `fetchWithAuth` bound to the CSRF token as `fetchJson`.
- On success a full sync also writes `listCounts` (ID → `memberCount`, lists with no count are left out), `lastFullSync: Date.now()` and `selfHandle` (the `ownerHandle` of the first owned list, if any).

- [ ] **Step 1: Write the failing test** `it('full sync reads every list and records counts')` in `src/sync.test.ts`. Use the chrome storage mock pattern from `popup.test.ts`. Use a fake `fetchJson` that serves the Task 1 fixture for URLs containing `/ListsManagementPageTimeline` and one member page per list for `/ListMembers`. Use `delay: async () => {}`. Assert:
  - `listCounts` equals `{ '3001': 14, '3002': 15, '3003': 96, '3004': 49 }`
  - `lastFullSync` is a number, and `selfHandle` is `'listlens_owner'`
  - `listCache` maps each served member handle to its list IDs
  - `syncState` is `{ status: 'done', mode: 'full', … }`
- [ ] **Step 2: Run** `npx vitest run src/sync.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `runSync('full', deps)` by moving the existing code. Keep the `ListOwnerships` fallback and the member-page loop unchanged.
- [ ] **Step 4: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 5: Build** with `npm run build`. Expected: no type errors. Load `dist/` in Chrome and run one full sync by hand.
- [ ] **Step 6: Commit** `refactor(sync): move sync into sync.ts with injected X calls`.

### Task 3: Fast re-sync engine

**Files:**
- Create: `src/sync-plan.ts`
- Modify: `src/sync.ts`, `src/background.ts` (message), `src/cache-delta.ts`, `src/shared.ts`
- Test: `src/sync.test.ts`, `src/cache-delta.test.ts`

**Interfaces:**
- Consumes: `runSync`, `SyncDeps`, `ListCounts` (Task 2).
- Produces, in `sync-plan.ts`:
  ```ts
  export function listsToReread(lists: OwnedListSummary[], stored: ListCounts, cachedIds: Set<string>): Set<string>
  // A list is re-read when it is not in cachedIds, has no memberCount, or memberCount !== stored[id].
  export function buildNextCache(previous: ListCache, keepIds: Set<string>, fresh: Map<string, Set<string>>): ListCache
  // Keeps only keepIds from previous entries, then adds fresh members. Drops handles left with no lists.
  ```
- `START_SYNC` message becomes `{ type: MSG.START_SYNC, mode?: SyncMode }`. A missing `mode` means `'full'`.
- `runSync('fast', …)` falls back to `'full'` when `lastFullSync` or `listCounts` is missing.
- Fast sync writes `listCounts`, `listMeta`, `listCache`, `lastSync`, and `syncState { status: 'done', mode: 'fast', changedCount, listCount }`. It does not write `lastFullSync`.
- `applyListMutationToStorage` adds or subtracts 1 from `listCounts[listId]` when that key exists.

- [ ] **Step 1: Write the failing tests** in `src/sync.test.ts`. Seed storage as after a full sync of the fixture.
  - `it('fast sync with no changed list sends only list requests')`: assert that every URL passed to `fetchJson` contains `/ListsManagementPageTimeline`, and that `listCache` is unchanged.
  - `it('fast sync re-reads changed and new lists and drops deleted ones')`: serve a lists page where `3002` has count 16, `3004` is missing and `3005` is new. Assert that the member URLs are exactly those for `3002` and `3005`. Assert that `3004` is gone from `listCache`, `listMeta` and `listCounts`, and that `changedCount` is 3.
  - `it('fast sync re-reads a list whose count is missing')`: remove `member_count` from `3001`. Assert that a member URL for `3001` is requested.
- [ ] **Step 2: Write the failing test** in `src/cache-delta.test.ts`, `it('keeps the stored count in step with a local add')`: with storage `listCounts { '1': 5 }`, an add to list `1` gives `6`. An add to list `9`, which has no count, leaves `listCounts` without key `9`.
- [ ] **Step 3: Run** `npx vitest run src/sync.test.ts src/cache-delta.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `sync-plan.ts`, the fast path in `runSync`, the `listCounts` change in `cache-delta.ts`, and the `mode` field on `START_SYNC` in `background.ts`.
- [ ] **Step 5: Run** `npx vitest run`. Expected: all PASS.
- [ ] **Step 6: Commit** `feat(sync): fast re-sync reads only lists whose count changed`.

### Task 4: Popup for fast and full sync

**Files:**
- Modify: `src/popup.ts`, `index.html`, `README.md`
- Test: `src/popup.test.ts`

**Interfaces:**
- Consumes: `START_SYNC` with `mode`, `SyncState.done.mode/changedCount`, `lastFullSync` (Task 3).
- Main button sends `mode: 'fast'` when `lastFullSync` is a number, else `'full'`. A new `#fullSyncBtn` text button (next to `#reconnectBtn` in the footer) always sends `'full'`. It is disabled while a sync runs or setup is incomplete.
- Copy:
  - fast done: `${changedCount} of ${listCount} lists changed`
  - running with `total === 0`: `Checking your lists…`
  - stale hint: reads `lastFullSync`, not `lastSync`, and ends with `run a full sync to catch changes made elsewhere.`

- [ ] **Step 1: Write the failing test** `it('sends a fast sync after a full sync exists, and a full sync from the footer')`: seed `lastFullSync`. Click `#syncBtn`, then expect `sendMessage` to have been called with `{ type: MSG.START_SYNC, mode: 'fast' }`. Click `#fullSyncBtn`, then expect `mode: 'full'`.
- [ ] **Step 2: Run** `npx vitest run src/popup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the button, the messages and the copy. In the README, replace the "List renames require a full sync" limitation, and describe fast and full sync under **Syncing**.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(popup): fast sync by default, full sync on demand`.

### Task 5: Unlisted marker

**Files:**
- Modify: `src/dom-badge.ts`, `src/content.ts`, `src/badge.css`, `src/popup.ts`, `index.html`, `README.md`
- Test: `src/dom-badge.test.ts`

**Interfaces:**
- Produces, in `dom-badge.ts`:
  ```ts
  export function getSelfHandle(root: ParentNode, stored?: string): string | undefined
  // Reads href of a[data-testid="AppTabBar_Profile_Link"] first, else `stored`. Lowercased.
  export type BadgeKind = 'none' | 'listed' | 'unlisted'
  export function badgeKind(handle: string, lists: string[] | undefined, opts: { selfHandle?: string; showUnlisted: boolean; synced: boolean }): BadgeKind
  ```
- `synced` is true when `lastSync` is a number. The marker is `.listlens-badge.listlens-unlisted`, with an outline only and no count. Its tooltip reads `Not in any of your lists`.
- Popup: a checkbox `#unlistedToggle` labelled `Mark people not in any list` in the lists section. It writes `showUnlistedMarker` and is off by default. `content.ts` repaints all nodes when `showUnlistedMarker` changes.

- [ ] **Step 1: Write the failing test** `it('marks unlisted people but never you, and never before a sync')`:
  ```ts
  const o = { selfHandle: 'mrk', showUnlisted: true, synced: true }
  expect(badgeKind('alice', undefined, o)).toBe('unlisted')
  expect(badgeKind('alice', ['1'], o)).toBe('listed')
  expect(badgeKind('mrk', undefined, o)).toBe('none')
  expect(badgeKind('alice', undefined, { ...o, synced: false })).toBe('none')
  expect(badgeKind('alice', undefined, { ...o, showUnlisted: false })).toBe('none')
  ```
  Add an assertion that `getSelfHandle` reads `href="/MrK"` as `'mrk'` (Review Focus 4).
- [ ] **Step 2: Run** `npx vitest run src/dom-badge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the `paint()` branch, the CSS (with forced-colors) and the popup toggle. Add a README line under the badge description.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS. Check the marker by hand in Chrome.
- [ ] **Step 5: Commit** `feat(badge): optional marker for people in none of your lists`.

### Task 6: List colors

**Files:**
- Create: `src/palette.ts`
- Modify: `src/popup.ts`, `src/content.ts`, `src/badge.css`, `src/sync.ts`, `src/shared.ts`
- Test: `src/sync.test.ts`

**Interfaces:**
- Produces: `export const LIST_COLORS: readonly string[]`, 8 hex values that pass 3:1 contrast on `#ffffff`, `#15202b` and `#000000`. Also `type ListColors = Record<string, number>`: list ID → palette index.
- Popup: each list row gets a swatch button before the name, `aria-label` `Color for ${name}`. A click cycles `none → 0 → … → 7 → none` and writes `listColors`.
- Badge: up to 3 `.listlens-dot` spans before the count, one per colored list, in `listMeta` name order. The tooltip renders one line per list, with a dot for colored lists. Forced-colors mode hides the dots.
- Both sync modes drop `listColors` keys whose list is gone.

- [ ] **Step 1: Write the failing test** in `src/sync.test.ts`, `it('drops the color of a list deleted on X')`: seed `listColors { '3004': 2, '3001': 0 }` and run the deleted-list fast sync from Task 3. Expect `listColors` to equal `{ '3001': 0 }`.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** the palette, the swatch, the dots, the tooltip and the cleanup.
- [ ] **Step 4: Run** `npx vitest run`. Expected: PASS. Check the dots by hand on X's light and dark themes.
- [ ] **Step 5: Commit** `feat(badge): per-list colors`.

### Task 7: Export

**Files:**
- Create: `src/export.ts`, `export.html`, `src/export-page.ts`
- Modify: `src/popup.ts`, `index.html`, `manifest.config.ts` only if CRXJS needs `export.html` listed as an input, `README.md`
- Test: `src/export.test.ts`

**Interfaces:**
- Produces, in `export.ts`:
  ```ts
  export type ExportList = { id: string; name: string; owned: boolean; memberCount: number; members: string[] }
  export function collectExport(cache: ListCache, meta: ListMeta, followed: Record<string, { name: string; included: boolean }>): ExportList[]
  export function toCsv(lists: ExportList[]): string   // header: list_id,list_name,handle,owned
  export function toJson(lists: ExportList[], exportedAt: Date): string
  export function exportFileName(kind: 'csv' | 'json', now: Date): string  // listlens-YYYY-MM-DD.<kind>
  ```
  `memberCount` is the number of cached members, not X's count. CSV quotes every field that contains `,`, `"`, `\r` or `\n`. It doubles inner quotes, and prefixes `'` when a value starts with `=`, `+`, `-` or `@`. Use `\r\n` line ends.
- Popup: an `#exportBtn` in the footer opens a small menu with **CSV** and **JSON**. It is disabled when `lastSync` is missing. A click builds a `Blob` and clicks an `<a download>`. If the popup path fails in a browser, the popup opens `export.html?format=csv|json` with `chrome.tabs.create`. That page builds the file from storage and offers a visible download link. Check Safari by hand first, and keep only the path that works in all three browsers.

- [ ] **Step 1: Write the failing test** `it('round-trips awkward list names through CSV')`: one list named `Design, "UX"\nteam` and one named `=SUM(A1)`. Parse `toCsv` output with a small RFC 4180 parser in the test. Expect the cells back as `Design, "UX"\nteam` and `'=SUM(A1)`.
- [ ] **Step 2: Run** `npx vitest run src/export.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `export.ts`, the popup action and `export.html`. Add an **Export** line to the README.
- [ ] **Step 4: Run** `npx vitest run` and `npm run build`. Expected: PASS. Export both formats by hand in Chrome, Opera and Safari.
- [ ] **Step 5: Commit** `feat(popup): export lists as CSV or JSON`.

### Task 8: Followed lists

**Files:**
- Modify: `src/list-ownership.ts`, `src/fixtures/lists-management-timeline.json`, `src/sync.ts`, `src/shared.ts`, `src/popup.ts`, `index.html`, `src/content.ts`, `src/dom-badge.ts`, `src/badge.css`, `README.md`
- Test: `src/list-ownership.test.ts`, `src/dom-badge.test.ts`

**Interfaces:**
- `parseListManagementPage` returns `{ lists, followed, cursor }`. `followed: OwnedListSummary[]` holds records with `following === true`, an owner other than `currentUserId`, and no `ListToFollow` ancestor. Detect that ancestor from a module's `clientEventInfo.component === 'suggest_list_to_follow'` or an item's `injectionType === 'ListToFollow'`. The "no owned lists" contract check passes when `lists` or `followed` is non-empty. `parseOwnedListsPage` returns `followed: []`.
- `type FollowedLists = Record<string, { name: string; included: boolean; memberCount?: number }>`. Every sync rewrites it from the response and keeps each `included` value. On the `ListOwnerships` fallback path it stays as it is.
- Included followed lists are read like owned lists, in both sync modes. Their names go into `listMeta`.
- `badgeKind` gains `'followed'` for a person whose lists are all followed. With `showUnlisted` on, `'followed'` uses the unlisted look. Its tooltip reads `Not in any of your lists. In lists you follow: …`. Owned names come first in every tooltip. Followed names end with ` (followed)`.
- Popup: a **Lists you follow** group below the owned lists. Each row has a checkbox `Include` that writes `followedLists[id].included`. The group is hidden when there are no followed lists.

- [ ] **Step 1: Extend the fixture.** Add one synthetic item to the `OwnedSubscribedList` module: list `5001`, `"Followed demo"`, `following: true`, owner `"2003"` / `"other_owner"`, count 7. Add `"_synthetic": true` on that item so readers know it is not from X.
- [ ] **Step 2: Write the failing test** `it('separates owned, followed and recommended lists in a real capture')`:
  ```ts
  const page = parseListManagementPage(fixture, '1000')
  expect(page.lists.map((l) => l.id)).toEqual(['3001', '3002', '3003', '3004']) // owned lists carry following: true too
  expect(page.followed.map((l) => l.id)).toEqual(['5001'])                      // 4001/4002 are recommendations
  ```
  Add a case for a follow-only user. `parseListManagementPage(fixture, '9999')` must not throw. It gives `lists: []`, and `followed` IDs `['3001', '3002', '3003', '3004', '5001']`.
- [ ] **Step 3: Write the failing test** in `src/dom-badge.test.ts`: `badgeKind('bob', ['5001'], { …, followedIds: new Set(['5001']) })` is `'followed'`.
- [ ] **Step 4: Run** `npx vitest run src/list-ownership.test.ts src/dom-badge.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement** the parser, storage, sync, popup group, badge and tooltip. Include followed lists in `collectExport` with `owned: false`. Replace the README limitation "Only your own lists".
- [ ] **Step 6: Run** `npx vitest run`. Expected: PASS.
- [ ] **Step 7: Commit** `feat: show lists you follow, opt-in per list`.

### Task 9: Final check

- [ ] **Step 1: Run** `npx vitest run`, `npx tsc --noEmit` and `npm run build`. Expected: all pass, and no test file reports zero tests.
- [ ] **Step 2:** Give the owner this manual check list for Chrome, Opera and Safari:
  - fast sync with no change
  - fast sync after adding someone on X
  - full sync
  - unlisted marker on and off
  - one list color
  - CSV and JSON export
  - one followed list included
- [ ] **Step 3:** After the owner confirms, `git mv` the spec and this plan to `docs/archive/`, and add lines to `docs/archive/README.md`.
