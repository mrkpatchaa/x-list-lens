# SPEC: Fast re-sync, unlisted marker, list colors, export, followed lists

Status: approved by the owner, October 2026.

## Intent

ListLens does its core job today: you see at a glance whether you already have someone on one of your lists. The owner wants ListLens to be ready for other users, not only for themselves. These five additions make it better for everyone without burying that core job.

1. **Fast re-sync.** Re-read only the lists that changed. The owner sees this as the most useful of the five.
2. **Unlisted marker.** Mark accounts that are in none of your lists.
3. **List colors.** Give each list a color so you know a badge at a glance.
4. **Export.** Download your lists and members as CSV or JSON.
5. **Followed lists.** Show lists you follow but do not own.

The owner calls these quick wins and wants all five shipped. Build them in the order above. Each one is a separate commit and can ship alone.

## Goals

- A re-sync takes seconds when few lists changed, not minutes.
- The badge stays small and readable. A glance still answers "is this person on one of my lists?"
- All data stays on the device. ListLens talks only to x.com.

## Non-goals

- **Add or remove people from the badge.** The owner dropped this. Users check a profile before they remove someone, so a one-click action is dangerous.
- Automatic or scheduled syncs. The README promises that ListLens talks to X only when you ask, or right after you change a list yourself. Keep that promise.
- Import, or any write to X.
- A settings page outside the popup.

## Anti-goals

- The timeline fills with markers and colors until the badges become noise.
- A fast re-sync silently leaves the cache wrong.
- Followed lists with thousands of members make every sync slow by default.

## Current state

Read `README.md` first. The parts that matter here:

- `background.ts` `syncLists()` reads all owned lists through `ListsManagementPageTimeline` (fallback `ListOwnerships`), then reads every member page of every list. It commits `listCache`, `listMeta`, `userHandles`, `lastSync` together only after full success.
- `list-ownership.ts` `readListRecord()` already checks that `member_count` exists on a list record, but returns only `{ id, name }`. `isOwnedListRecord()` drops lists the user does not own.
- `content.ts` `paint()` adds one blue badge with a count. It paints nothing when a handle has no lists. Hover, focus or tap shows the list names in a tooltip.
- `popup.ts` `renderLists()` shows each list with its member count, an expandable member list and an "Open" button.
- Local add/remove changes from the X UI update `listCache` through `cache-delta.ts`.

## 1. Fast re-sync

**Behaviour.**

- Store the `member_count` of each list at the end of a sync, next to `listMeta`.
- A fast re-sync reads the list of lists (one or two requests). It then reads the members only of lists that are new, or whose `member_count` differs from the stored value. It keeps the cached members of every other list.
- Lists that no longer appear are removed from the cache and from `listMeta`.
- List names come from the list response, so a fast re-sync also picks up renames. Update the README limitation that says renames need a full sync.
- If a list record has no readable `member_count`, treat that list as changed.
- The commit stays all-or-nothing, as today.

**Known gap.** If one person leaves a list and another joins between syncs, the count stays the same. A fast re-sync misses that change. A full sync catches it.

**Local changes.** When `cache-delta.ts` applies an add or remove, also add or subtract 1 from that list's stored count. Otherwise the next fast re-sync re-reads that list for no reason. This is a cost saving, not a correctness rule: a wrong stored count only causes an extra read.

**Popup.**

- The main button runs a fast re-sync when a complete full sync exists and the cache version matches. Otherwise it runs a full sync, as today.
- Add a small secondary "Full sync" action for the swap case above.
- My call: no automatic sync when the popup opens. See Non-goals.
- My call: the "cache is over a week old" hint now suggests a full sync, because a fast re-sync cannot catch swaps. Both sync kinds write `lastSync`, which drives "Last synced". Only a full sync writes the new `lastFullSync` key, and the hint reads `lastFullSync`.
- Progress shows "Checking N lists…", then the existing per-list progress for the changed lists only. The done state says how many lists changed, for example "2 of 14 lists changed".

## 2. Unlisted marker

**Behaviour.** On an account that is in none of your lists, show a faint, small marker in the same place as the badge. It has no action. Hover, focus or tap shows "Not in any of your lists".

**Rules.**

- Never show the marker on your own account. Read your user ID from the `twid` cookie, or from the profile handle stored at sync time.
- Show it only after at least one successful sync. Before that, "not in any list" is not known.
- My call: the marker is quieter than the badge: outline only, no fill, lower contrast. It must not compete with the badge for attention.
- My call: a popup toggle "Mark people not in any list", off by default. Most accounts on a timeline are in none of your lists, so a default-on marker would put one on almost every post. That is the noise anti-goal.

## 3. List colors

**Behaviour.**

- In the popup list view, each list row gets a color swatch. Clicking it cycles through a fixed palette, or opens a small palette picker (builder's choice).
- Lists start with no color. The badge looks as it does today until the user picks a color.
- Store colors locally by list ID. Keep them across syncs. Drop the colors of lists that no longer exist.

**Badge.**

- My call: the badge keeps its count. Before the count, it shows one small dot per colored list the person is in, up to three dots. When more colored lists apply, the count still tells the full story.
- The tooltip shows each list name with its color dot.
- My call: use a fixed palette of 8 colors that read on X's light, dim and dark themes. No free color picker.
- Colors must not be the only signal. The tooltip names stay. Forced-colors mode hides the dots.

## 4. Export

**Behaviour.** The popup gets an "Export" action with two formats.

- **CSV:** one row per membership: `list_id, list_name, handle, owned` (`owned` is `true` or `false`, for followed lists in part 5).
- **JSON:** `{ exportedAt, lists: [{ id, name, owned, memberCount, members: [handle] }] }`.
- Export reads only the local cache. It never calls X.
- File names: `listlens-YYYY-MM-DD.csv` and `listlens-YYYY-MM-DD.json`.
- Disable Export when there is no completed sync.
- Export must work in Chrome, Opera and Safari. Safari has no `downloads` API, so do not use that permission.
- My call: download with a blob URL and an `<a download>` click. First try this in the popup, because it needs no extra permission. If a browser closes the popup or ignores the download, Export opens a small extension page (`export.html`) in a new tab and starts the download from there. A tab stays open, so the download can finish. Test the popup path in Safari first, and use the tab path for every browser if the popup path fails anywhere.
- CSV must escape commas, quotes and line breaks in list names.
- My call: followed list names come from other people. Prefix a cell that starts with `=`, `+`, `-` or `@` with `'`, so a spreadsheet does not run it as a formula. The round-trip test expects that prefix.

## 5. Followed lists

**Behaviour.**

- The list response already includes lists you follow but do not own. Today `isOwnedListRecord()` drops them. Keep them, marked `owned: false`.
- My call: followed lists are off by default. In the popup, each followed list has a toggle to include it. A followed list can have thousands of members, and the anti-goal is a sync that becomes slow by default.
- Only included followed lists are read during a sync. Fast re-sync applies to them as well.
- In the badge tooltip, show followed list names after owned ones, with a "(followed)" suffix.
- My call: the badge count includes followed lists. If a person is only in followed lists, the badge uses an outline style, not the filled style, so "on one of MY lists" stays clear at a glance.
- The owner decided: a person who is only in followed lists still counts as "not in any of your lists" for the unlisted marker. My call: show one element, not two. With the marker toggle on, that person's outline badge takes the marker's look, and its tooltip says "Not in any of your lists. In lists you follow: …". With the toggle off, it stays a plain outline badge.
- Export (part 4) includes included followed lists with `owned: false`.
- The README limitation "Only your own lists" changes to describe the toggle.

**Ownership safety.** `list-ownership.ts` rejects a response that has list records but none owned by the user. Keep that check. It protects against caching recommendation lists. Followed lists must come from records that X marks as followed or subscribed (for example `following: true` or a subscribed flag). Do not treat every non-owned record as followed: the response can include recommendations. If no reliable "followed" signal exists in the real response, stop and report before building part 5.

**What a real response shows.** The owner captured a `ListsManagementPageTimeline` response in October 2026:

- Owned lists sit in a module with `clientEventInfo.component` `suggest_owned_subscribed_list` (header "Your Lists", item `injectionType` `OwnedSubscribedList`). Each owned list has `following: true` and `user_results.result.rest_id` equal to the owner's ID.
- Recommendations sit in a module with component `suggest_list_to_follow` (header "Discover new Lists", `injectionType` `ListToFollow`). They have `following: false` and other owners.
- The response carries partial GraphQL `errors` (code 214, on banner media fields) next to valid `data`. The parser must keep accepting this.
- The owner's account follows no other person's list, so the capture has no followed-list example.

**Followed-list rule.** A list is followed when its record has `following: true`, its owner is not the signed-in user, and it does not sit under a `ListToFollow` module. Records under `ListToFollow` are never cached, whatever their flags say.

**Test fixture.** Save a trimmed, anonymized copy of the capture under `src/fixtures/`. Keep the real key names, module components, entry IDs pattern, `errors` and cursor entry. Replace every name, handle, user ID, list ID, image URL and bio. Add one hand-made followed list (another owner, `following: true`) to the "Your Lists" module, and mark it as synthetic in the test.

My call: users who own no lists but follow some are in scope. The "no owned lists" check passes when the response has at least one owned or explicitly followed record. On the `ListOwnerships` fallback path, which returns owned lists only, keep the cached followed lists as they are. Do not delete them.

## Storage changes

- New keys: `lastFullSync` (time of the last complete full sync), `listCounts` (list ID → member count at last sync), `listColors` (list ID → palette index), `followedLists` (list ID → `{ name, included }`), `showUnlistedMarker` (boolean).
- `listMeta` stays list ID → name, so existing readers keep working. The owned/followed flag lives in `followedLists`.
- `CACHE_VERSION` changes only if an existing key changes shape. Adding keys does not need a version bump.

## Constraints

- All five features must work in Chrome, Opera and Safari. Safari can stop the background worker during a long sync. A fast re-sync shortens that window, but the existing "interrupted" handling must still cover it.
- `intercept.ts` keeps no runtime imports.
- Parsers fail closed when X's response shape is unknown. Keep the existing behaviour.
- Keep the request pacing in `fetchListMembers()` (random 800–1500 ms between pages, 1 s between lists).
- Popup UI uses the existing Tailwind styles. Badge styles go in `badge.css` and keep the reduced-motion and forced-colors rules.
- Tests follow `AGENTS.md`: only tests that protect a named behaviour.

## Done means

- A fast re-sync with no changed lists sends only the list-of-lists requests. A test proves this through `syncLists()` with a mocked `fetch`.
- A fast re-sync re-reads exactly the lists whose count changed, adds new lists and removes deleted ones. Same test file.
- The unlisted marker never appears on your own account, and never before a first sync.
- Export output for a list name with a comma and a quote parses back to the same values. A name that starts with `=` comes back with the `'` prefix.
- Followed-list parsing keeps followed lists and still drops recommendation lists. A parser test uses a saved real response.
- `npm test` and `npm run build` pass. The owner checks all five features by hand in Chrome, Opera and Safari.

## Left to the builder

- The exact look of the swatch picker, the marker and the dots, within the rules above.
- Where the Export and Full sync actions sit in the popup.
- How to split `syncLists()` so full and fast syncs share code.
