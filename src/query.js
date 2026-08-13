// Turning the plain-English pickers into JQL. Pure functions, so the query
// this thing builds on your behalf is actually testable.
var JR = (window.JR = window.JR || {}); // `var` — see util.js

JR.query = (() => {
  const U = JR.util;

  const PRESETS = [
    { id: "all", label: "All time" },
    { id: "thisMonth", label: "This month", rec: true },
    { id: "lastMonth", label: "Last month" },
    { id: "last7", label: "Last 7 days" },
    { id: "last30", label: "Last 30 days" },
    { id: "thisQuarter", label: "This quarter" },
  ];

  // Order matters: the first entry is what a new user meets, and it must be the
  // one that leaves both reports correct.
  //
  // The narrower scopes are a speed optimisation, not a correctness one. Hours
  // by person filters worklogs by date in the browser regardless of what the
  // query returned, so restricting the search never changes its numbers — it
  // only makes the search smaller. Time in status has no such safety net: any
  // issue the query skips is simply missing from it.
  const SCOPES = [
    { id: "all", label: "All issues", rec: "recommended — leaves both reports complete" },
    {
      id: "worklog",
      label: "Only issues with time logged in the range",
      rec: "faster, but Time in status will only cover those issues",
    },
    { id: "updated", label: "Only issues updated in the range" },
    { id: "created", label: "Only issues created in the range" },
  ];

  // Returns {from, to} as YYYY-MM-DD strings; empty strings mean "no bound".
  function presetRange(id, nowMs) {
    const now = new Date(nowMs);
    const y = now.getFullYear();
    const m = now.getMonth();
    const iso = U.isoDayLocal;

    switch (id) {
      case "all":
        return { from: "", to: "" };
      case "thisMonth":
        return { from: iso(new Date(y, m, 1)), to: iso(now) };
      case "lastMonth":
        // Day 0 of this month is the last day of the previous one.
        return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
      case "last7":
        return { from: iso(nowMs - 6 * U.DAY), to: iso(now) };
      case "last30":
        return { from: iso(nowMs - 29 * U.DAY), to: iso(now) };
      case "thisQuarter":
        return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(now) };
      default:
        return null; // "custom" — caller keeps whatever dates are set
    }
  }

  function nextDay(isoDay) {
    const [y, m, d] = isoDay.split("-").map(Number);
    return U.isoDayLocal(new Date(y, m - 1, d + 1));
  }

  // 20 years — comfortably older than Jira Cloud itself, so it means "all time"
  // in practice while still counting as a restriction. Relative JQL dates must
  // be unquoted or Jira reads them as a literal string.
  const OPEN_BOUND = "-7300d";
  const DEFAULT_BOUND = `created >= ${OPEN_BOUND}`;

  function buildJql(s) {
    if (s.advanced) return (s.jql || "").trim();

    const parts = [];
    if (s.project) parts.push(`project = "${s.project}"`);

    const field = { worklog: "worklogDate", updated: "updated", created: "created" }[s.scope];
    if (field) {
      if (s.from) parts.push(`${field} >= "${s.from}"`);
      if (s.to) {
        // worklogDate compares whole days, so <= includes the end day. updated
        // and created are timestamps, where <= "2026-08-13" resolves to
        // midnight at the START of that day — which would silently drop the
        // final day of the range. Use < the following day instead.
        if (field === "worklogDate") parts.push(`${field} <= "${s.to}"`);
        else parts.push(`${field} < "${nextDay(s.to)}"`);
      }

      // "All time" leaves both dates empty. Without this, the field clause
      // disappears completely and "issues with time logged" quietly turns into
      // "every issue in the project" — the same dropdown setting meaning two
      // different things depending on the date preset. Keep the field
      // constraint and just open the range right up.
      if (!s.from && !s.to) parts.push(`${field} >= ${OPEN_BOUND}`);
    }

    // /rest/api/3/search/jql rejects a query with no restriction at all
    // ("Unbounded JQL queries are not allowed here"), which is exactly what
    // "All projects" + "All time" produces. Supply a bound wide enough to mean
    // "everything" in practice. It shows up in the query preview, so the user
    // can see what actually ran.
    if (!parts.length) parts.push(DEFAULT_BOUND);

    return parts.join(" AND ") + " ORDER BY created DESC";
  }

  // True whenever the query had no real date bounds and we opened it right up,
  // whichever field that landed on. Drives the explanatory line under the query.
  const usesOpenBound = (s) => !s.advanced && buildJql(s).includes(`>= ${OPEN_BOUND}`);
  const usesDefaultBound = (s) => buildJql(s).startsWith(DEFAULT_BOUND);

  return { PRESETS, SCOPES, presetRange, nextDay, buildJql, OPEN_BOUND, DEFAULT_BOUND, usesDefaultBound, usesOpenBound };
})();
