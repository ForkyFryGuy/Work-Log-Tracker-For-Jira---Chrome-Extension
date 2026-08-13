// Headless test of the pure logic. Stubs `window` so the content-script files load.
global.window = {};
require("../src/util.js");
require("../src/query.js");
require("../src/reports.js");
const { util: U, reports: R, query: Q } = global.window.JR;

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}  got=${got}${ok ? "" : ` want=${want}`}`);
}

const cfg = { workDays: [1, 2, 3, 4, 5], workStart: "09:00", workEnd: "17:00" };
const h = (ms) => (ms / 3600000).toFixed(2);
const D = (s) => new Date(s).getTime();

console.log("--- business time ---");
// Fri 2026-08-07 10:00 -> Fri 14:00 = 4 working hours, same day.
eq("same day 10:00-14:00", h(U.businessMs(D("2026-08-07T10:00:00"), D("2026-08-07T14:00:00"), cfg)), "4.00");
// Fri 16:00 -> Mon 10:00. Fri 16-17 = 1h, weekend = 0, Mon 9-10 = 1h => 2h.
eq("across a weekend", h(U.businessMs(D("2026-08-07T16:00:00"), D("2026-08-10T10:00:00"), cfg)), "2.00");
// Sat 10:00 -> Sun 18:00, entirely weekend => 0.
eq("weekend only", h(U.businessMs(D("2026-08-08T10:00:00"), D("2026-08-09T18:00:00"), cfg)), "0.00");
// Mon 03:00 -> Mon 23:00 clamps to the 8h window.
eq("clamps to window", h(U.businessMs(D("2026-08-10T03:00:00"), D("2026-08-10T23:00:00"), cfg)), "8.00");
// A full Mon-Fri week = 5 x 8h.
eq("full week", h(U.businessMs(D("2026-08-10T00:00:00"), D("2026-08-15T00:00:00"), cfg)), "40.00");
eq("zero-length span", U.businessMs(D("2026-08-10T10:00:00"), D("2026-08-10T10:00:00"), cfg), 0);
eq("reversed span", U.businessMs(D("2026-08-10T12:00:00"), D("2026-08-10T10:00:00"), cfg), 0);

console.log("\n--- report B: spans ---");
const issue = (key, created, status) => ({
  key,
  fields: { summary: "s", created, status: { name: status }, project: { name: "Proj" } },
});
const hist = (created, from, to) => ({ created, items: [{ field: "status", fromString: from, toString: to }] });

// Created in To Do, -> In Progress after 1 day, -> Done after 2 more. Now open in Done.
const i1 = issue("T-1", "2026-08-03T09:00:00.000+0000", "Done");
const cl1 = [
  hist("2026-08-04T09:00:00.000+0000", "To Do", "In Progress"),
  hist("2026-08-06T09:00:00.000+0000", "In Progress", "Done"),
];
const spans = R.buildIssueSpans(i1, cl1, Date.now());
eq("span count", spans.length, 3);
eq("initial status from first transition", spans[0].status, "To Do");
eq("middle status", spans[1].status, "In Progress");
eq("last span is open", spans[2].end, "null");
eq("To Do calendar hours", h(spans[0].end - spans[0].start), "24.00");
eq("In Progress calendar hours", h(spans[1].end - spans[1].start), "48.00");

// Out-of-order histories must still produce the right sequence.
const spansUnsorted = R.buildIssueSpans(i1, [cl1[1], cl1[0]], Date.now());
eq("unsorted histories sort correctly", spansUnsorted.map((s) => s.status).join(">"), "To Do>In Progress>Done");

// Self-transition (To Do -> To Do) must collapse into a single visit, or the
// status gets two spans and its average is halved. Seen live on SCRUM-3.
const iSelf = issue("S-1", "2026-08-13T09:00:00.000+0000", "In Review");
const clSelf = [
  hist("2026-08-13T09:00:00.000+0000", "To Do", "To Do"),
  hist("2026-08-13T11:00:00.000+0000", "To Do", "In Review"),
];
const sSelf = R.buildIssueSpans(iSelf, clSelf, Date.now());
eq("self-transition merges into one span", sSelf.length, 2);
eq("merged span keeps the status", sSelf[0].status, "To Do");
eq("merged span spans the full 2h, not 0h + 2h", h(sSelf[0].end - sSelf[0].start), "2.00");
const rSelf = R.buildReportB([iSelf], new Map([["S-1", clSelf]]), cfg);
eq("status is credited with 1 visit, not 2", rSelf.perStatus.find((s) => s.status === "To Do").count, 1);
eq("average is the true 2h, not 1h", h(rSelf.perStatus.find((s) => s.status === "To Do").avgCalMs), "2.00");

// Three in a row collapse too.
const sTriple = R.buildIssueSpans(iSelf, [
  hist("2026-08-13T09:30:00.000+0000", "To Do", "To Do"),
  hist("2026-08-13T10:00:00.000+0000", "To Do", "To Do"),
  hist("2026-08-13T11:00:00.000+0000", "To Do", "In Review"),
], Date.now());
eq("repeated self-transitions all collapse", sTriple.length, 2);
eq("collapsed span still measures 2h", h(sTriple[0].end - sTriple[0].start), "2.00");

// Never transitioned: one open span in its current status.
const i2 = issue("T-2", "2026-08-01T09:00:00.000+0000", "Backlog");
const s2 = R.buildIssueSpans(i2, [], Date.now());
eq("no transitions -> 1 span", s2.length, 1);
eq("no transitions -> current status", s2[0].status, "Backlog");

// Bounce-back A->B->A must accumulate two separate spans in A.
const i3 = issue("T-3", "2026-08-03T09:00:00.000+0000", "In Progress");
const cl3 = [
  hist("2026-08-04T09:00:00.000+0000", "In Progress", "Review"),
  hist("2026-08-05T09:00:00.000+0000", "Review", "In Progress"),
  hist("2026-08-07T09:00:00.000+0000", "In Progress", "Review"),
];
const rb = R.buildReportB([i3], new Map([["T-3", cl3]]), cfg);
const ip = rb.perStatus.find((s) => s.status === "In Progress");
eq("bounce-back: 2 completed In Progress spans", ip.count, 2);
eq("bounce-back: counted as 1 issue", ip.issues, 1);
eq("bounce-back: total = 24h + 48h", h(ip.totalCalMs), "72.00");
eq("bounce-back: avg = 36h", h(ip.avgCalMs), "36.00");

console.log("\n--- report B: censoring ---");
// One issue exited Review after 24h; another is still sitting in Review.
const iA = issue("C-1", "2026-08-03T09:00:00.000+0000", "Done");
const clA = [hist("2026-08-03T09:00:00.000+0000", "To Do", "Review"), hist("2026-08-04T09:00:00.000+0000", "Review", "Done")];
const iB = issue("C-2", "2026-08-03T09:00:00.000+0000", "Review");
const clB = [hist("2026-08-03T09:00:00.000+0000", "To Do", "Review")];
const rc = R.buildReportB([iA, iB], new Map([["C-1", clA], ["C-2", clB]]), cfg);
const rev = rc.perStatus.find((s) => s.status === "Review");
eq("open span excluded from avg", rev.count, 1);
eq("avg is the completed span only", h(rev.avgCalMs), "24.00");
eq("open spans surfaced separately", rc.open.length, 2);
eq("open span is the current status", rc.open.find((r) => r.key === "C-2").status, "Review");

console.log("\n--- report A ---");
const wl = (author, started, secs) => ({
  author: { accountId: author, displayName: author },
  started,
  timeSpentSeconds: secs,
});
const withSpent = (i, secs) => { i.fields.timespent = secs; return i; };
const issuesA = [
  withSpent(issue("A-1", "2026-08-01T09:00:00.000+0000", "Done"), 10800),
  withSpent(issue("A-2", "2026-08-01T09:00:00.000+0000", "Done"), 11799),
];
const wlMap = new Map([
  ["A-1", [wl("dana", "2026-08-05T10:00:00.000+0000", 3600), wl("sam", "2026-08-05T10:00:00.000+0000", 7200)]],
  ["A-2", [wl("dana", "2026-08-06T10:00:00.000+0000", 1800), wl("dana", "2026-07-01T10:00:00.000+0000", 9999)]],
]);
const ra = R.buildReportA(issuesA, wlMap, { fromMs: U.dayStart("2026-08-01"), toMs: U.dayEnd("2026-08-31"), groupBy: "none" });
eq("authors found", ra.rows.length, 2);
eq("sorted by hours desc, sam (2h) first", ra.rows[0].name, "sam");
eq("sam hours", U.hours2(ra.rows[0].seconds), "2.00");
eq("dana hours (1h + 0.5h, July entry excluded)", U.hours2(ra.rows.find((r) => r.name === "dana").seconds), "1.50");
eq("out-of-range entry skipped", ra.entriesSkipped, 1);
eq("in-range entries counted", ra.entriesCounted, 3);
eq("grand total", U.hours2(ra.grandSeconds), "3.50");

// Cross-check totals ignore the date filter — they must compare like with like.
eq("allSeconds counts every entry, in range or not", U.hours2(ra.allSeconds), "6.28");
eq("jiraSeconds sums the issues' own timespent", U.hours2(ra.jiraSeconds), "6.28");
eq("matching totals mean no hidden worklogs", ra.jiraSeconds - ra.allSeconds, 0);

const hidden = R.buildReportA(
  [withSpent(issue("H-1", "2026-08-01T09:00:00.000+0000", "Done"), 7200)],
  new Map([["H-1", [wl("dana", "2026-08-05T10:00:00.000+0000", 3600)]]]),
  { fromMs: null, toMs: null, groupBy: "none" }
);
eq("a restricted worklog shows up as a gap", U.hours2(hidden.jiraSeconds - hidden.allSeconds), "1.00");

const raAll = R.buildReportA(issuesA, wlMap, { fromMs: null, toMs: null, groupBy: "project" });
eq("no range -> nothing skipped", raAll.entriesSkipped, 0);
eq("group rows produced", raAll.groupRows.length > 0, "true");

console.log("\n--- brief-span threshold ---");
// SCRUM-7: created and moved to Done within seconds, leaving a 0m To Do span.
const iBrief = issue("B-1", "2026-08-13T09:00:00.000+0000", "Done");
const clBrief = [
  hist("2026-08-13T09:00:10.000+0000", "To Do", "Done"), // 10 seconds
];
const noFilter = R.buildReportB([iBrief], new Map([["B-1", clBrief]]), { ...cfg, minSpanMs: 0 });
eq("threshold off keeps the 10s span", noFilter.perStatus.length, 1);
eq("threshold off reports nothing skipped", noFilter.briefSkipped, 0);

const filtered = R.buildReportB([iBrief], new Map([["B-1", clBrief]]), { ...cfg, minSpanMs: 60000 });
eq("60s threshold drops the 10s span", filtered.perStatus.length, 0);
eq("dropped spans are counted, not silent", filtered.briefSkipped, 1);
eq("the open span survives regardless", filtered.open.length, 1);
eq("open span is the current status", filtered.open[0].status, "Done");

// A brand-new issue sitting in its first status must never vanish.
const iFresh = issue("B-2", new Date(Date.now() - 5000).toISOString(), "To Do");
const fresh = R.buildReportB([iFresh], new Map([["B-2", []]]), { ...cfg, minSpanMs: 60000 });
eq("a 5s-old issue still shows where it is", fresh.open.length, 1);
eq("and is not counted as skipped", fresh.briefSkipped, 0);

// A real span just over the line is kept.
const clEdge = [hist("2026-08-13T09:01:30.000+0000", "To Do", "Done")]; // 90s
const edge = R.buildReportB([iBrief], new Map([["B-1", clEdge]]), { ...cfg, minSpanMs: 60000 });
eq("90s span survives a 60s threshold", edge.perStatus.length, 1);

console.log("\n--- date presets ---");
// Reference "now": Thursday 2026-08-13, in Q3.
const NOW = new Date(2026, 7, 13, 15, 30).getTime();
const rng = (id) => { const r = Q.presetRange(id, NOW); return `${r.from}..${r.to}`; };
eq("all time clears both bounds", rng("all"), "..");
eq("this month", rng("thisMonth"), "2026-08-01..2026-08-13");
eq("last month spans the whole month", rng("lastMonth"), "2026-07-01..2026-07-31");
eq("last 7 days is inclusive of today", rng("last7"), "2026-08-07..2026-08-13");
eq("last 30 days", rng("last30"), "2026-07-15..2026-08-13");
eq("this quarter starts in July", rng("thisQuarter"), "2026-07-01..2026-08-13");
eq("custom returns null", Q.presetRange("custom", NOW), "null");
// February in a leap year, from the 29th — a classic off-by-one trap.
eq("lastMonth from 2028-03-31", (() => { const r = Q.presetRange("lastMonth", new Date(2028, 2, 31).getTime()); return `${r.from}..${r.to}`; })(), "2028-02-01..2028-02-29");
eq("nextDay rolls the month", Q.nextDay("2026-08-31"), "2026-09-01");
eq("nextDay rolls the year", Q.nextDay("2026-12-31"), "2027-01-01");
eq("nextDay handles leap day", Q.nextDay("2028-02-28"), "2028-02-29");

console.log("\n--- jql building ---");
// Note the default scope is now "all"; these cases set scope explicitly.
const base = { project: "", scope: "worklog", from: "", to: "", advanced: false, jql: "" };

// The scope list must lead with the option that leaves both reports complete —
// a narrower default silently guts the Time in status report.
eq("first scope offered is 'all'", Q.SCOPES[0].id, "all");
eq("...and it is the recommended one", /recommended/.test(Q.SCOPES[0].rec || ""), true);
eq("the worklog scope warns about its cost", /Time in status/.test(Q.SCOPES[1].rec || ""), true);
// Jira's /search/jql rejects a query with no restriction ("Unbounded JQL
// queries are not allowed here"), which "All projects + All time" produces.
eq("no filters never yields a bare sort", Q.buildJql({ ...base, scope: "all" }), "created >= -7300d ORDER BY created DESC");
eq("the open bound is flagged so the UI can explain it", Q.usesOpenBound(base), true);
eq("all-time + all-issues is still bounded", Q.buildJql({ ...base, scope: "all" }), "created >= -7300d ORDER BY created DESC");
eq("a project alone counts as a restriction", Q.usesOpenBound({ ...base, project: "SCRUM", scope: "all" }), false);
eq("a date alone counts as a restriction", Q.usesOpenBound({ ...base, from: "2026-08-01" }), false);
eq("relative dates are unquoted so JQL reads them as durations", />= -7300d(?! *")/.test(Q.buildJql(base)), true);
eq("project only", Q.buildJql({ ...base, project: "SCRUM", scope: "all" }), 'project = "SCRUM" ORDER BY created DESC');
eq(
  "worklog scope uses inclusive <= on the end day",
  Q.buildJql({ ...base, project: "SCRUM", from: "2026-08-01", to: "2026-08-13" }),
  'project = "SCRUM" AND worklogDate >= "2026-08-01" AND worklogDate <= "2026-08-13" ORDER BY created DESC'
);
eq(
  "created scope uses < nextDay so the last day isn't dropped",
  Q.buildJql({ ...base, scope: "created", from: "2026-08-01", to: "2026-08-13" }),
  'created >= "2026-08-01" AND created < "2026-08-14" ORDER BY created DESC'
);
// "All time" must not silently change what the scope means. Reported live:
// every date preset returned only issues with worklogs, but All time returned
// every issue, because the worklogDate clause vanished along with the dates.
eq(
  "All time keeps the worklog constraint",
  Q.buildJql({ ...base, scope: "worklog" }),
  "worklogDate >= -7300d ORDER BY created DESC"
);
eq(
  "All time + project keeps both constraints",
  Q.buildJql({ ...base, scope: "worklog", project: "SCRUM" }),
  'project = "SCRUM" AND worklogDate >= -7300d ORDER BY created DESC'
);
eq(
  "All time under 'updated' constrains on updated",
  Q.buildJql({ ...base, scope: "updated" }),
  "updated >= -7300d ORDER BY created DESC"
);
eq(
  "only 'all' scope falls back to the created bound",
  Q.buildJql({ ...base, scope: "all" }),
  "created >= -7300d ORDER BY created DESC"
);
eq(
  "a one-sided range is left alone",
  Q.buildJql({ ...base, to: "2026-08-13" }),
  'worklogDate <= "2026-08-13" ORDER BY created DESC'
);

eq(
  "all scope ignores the dates",
  Q.buildJql({ ...base, project: "SCRUM", scope: "all", from: "2026-08-01", to: "2026-08-13" }),
  'project = "SCRUM" ORDER BY created DESC'
);
eq("open-ended range emits one bound", Q.buildJql({ ...base, from: "2026-08-01" }), 'worklogDate >= "2026-08-01" ORDER BY created DESC');
eq("advanced mode passes raw JQL through", Q.buildJql({ ...base, advanced: true, jql: "  key = ABC-1  " }), "key = ABC-1");

console.log("\n--- csv ---");
eq("quotes and commas escaped", U.toCsv(["a", "b"], [['x,1', 'he said "hi"']]).split("\r\n")[1], '"x,1","he said ""hi"""');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
