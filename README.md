# Worklog & Status Reporter for Jira

A Chrome extension that answers two questions Jira Cloud is strangely bad at:

**Who logged how many hours?** Jira's built-in reports group time by who an issue
is *assigned* to. That's a different question — people routinely log time against
issues that aren't theirs. This groups by whoever actually logged it, across
every issue they touched. ([JRACLOUD-6137](https://jira.atlassian.com/browse/JRACLOUD-6137)
has been open since 2005.)

**How long do issues sit in each status?** Worked out from each issue's own
changelog, in both clock time and working hours. This is the one that shows where
work piles up.

No server, no account, no API token, no Atlassian app install, no admin approval.
It calls the Jira REST API from your own Jira tab using the session cookie you
already have. Nothing but your own settings is ever stored, and nothing is ever
sent anywhere.
## Pictures

<img width="2244" height="1235" alt="Screenshot_2026-08-13_20-22-15" src="https://github.com/user-attachments/assets/374547e4-bd0a-4fa8-a8b2-da312e03cfd1" />
<img width="2244" height="1235" alt="Screenshot_2026-08-13_20-23-34" src="https://github.com/user-attachments/assets/ff575ccf-eb62-46b5-b0e1-b1991e0ed145" />
<img width="2244" height="1235" alt="Screenshot_2026-08-13_20-19-20" src="https://github.com/user-attachments/assets/c322017c-be4c-48da-abee-a7ee3958747e" />
<img width="2244" height="1235" alt="Screenshot_2026-08-13_20-27-15" src="https://github.com/user-attachments/assets/7389b45c-158d-4555-904c-fdb248f672f4" />
<img width="2244" height="1235" alt="Screenshot_2026-08-13_20-25-36" src="https://github.com/user-attachments/assets/44f5e4e5-fc3c-4df8-ba48-b7fc5ca4923b" />


## Install

Not on the Chrome Web Store yet — load it unpacked:

1. Download this repo (green **Code** button → **Download ZIP**) and unzip it
2. Go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and pick the unzipped folder
5. Open a Jira Cloud tab, then click the extension's icon or press
   <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>

Works on `*.atlassian.net`. If your company uses a custom domain, add it to
`host_permissions` and `content_scripts.matches` in `manifest.json`.

## Using it

Pick a project, pick a date range, hit **Run report**. No JQL needed — the query
is built for you and shown underneath so you can see exactly what ran. Tick
**Write the JQL myself** if you'd rather.

The **How this works** tab explains the reports, including what the numbers mean.

### Two numbers people mix up

**Hours logged** is effort someone typed in — "3h on this". **Time in status** is
elapsed clock time from the issue's history. The same issue can show 4 hours
logged and 11 days in status, and both are correct. They're never added together.

### Clock time vs work hours

Every duration appears twice. **Clock time** is raw elapsed time, so an issue
sitting over a weekend reads 3 days. **Work hours** counts only time inside your
working day (configurable; Mon–Fri 9–5 by default), so the same issue reads 8
hours.

### Things it deliberately gets right

Most tools in this space get at least one of these wrong:

- **Unfinished issues are excluded from averages.** An issue still sitting in a
  status hasn't finished its stay. Including it drags every average down and makes
  the team look faster than it is. Those appear in their own table instead.
- **Bounce-backs count separately.** In Progress → Review → In Progress records
  two visits to In Progress, not one long one.
- **Self-transitions are merged.** Jira sometimes records To Do → To Do; taken
  literally that doubles a status's visit count and halves its average.
- **Report completeness is checked.** Jira stores its own time-spent total per
  issue, so the extension compares that against the worklogs it can actually read.
  A mismatch usually means some worklogs are restricted to a role you're not in —
  which would otherwise make your totals quietly too low with nothing to show it.

## Export

Every table exports to CSV with the columns you choose, or copies as
tab-separated text that pastes straight into a spreadsheet. Whatever a table's
filter box is hiding is left out of the export too.

CSV times default to decimal hours so Excel can total them.

## Shortcuts

<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> toggles the panel ·
<kbd>Esc</kbd> closes · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs the report ·
drag the title bar to move, the bottom-right corner to resize · click column
headings to sort · eight themes including one that follows Chrome's dark mode.

## Known limits

- **Jira Cloud only.** Data Center has a different API surface.
- **Renamed statuses split.** Jira's changelog stores status *display names*, so
  history written before a rename keeps the old name. Nothing can recover the
  link — the old name is all the data there is.
- **No holiday calendar.** Public holidays count as working days.
- Issues with several components are counted against the first one. Splitting
  would be guesswork; counting twice would be worse.
- Time *per status per person* isn't possible — Jira doesn't record which status
  was active when time was logged, so it would be inference, not data.

## Development

No build step, no dependencies. Edit and reload.

```
manifest.json        MV3 manifest
background.js        toolbar click / hotkey → toggle
src/util.js          dates, working-hours maths, formatting, CSV, request pool
src/query.js         date presets + JQL construction (pure)
src/api.js           Jira REST calls, pagination, rate-limit backoff
src/reports.js       report computation (no network, no DOM)
src/panel.js         UI
src/panel.css        styles (shadow DOM, 8 themes)
```

Run the tests:

```sh
node tests/logic.test.js && node tests/load.test.js
```

94 assertions, no test framework. `logic` covers the working-hours window,
weekend spans, bounce-backs, censored open spans, date-preset boundaries
including leap years, JQL construction and CSV escaping. `load` covers failures
that only appear at load time — notably that every `src/*.js` shares one global
scope, so a second top-level `const` of the same name silently stops every later
file from loading.

Issues and pull requests welcome.

## Licence

MIT — see [LICENSE](LICENSE).
