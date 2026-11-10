# Rewordly 1.8.0 – test and release checklist

Live grammar check (underlines as you type), cost controls, and the floating-button fix.
Both repos: branch `feature/live-check`.

## 0. Local setup

1. `rewordly-web`: `npm run dev` (reads `.env.local`, talks to the live Supabase project).
2. `rewordly`: `npm run build:dev`, then load `dist/` in `chrome://extensions` ("Rewordly – Grammar Checker & AI Rewriter (Dev)"). Turn the store version off while testing so the two don't both run.
3. After every rebuild: press ↻ on the extension **and reload the tabs** you test in.
4. Debugging: page console shows `[Rewordly live]` lines; network requests are in the extension's **service worker** DevTools, not the page's.

Automated checks (run once before release):

- `rewordly`: `npm run type-check && npm test && npm run test:e2e`
- `rewordly-web`: `npx tsc --noEmit && npm test`

## 1. Live check – core

| # | Do | Expect |
|---|---|---|
| 1.1 | Open `localhost:3000/try` | Field is focused; 4–5 mistakes underlined within a few seconds, red solid lines drawn left to right |
| 1.2 | Hover an underline | Card opens at once: type, original → suggestion, reason |
| 1.3 | Click the suggestion | Word replaced, underline gone; Cmd/Ctrl+Z restores it |
| 1.4 | Ignore / Add to dictionary | Underline disappears; a dictionary word stays ignored after reload |
| 1.5 | Badge → Fix all | Every suggestion in the field applied |
| 1.6 | Type a new sentence without a period | Nothing checked until you pause ~2 s or end the sentence |
| 1.7 | Type before an underlined word | Underline moves with the word immediately, no flicker |
| 1.8 | Write a Turkish and a German sentence with typos | Both underlined; Turkish reason shown in Turkish |
| 1.9 | Popup → Auto grammar check off | Underlines disappear in all tabs; on again brings them back |
| 1.10 | Right-click → Disable Rewordly on this page, reload | No underlines on that site |

## 2. Real sites

The full per-platform list (general cases, 11 platforms, suggested extra platforms) is in [QA-PLATFORMS.md](QA-PLATFORMS.md). Quick pass below.

For each: write a sentence with "dont" and "teh", check underlines line up with the words, apply a fix, then **keep typing** and confirm the fix stays (the editor didn't revert it).

| Site | Field | Editor |
|---|---|---|
| Medium | Response box, new story | Slate |
| X (Twitter) | Post / reply composer | Draft.js |
| Reddit | Comment box, new post | Lexical / rich text |
| LinkedIn | Post composer, message | contenteditable |
| Gmail | Compose body | contenteditable (not verified yet) |
| Slack (web) | Message box | Quill-like |
| GitHub | Issue/PR comment | textarea |
| Any site | Search box, login form | Must **not** be checked |

Also check on one site: open a site modal or dropdown over a field with underlines → underlines hide; close it → they come back.

## 3. Floating button (regression)

| # | Do | Expect |
|---|---|---|
| 3.1 | Select text in a field → click Rewrite | Modal opens with the rewrite; Replace selection puts it back |
| 3.2 | Select text → click Check Grammar | Modal opens with the corrected text |
| 3.3 | While the modal is open | No underlines or badge show through the modal |

## 4. Plans and limits

| # | Do | Expect |
|---|---|---|
| 4.1 | Not signed in, popup | "Auto-check · free trial – 15,000 of 15,000 chars left" |
| 4.2 | `select add_auto_quota('anon:<id>', 'lifetime', 13000);` then type | Small purple dot on the badge; card footer "…% of your free trial left · Log in" |
| 4.3 | Add 2000 more, type a new sentence | Badge turns grey (pause icon); limit card opens once; **Log in** opens the login page |
| 4.4 | Same text as before while limited | Cached sentences still underlined (free) |
| 4.5 | Log in through `localhost:3000/login` | Popup shows "· today", 60,000 chars; checking resumes |
| 4.6 | Clean up | `delete from auto_quota where identity = 'anon:<id>';` |

Anonymous id: extension service worker console → `chrome.storage.local.get('rewordly_anonymous_id').then(console.log)`.

## 5. Release order

1. **Web first** (`rewordly-web`): run `supabase-site-usage.sql` in Supabase (feature usage per site), then deploy with `LIVE_CHECK_DAILY_BUDGET_USD` (and optionally `IP_HASH_SALT`) set. Run `supabase-live-check.sql` again (it is safe to repeat): it adds the cache cleanup function, the weekly `pg_cron` schedule (a notice appears if pg_cron is not enabled; enable it under Database > Extensions and run the file once more) and the tables for ignored suggestions. Optional env vars: `CHECK_CACHE_TTL_DAYS` (default 30) and `CHECK_SUPPRESS_MIN_USERS` (default 5).
2. Check production: `https://rewordly.store/try` loads; `POST /api/check` answers.
3. **Then the extension**: `npm run build` (production build points to rewordly.store), zip `dist/`, upload.
4. Chrome Web Store listing:
   - Description: `STORE_DESCRIPTION.md`
   - Screenshots: `store-assets/v1.8.0/1-5` (1280×800), small tile `tile-440x280.png`, marquee `marquee-1400x560.png` (regenerate: `npm run build:dev && KIND=shots,tiles SMOKE=1 npx playwright test store-assets.spec.ts`, needs rewordly-web on :3000)
   - Changelog GIF: `assets/live-check.gif` (recorded by hand, 800×187; an auto-generated alternative: `KIND=gif SMOKE=1 npx playwright test store-assets.spec.ts` writes the same path, so copy the hand-made one aside first)
   - **Privacy practices**: declare that typed text in the focused field is sent for checking ("Website content"), that signed-in users' email is stored, and that the names of sites where features are used are counted ("Web history" – site names only, no URLs). Keep it consistent with `rewordly.store/privacy`.
5. After approval: watch `supabase-analytics.sql` queries 1 and 6 (active users, spend) for the first days, and 7–9 (usage and cost per site).
6. Cache lifetime: server answers are reused for 30 days, answers on the device for 7 days. A suggestion that 5 different people ignored (`check_suppressions`) stops being returned; delete its row to bring it back. See which ones: `SELECT * FROM check_suppressions ORDER BY created_at DESC;`
