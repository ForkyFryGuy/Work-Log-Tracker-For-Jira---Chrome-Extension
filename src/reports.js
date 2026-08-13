// Pure computation. Nothing here touches the network or the DOM, which makes
// it the easy part to reason about (and the part worth being paranoid about).
var JR = (window.JR = window.JR || {}); // `var` — see util.js

JR.reports = (() => {
  const U = JR.util;

  // ---------------------------------------------------------------------
  // Report A — logged hours by worklog author
  //
  // Grouped by the person who LOGGED the work, not the assignee. That
  // distinction is the entire reason this extension exists.
  // ---------------------------------------------------------------------
  function buildReportA(issues, worklogsByKey, opts) {
    const { fromMs, toMs, groupBy } = opts;
    const byAuthor = new Map();
    let grandSeconds = 0;
    let entriesCounted = 0;
    let entriesSkipped = 0;
    // Cross-check totals: everything we read, vs. what Jira itself claims.
    let allSeconds = 0;
    let jiraSeconds = 0;

    for (const issue of issues) {
      const logs = worklogsByKey.get(issue.key) || [];
      const groupKey = groupValue(issue, groupBy);
      jiraSeconds += Number(issue.fields && issue.fields.timespent) || 0;

      for (const wl of logs) {
        allSeconds += Number(wl.timeSpentSeconds) || 0;
        // The date range filters on `started` — when the work happened —
        // not `created`, which is when someone got around to typing it in.
        const started = U.parseJiraDate(wl.started);
        if (fromMs != null && (started == null || started < fromMs)) {
          entriesSkipped++;
          continue;
        }
        if (toMs != null && (started == null || started > toMs)) {
          entriesSkipped++;
          continue;
        }

        const author = wl.author || {};
        const id = author.accountId || author.displayName || "(unknown)";
        const seconds = Number(wl.timeSpentSeconds) || 0;

        if (!byAuthor.has(id)) {
          byAuthor.set(id, {
            accountId: author.accountId || "",
            name: author.displayName || "(unknown)",
            seconds: 0,
            entries: 0,
            groups: new Map(),
          });
        }
        const row = byAuthor.get(id);
        row.seconds += seconds;
        row.entries += 1;
        row.groups.set(groupKey, (row.groups.get(groupKey) || 0) + seconds);

        grandSeconds += seconds;
        entriesCounted++;
      }
    }

    const rows = [...byAuthor.values()].sort((a, b) => b.seconds - a.seconds);

    // Flat author x group rows, only when a sub-grouping was asked for.
    const groupRows = [];
    if (groupBy !== "none") {
      for (const r of rows) {
        for (const [g, seconds] of r.groups) {
          groupRows.push({ name: r.name, group: g, seconds });
        }
      }
      groupRows.sort((a, b) => b.seconds - a.seconds);
    }

    return { rows, groupRows, grandSeconds, entriesCounted, entriesSkipped, allSeconds, jiraSeconds };
  }

  function groupValue(issue, groupBy) {
    const f = issue.fields || {};
    if (groupBy === "project") return (f.project && f.project.name) || "(no project)";
    if (groupBy === "component") {
      // An issue can carry several components. Splitting the hours across them
      // would be a guess, so we attribute to the first and say so in the UI
      // rather than silently double-counting.
      const c = f.components || [];
      return c.length ? c[0].name : "(no component)";
    }
    return "all";
  }

  // ---------------------------------------------------------------------
  // Report B — time in status
  //
  // Walk the changelog, turn status transitions into spans, measure each span
  // in both calendar and business time.
  // ---------------------------------------------------------------------
  function buildIssueSpans(issue, histories, nowMs) {
    const created = U.parseJiraDate(issue.fields && issue.fields.created);
    if (created == null) return [];

    // Collect status changes, oldest first. Histories are not guaranteed
    // sorted, so sort rather than trust.
    const changes = [];
    for (const h of histories || []) {
      const at = U.parseJiraDate(h.created);
      if (at == null) continue;
      for (const item of h.items || []) {
        const field = item.fieldId || item.field;
        if (field !== "status") continue;
        changes.push({ at, from: item.fromString, to: item.toString });
      }
    }
    changes.sort((a, b) => a.at - b.at);

    const currentStatus = (issue.fields && issue.fields.status && issue.fields.status.name) || "(unknown)";

    // The status the issue was created in isn't recorded anywhere directly;
    // it's the `from` side of the first transition. With no transitions at
    // all, the issue never left its creation status, which is its current one.
    const spans = [];
    if (changes.length === 0) {
      spans.push({ status: currentStatus, start: created, end: null });
      return spans;
    }

    let cursorStatus = changes[0].from || currentStatus;
    let cursorStart = created;

    for (const c of changes) {
      // Guard against clock weirdness / imported issues where a transition
      // predates creation.
      const end = Math.max(c.at, cursorStart);
      spans.push({ status: cursorStatus, start: cursorStart, end });
      cursorStatus = c.to || "(unknown)";
      cursorStart = end;
    }
    // Final, still-running span.
    spans.push({ status: cursorStatus, start: cursorStart, end: null });
    return mergeAdjacent(spans);
  }

  // Jira records self-transitions (To Do -> To Do), and a workflow can route an
  // issue through a transition that lands on the status it started from. Taken
  // literally those look like two separate visits, which inflates the span
  // count and halves the average for that status. An issue cannot leave and
  // re-enter a status without passing through a different one, so adjacent
  // spans sharing a status are one visit and get merged.
  //
  // A genuine bounce-back (A -> B -> A) is NOT adjacent and is left alone.
  function mergeAdjacent(spans) {
    const out = [];
    for (const s of spans) {
      const prev = out[out.length - 1];
      if (prev && prev.status === s.status) prev.end = s.end;
      else out.push({ ...s });
    }
    return out;
  }

  function buildReportB(issues, changelogByKey, cfg) {
    const nowMs = Date.now();
    const perIssue = [];
    const open = [];
    const agg = new Map(); // status -> totals over CLOSED spans only
    // Creating an issue and immediately transitioning it leaves a span of a few
    // seconds in the starting status — a workflow artifact, not time anyone
    // spent. Dropping those is a deliberate trade: it removes noise, but it
    // also discards the fastest real pass-throughs, which nudges averages up.
    // Hence a visible threshold the user can change, not a hidden rule.
    const minSpanMs = Math.max(0, Number(cfg.minSpanMs) || 0);
    let briefSkipped = 0;

    for (const issue of issues) {
      const spans = buildIssueSpans(issue, changelogByKey.get(issue.key), nowMs);
      const f = issue.fields || {};

      for (const span of spans) {
        const isOpen = span.end == null;
        const end = isOpen ? nowMs : span.end;
        const calMs = Math.max(0, end - span.start);

        // The still-open span is never dropped, however brief: you always need
        // to know where an issue is sitting right now.
        if (!isOpen && minSpanMs && calMs < minSpanMs) {
          briefSkipped++;
          continue;
        }

        const busMs = U.businessMs(span.start, end, cfg);

        const row = {
          key: issue.key,
          summary: f.summary || "",
          project: (f.project && f.project.name) || "",
          status: span.status,
          enteredMs: span.start,
          calMs,
          busMs,
          isOpen,
        };
        perIssue.push(row);

        if (isOpen) {
          open.push(row);
          // Deliberately NOT folded into the averages — see below.
          continue;
        }

        if (!agg.has(span.status)) {
          agg.set(span.status, { status: span.status, count: 0, calMs: 0, busMs: 0, issues: new Set() });
        }
        const a = agg.get(span.status);
        a.count += 1;
        a.calMs += calMs;
        a.busMs += busMs;
        a.issues.add(issue.key);
      }
    }

    // Averages run over completed spans only. An issue still sitting in a
    // status has a censored duration: it hasn't finished accumulating. Mixing
    // those in drags every average downward, which is the single most common
    // way tools in this space get the number wrong.
    const perStatus = [...agg.values()]
      .map((a) => ({
        status: a.status,
        count: a.count,
        issues: a.issues.size,
        totalCalMs: a.calMs,
        totalBusMs: a.busMs,
        avgCalMs: a.count ? a.calMs / a.count : 0,
        avgBusMs: a.count ? a.busMs / a.count : 0,
      }))
      .sort((x, y) => y.avgCalMs - x.avgCalMs);

    perIssue.sort((a, b) => (a.key === b.key ? a.enteredMs - b.enteredMs : a.key < b.key ? -1 : 1));
    open.sort((a, b) => b.calMs - a.calMs);

    return { perStatus, perIssue, open, nowMs, briefSkipped, minSpanMs };
  }

  return { buildReportA, buildReportB, buildIssueSpans };
})();
