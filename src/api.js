// All Jira REST access. Every call is a same-origin GET from the Jira tab, so
// the browser attaches the user's existing session cookie automatically. No
// tokens, no OAuth, no admin install.
var JR = (window.JR = window.JR || {}); // `var` — see util.js

JR.api = (() => {
  const { sleep } = JR.util;

  function base() {
    return location.origin;
  }

  async function jfetch(path, control, attempt = 0) {
    if (control && control.cancelled) throw new Error("cancelled");

    const res = await fetch(base() + path, {
      credentials: "include",
      headers: { Accept: "application/json", "X-Atlassian-Token": "no-check" },
    });

    // 429 = rate limited. Jira usually sends Retry-After (seconds).
    if (res.status === 429 && attempt < 4) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 0;
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 15000);
      await sleep(waitMs);
      return jfetch(path, control, attempt + 1);
    }

    // Transient server errors get a couple of backed-off retries.
    if (res.status >= 500 && attempt < 3) {
      await sleep(Math.min(2 ** attempt * 750, 6000));
      return jfetch(path, control, attempt + 1);
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch (_) {}
      const err = new Error(`${res.status} ${res.statusText} on ${path}${detail ? " — " + detail : ""}`);
      err.status = res.status;
      throw err;
    }

    return res.json();
  }

  // `timespent` is Jira's own stored total for the issue. We don't display it,
  // but summing it lets us cross-check our worklog arithmetic against Jira's.
  const SEARCH_FIELDS = "summary,status,created,project,components,assignee,worklog,timespent";

  // Jira Cloud replaced /rest/api/3/search with /rest/api/3/search/jql (token
  // paging instead of startAt). We try the new one and fall back, so this works
  // on either vintage of the API.
  async function searchIssues(jql, opts) {
    const { maxIssues, onProgress, control } = opts;
    try {
      return await searchNew(jql, maxIssues, onProgress, control);
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        return await searchOld(jql, maxIssues, onProgress, control);
      }
      if (err.status === 400 && /unbounded/i.test(err.message)) {
        throw new Error(
          "Jira rejected this search for having no conditions — it needs at least one, not just a sort order. " +
            "Pick a project, choose a date range, or add a condition to the JQL yourself (for example: created >= -365d).\n\nThe search sent was: " +
            jql
        );
      }
      throw err;
    }
  }

  async function searchNew(jql, maxIssues, onProgress, control) {
    const issues = [];
    let token = null;

    while (issues.length < maxIssues) {
      if (control && control.cancelled) break;
      const pageSize = Math.min(100, maxIssues - issues.length);
      const params = new URLSearchParams({
        jql,
        maxResults: String(pageSize),
        fields: SEARCH_FIELDS,
        expand: "changelog",
      });
      if (token) params.set("nextPageToken", token);

      const data = await jfetch("/rest/api/3/search/jql?" + params.toString(), control);
      const batch = data.issues || [];
      issues.push(...batch);
      if (onProgress) onProgress(issues.length, null);

      token = data.nextPageToken;
      if (data.isLast || !token || batch.length === 0) break;
    }
    return issues;
  }

  async function searchOld(jql, maxIssues, onProgress, control) {
    const issues = [];
    let startAt = 0;
    let total = Infinity;

    while (issues.length < maxIssues && startAt < total) {
      if (control && control.cancelled) break;
      const pageSize = Math.min(100, maxIssues - issues.length);
      const params = new URLSearchParams({
        jql,
        startAt: String(startAt),
        maxResults: String(pageSize),
        fields: SEARCH_FIELDS,
        expand: "changelog",
      });

      const data = await jfetch("/rest/api/3/search?" + params.toString(), control);
      const batch = data.issues || [];
      total = typeof data.total === "number" ? data.total : issues.length + batch.length;
      issues.push(...batch);
      if (onProgress) onProgress(issues.length, Math.min(total, maxIssues));

      if (batch.length === 0) break;
      startAt += batch.length;
    }
    return issues;
  }

  // The search response already carries up to ~20 worklogs per issue inline.
  // Only issues that exceed that need their own request — this roughly halves
  // the N+1 problem on typical issue sets.
  async function getWorklogs(issue, control) {
    const inline = issue.fields && issue.fields.worklog;
    if (inline && Array.isArray(inline.worklogs) && inline.total <= inline.worklogs.length) {
      return inline.worklogs;
    }

    const out = [];
    let startAt = 0;
    let total = Infinity;
    while (startAt < total) {
      if (control && control.cancelled) break;
      const data = await jfetch(
        `/rest/api/3/issue/${encodeURIComponent(issue.key)}/worklog?startAt=${startAt}&maxResults=100`,
        control
      );
      const batch = data.worklogs || [];
      total = typeof data.total === "number" ? data.total : out.length + batch.length;
      out.push(...batch);
      if (batch.length === 0) break;
      startAt += batch.length;
    }
    return out;
  }

  // Same trick for the changelog: expand=changelog gives us the histories
  // inline, and we only pay for a second request on long-lived issues.
  async function getChangelog(issue, control) {
    const inline = issue.changelog;
    if (inline && Array.isArray(inline.histories) && inline.total <= inline.histories.length) {
      return inline.histories;
    }

    const out = [];
    let startAt = 0;
    let total = Infinity;
    while (startAt < total) {
      if (control && control.cancelled) break;
      const data = await jfetch(
        `/rest/api/3/issue/${encodeURIComponent(issue.key)}/changelog?startAt=${startAt}&maxResults=100`,
        control
      );
      const batch = data.values || [];
      total = typeof data.total === "number" ? data.total : out.length + batch.length;
      out.push(...batch);
      if (batch.length === 0) break;
      startAt += batch.length;
    }
    return out;
  }

  async function whoAmI(control) {
    return jfetch("/rest/api/3/myself", control);
  }

  // Powers the project dropdown, so nobody has to know their project key.
  async function listProjects(control) {
    const out = [];
    let startAt = 0;
    while (out.length < 500) {
      const data = await jfetch(
        `/rest/api/3/project/search?startAt=${startAt}&maxResults=50&orderBy=name`,
        control
      );
      const batch = data.values || [];
      out.push(...batch.map((p) => ({ key: p.key, name: p.name })));
      if (data.isLast || batch.length === 0) break;
      startAt += batch.length;
    }
    return out;
  }

  return { searchIssues, getWorklogs, getChangelog, whoAmI, listProjects };
})();
