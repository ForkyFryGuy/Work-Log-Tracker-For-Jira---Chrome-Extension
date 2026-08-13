// The panel: query builder, run loop, tables, themes, export.
var JR = (window.JR = window.JR || {}); // `var` — see util.js

(() => {
  const U = JR.util;
  const HOST_ID = "jira-worklog-status-reporter-host";

  const THEMES = [
    { id: "auto", name: "Auto (match Chrome)", c: ["#ffffff", "#1c211f"] },
    { id: "light", name: "Light", c: ["#ffffff", "#2f6f5e"] },
    { id: "dark", name: "Dark", c: ["#1c211f", "#6fbfa3"] },
    { id: "nord", name: "Nord", c: ["#2e3440", "#8fbcbb"] },
    { id: "forest", name: "Forest", c: ["#16201a", "#8fce9b"] },
    { id: "sepia", name: "Sepia", c: ["#f6efe1", "#9c5a2a"] },
    { id: "slate", name: "Slate", c: ["#f7f8fa", "#5c6f8a"] },
    { id: "contrast", name: "High contrast", c: ["#000000", "#ffd400"] },
  ];

  const DEFAULTS = {
    theme: "auto",
    project: "",
    scope: "all",
    datePreset: "last30",
    from: "",
    to: "",
    groupBy: "none",
    maxIssues: 200,
    advanced: false,
    jql: "worklogDate >= -30d",
    unit: "auto",
    workDays: [1, 2, 3, 4, 5],
    workStart: "09:00",
    workEnd: "17:00",
    minSpanSeconds: 60,
    csvDuration: "hours",
    exportCols: null,
    groupSpans: true,
    tab: "a",
    presets: [],
    geom: null,
    seenTutorial: false,
  };

  let settings = { ...DEFAULTS };
  let state = {
    issues: [],
    wlMap: new Map(),
    clMap: new Map(),
    reportA: null,
    reportB: null,
    sort: {},
    filter: {},
    errors: [],
    running: false,
    control: null,
    projects: [],
    lastRun: null,
  };

  // Reloading the extension orphans any content script already running in an
  // open tab: `chrome.*` still exists but every call throws "Extension context
  // invalidated". Nothing here can recover it — the page must be reloaded — so
  // detect it, say so once, and stop throwing on every drag and keystroke.
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  let stale = false;
  function markStale() {
    if (stale) return;
    stale = true;
    try {
      const bar = $("#stale");
      if (bar) {
        // Reports still work — they use fetch, not a chrome API. Only saving is
        // broken, so say exactly that rather than blocking the whole panel.
        bar.innerHTML =
          '<div class="err">This panel lost its connection to the extension, which happens when the extension is reloaded or updated while the page is open.<br>Reports still run, but <b>nothing you change will be saved</b>. Refresh the page to reconnect — anything saved earlier is safe.</div>';
      }
    } catch (_) {}
  }

  const load = () =>
    new Promise((resolve) => {
      if (!extAlive()) {
        markStale();
        return resolve();
      }
      try {
        chrome.storage.local.get("jr.settings", (got) => {
          if (chrome.runtime.lastError) markStale();
          settings = { ...DEFAULTS, ...(got && got["jr.settings"]) };
          if (!settings.from && !settings.to && settings.datePreset !== "all") applyPreset(settings.datePreset, true);
          resolve();
        });
      } catch (_) {
        markStale();
        resolve();
      }
    });

  function save() {
    if (stale) return;
    if (!extAlive()) return markStale();
    try {
      chrome.storage.local.set({ "jr.settings": settings });
    } catch (_) {
      markStale();
    }
  }

  const workCfg = () => ({
    workDays: settings.workDays,
    workStart: settings.workStart,
    workEnd: settings.workEnd,
    minSpanMs: (Number(settings.minSpanSeconds) || 0) * 1000,
  });

  // ---------------------------------------------------------------------
  // Query building lives in query.js so it can be unit-tested.
  // ---------------------------------------------------------------------
  const PRESETS = JR.query.PRESETS;
  const SCOPES = JR.query.SCOPES;
  const buildJql = () => JR.query.buildJql(settings);

  function applyPreset(id, quiet) {
    const range = JR.query.presetRange(id, Date.now());
    if (!range) return; // "custom" — leave the dates alone
    settings.datePreset = id;
    settings.from = range.from;
    settings.to = range.to;
    if (!quiet) {
      save();
      fillForm();
    }
  }

  // ---------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------
  const dur = (ms, dayMs) => U.formatMs(ms, settings.unit, dayMs);
  const csvDur = (ms, dayMs) =>
    settings.csvDuration === "hours" ? (ms / U.HOUR).toFixed(2) : U.formatMs(ms, "auto", dayMs);

  const calCol = (id, label, pick) => ({
    id,
    label,
    num: true,
    cell: (r) => dur(pick(r), U.DAY),
    csv: (r) => csvDur(pick(r), U.DAY),
    sortVal: pick,
  });

  const busCol = (id, label, pick) => ({
    id,
    label,
    num: true,
    cell: (r) => dur(pick(r), U.businessDayMs(workCfg())),
    csv: (r) => csvDur(pick(r), U.businessDayMs(workCfg())),
    sortVal: pick,
  });

  const dateCell = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");

  // Same status name always gets the same colour, so rows group visually.
  function hue(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  const statusChip = (name) => `<span class="st" style="--st:hsl(${hue(String(name))},55%,52%)">${esc(name)}</span>`;

  const statusCol = (id, label) => ({
    id,
    label,
    html: true,
    cell: (r) => statusChip(r.status),
    csv: (r) => r.status,
    sortVal: (r) => r.status,
    on: true,
  });

  // Adds a proportional bar under the number.
  const withBar = (col, pick) => ({ ...col, bar: pick });

  const keyCol = {
    id: "key",
    label: "Key",
    html: true,
    cell: (r) => `<a class="lnk" href="${location.origin}/browse/${encodeURIComponent(r.key)}" target="_blank" rel="noreferrer">${esc(r.key)}</a>`,
    csv: (r) => r.key,
    sortVal: (r) => r.key,
    on: true,
  };

  const TABLES = {
    a: {
      title: "Hours logged, by person",
      file: "jira-hours-by-person",
      rows: () => (state.reportA ? state.reportA.rows : []),
      columns: [
        { id: "name", label: "Person", cell: (r) => r.name, csv: (r) => r.name, sortVal: (r) => r.name, on: true },
        { id: "accountId", label: "Account ID", cell: (r) => r.accountId, csv: (r) => r.accountId, sortVal: (r) => r.accountId, on: false },
        { id: "hours", label: "Hours", num: true, cell: (r) => U.hours2(r.seconds), csv: (r) => U.hours2(r.seconds), sortVal: (r) => r.seconds, on: true },
        { id: "entries", label: "Entries", num: true, cell: (r) => r.entries, csv: (r) => r.entries, sortVal: (r) => r.entries, on: true },
        { id: "share", label: "Share", num: true, cell: (r) => pct(r.seconds), csv: (r) => pct(r.seconds), sortVal: (r) => r.seconds, on: true },
      ],
      totalRow: () =>
        state.reportA && state.reportA.rows.length
          ? { name: "TOTAL", accountId: "", seconds: state.reportA.grandSeconds, entries: state.reportA.entriesCounted }
          : null,
    },

    aGroup: {
      title: "Each person's hours, broken down",
      file: "jira-hours-by-person-group",
      rows: () => (state.reportA ? state.reportA.groupRows : []),
      columns: [
        { id: "name", label: "Person", cell: (r) => r.name, csv: (r) => r.name, sortVal: (r) => r.name, on: true },
        { id: "group", label: "Group", cell: (r) => r.group, csv: (r) => r.group, sortVal: (r) => r.group, on: true },
        { id: "hours", label: "Hours", num: true, cell: (r) => U.hours2(r.seconds), csv: (r) => U.hours2(r.seconds), sortVal: (r) => r.seconds, on: true },
      ],
    },

    bStatus: {
      title: "How long things sit in each status",
      file: "jira-time-in-status-averages",
      rows: () => (state.reportB ? state.reportB.perStatus : []),
      columns: [
        statusCol("status", "Status"),
        { id: "count", label: "Finished visits", num: true, cell: (r) => r.count, csv: (r) => r.count, sortVal: (r) => r.count, on: true },
        { id: "issues", label: "Issues", num: true, cell: (r) => r.issues, csv: (r) => r.issues, sortVal: (r) => r.issues, on: true },
        { ...withBar(calCol("avgCal", "Avg clock time", (r) => r.avgCalMs), (r) => r.avgCalMs), on: true },
        { ...busCol("avgBus", "Avg work hours", (r) => r.avgBusMs), on: true },
        { ...calCol("totCal", "Total clock time", (r) => r.totalCalMs), on: false },
        { ...busCol("totBus", "Total work hours", (r) => r.totalBusMs), on: false },
      ],
    },

    bIssue: {
      title: "Every status change, issue by issue",
      file: "jira-time-in-status-by-issue",
      rows: () => (state.reportB ? state.reportB.perIssue : []),
      columns: [
        keyCol,
        { id: "summary", label: "Summary", trunc: true, cell: (r) => r.summary, csv: (r) => r.summary, sortVal: (r) => r.summary, on: true },
        { id: "project", label: "Project", cell: (r) => r.project, csv: (r) => r.project, sortVal: (r) => r.project, on: false },
        statusCol("status", "Status"),
        { id: "entered", label: "Entered", cell: (r) => dateCell(r.enteredMs), csv: (r) => new Date(r.enteredMs).toISOString(), sortVal: (r) => r.enteredMs, on: true },
        { ...withBar(calCol("cal", "Clock time", (r) => r.calMs), (r) => r.calMs), on: true },
        { ...busCol("bus", "Work hours", (r) => r.busMs), on: true },
        {
          id: "state",
          label: "Still there?",
          html: true,
          cell: (r) => (r.isOpen ? '<span class="tag open">still there</span>' : '<span class="tag">moved on</span>'),
          csv: (r) => (r.isOpen ? "still there" : "moved on"),
          sortVal: (r) => (r.isOpen ? 1 : 0),
          on: true,
        },
      ],
    },

    bOpen: {
      title: "Still in their current status",
      file: "jira-currently-in-status",
      rows: () => (state.reportB ? state.reportB.open : []),
      columns: [
        keyCol,
        { id: "summary", label: "Summary", trunc: true, cell: (r) => r.summary, csv: (r) => r.summary, sortVal: (r) => r.summary, on: true },
        statusCol("status", "Current status"),
        { id: "entered", label: "Since", cell: (r) => dateCell(r.enteredMs), csv: (r) => new Date(r.enteredMs).toISOString(), sortVal: (r) => r.enteredMs, on: true },
        { ...withBar(calCol("cal", "Clock time so far", (r) => r.calMs), (r) => r.calMs), on: true },
        { ...busCol("bus", "Work hours so far", (r) => r.busMs), on: true },
      ],
    },
  };

  function pct(seconds) {
    const total = state.reportA ? state.reportA.grandSeconds : 0;
    return total ? ((seconds / total) * 100).toFixed(1) + "%" : "";
  }

  function selectedCols(tableId) {
    const t = TABLES[tableId];
    const saved = settings.exportCols && settings.exportCols[tableId];
    if (!saved) return t.columns.filter((c) => c.on !== false);
    return t.columns.filter((c) => saved.includes(c.id));
  }

  // ---------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------
  let shadow = null;
  const $ = (sel) => shadow.querySelector(sel);
  const $$ = (sel) => [...shadow.querySelectorAll(sel)];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  const stripTags = (s) => String(s == null ? "" : s).replace(/<[^>]*>/g, "");

  function matchRow(cols, row, q) {
    if (!q) return true;
    return cols.map((c) => stripTags(c.cell(row))).join(" ").toLowerCase().includes(q);
  }

  function visibleRows(tableId, cols) {
    const q = (state.filter[tableId] || "").trim().toLowerCase();
    return TABLES[tableId].rows().filter((r) => matchRow(cols, r, q));
  }

  // ---------------------------------------------------------------------
  // Panel
  // ---------------------------------------------------------------------
  function buildPanel() {
    const host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "open" });

    try {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = chrome.runtime.getURL("src/panel.css");
      shadow.appendChild(link);
    } catch (_) {
      markStale(); // orphaned context: getURL throws too
    }

    const wrap = document.createElement("div");
    wrap.className = "panel";
    wrap.setAttribute("data-theme", settings.theme);
    wrap.innerHTML = template();
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    applyGeom(wrap);
    wire();
    return host;
  }

  function applyGeom(panel) {
    const g = settings.geom;
    if (!g) return;
    panel.style.left = g.left + "px";
    panel.style.top = g.top + "px";
    panel.style.right = "auto";
    if (g.w) panel.style.width = g.w + "px";
    if (g.h) panel.style.height = g.h + "px";
  }

  function template() {
    return `
      <div class="hdr" id="hdr">
        <h1>Worklog &amp; Status Reporter<span class="site">${esc(location.host)}</span></h1>
        <button class="icon" id="goHelp" title="New here? Start here">How this works</button>
        <button class="icon" id="goTheme" title="Colours and theme">Appearance</button>
        <button class="icon" id="close" title="Close (Esc)">&times;</button>
      </div>
      <div class="body">

        <div id="simple">
          <div class="row">
            <div class="f grow">
              <label for="project">Project</label>
              <select id="project"><option value="">Loading your projects…</option></select>
            </div>
            <div class="f">
              <label for="maxIssues">Max issues</label>
              <input type="number" id="maxIssues" min="1" max="5000" style="width:88px">
            </div>
            <button class="primary" id="run" title="Ctrl+Enter">Run report</button>
            <button id="cancel" style="display:none">Stop</button>
          </div>

          <div class="f" style="margin-bottom:8px">
            <label>Date range</label>
            <div class="chips" id="chips"></div>
          </div>

          <div class="row">
            <div class="f"><label for="from">From</label><input type="date" id="from"></div>
            <div class="f"><label for="to">To</label><input type="date" id="to"></div>
            <div class="f grow">
              <label for="scope">Which issues to look at</label>
              <select id="scope"></select>
            </div>
          </div>
          <p class="help" id="scopeHelp"></p>

          <div class="row">
            <div class="f grow">
              <label for="groupBy">Split each person's hours by</label>
              <select id="groupBy">
                <option value="none">Nothing — one total per person</option>
                <option value="project">Project</option>
                <option value="component">Component</option>
              </select>
            </div>
          </div>
          <p class="help">Adds a second table with the breakdown. The main table is unchanged.</p>
        </div>

        <div class="jqlbar">
          <span>Query</span>
          <code id="jqlPreview"></code>
          <label class="chk" style="white-space:nowrap"><input type="checkbox" id="advanced"> Write the JQL myself</label>
        </div>
        <p class="help" id="jqlHint"></p>
        <div id="advBox" style="display:none">
          <textarea id="jql" rows="2" spellcheck="false"></textarea>
          <p class="help">While this is ticked, the pickers above are ignored.</p>
        </div>

        <div class="row" style="gap:6px;align-items:center">
          <span class="lbl">Saved searches</span>
          <select id="presetSel" style="min-width:150px"><option value="">—</option></select>
          <button class="ghost" id="presetSave">Save this search…</button>
          <button class="ghost" id="presetDel">Delete</button>
          <span class="count" id="lastRun"></span>
        </div>
        <div class="row" id="presetNameBox" style="display:none">
          <input type="text" id="presetName" placeholder="Name this search" style="min-width:200px">
          <button class="primary" id="presetConfirm">Save</button>
          <button class="ghost" id="presetCancelBtn">Cancel</button>
        </div>

        <div id="stale"></div>
        <div id="status"></div>
        <div id="errors"></div>

        <div class="tabs">
          <button class="tab" data-tab="a">Hours by person</button>
          <button class="tab" data-tab="b">Time in status</button>
          <button class="tab" data-tab="export">Export</button>
          <button class="tab" data-tab="settings">Settings</button>
          <button class="tab" data-tab="help">How this works</button>
        </div>

        <div class="pane" data-pane="a"><p class="note">Nothing here yet — run a report and the numbers will show up.</p></div>

        <div class="pane" data-pane="b">
          <div class="row">
            <div class="f">
              <label for="unit">Show times as</label>
              <select id="unit">
                <option value="auto">Automatic — 2d 3h</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </div>
          </div>
          <div id="bBody"><p class="note">Nothing here yet — run a report and the numbers will show up.</p></div>
        </div>

        <div class="pane" data-pane="export">
          <div class="row">
            <div class="f grow">
              <label for="csvDuration">Time format in the CSV</label>
              <select id="csvDuration">
                <option value="hours">Decimal hours — 7.50, so Excel can total them</option>
                <option value="human">Readable — 2d 3h, but Excel can't total it</option>
              </select>
            </div>
            <button id="exportAll">Download every table</button>
          </div>
          <div id="exportBody"></div>
        </div>

        <div class="pane" data-pane="settings">
          <div class="card">
            <h3>Theme</h3>
            <div class="swatches" id="swatches"></div>
            <p class="help" id="themeName" style="margin-top:8px"></p>
          </div>
          <div class="card">
            <h3>Your working hours</h3>
            <p class="note">The “work hours” columns count only the time inside this window, measured in this browser's timezone.</p>
            <div class="row">
              <div class="f"><label for="workStart">Day starts</label><input type="time" id="workStart"></div>
              <div class="f"><label for="workEnd">Day ends</label><input type="time" id="workEnd"></div>
            </div>
            <div class="f"><label>Working days</label><div class="cols" id="workDays"></div></div>
            <p class="help">There's no holiday calendar, so public holidays count as normal working days.</p>
          </div>
          <div class="card">
            <h3>Very short status changes</h3>
            <div class="row">
              <div class="f">
                <label for="minSpan">Ignore anything shorter than</label>
                <input type="number" id="minSpan" min="0" max="86400" style="width:100px">
              </div>
              <span class="muted" style="padding-bottom:7px">seconds</span>
            </div>
            <p class="help">Create an issue and move it on immediately, and Jira records a few seconds in the status
              you started from. That's a workflow artefact, not time anyone spent. The trade-off: ignoring
              those also discards genuinely fast steps, which nudges your averages <i>up</i> slightly.
              Set this to 0 to keep every status change. Whatever status an issue is in right now always
              shows, however briefly it's been there.</p>
          </div>
          <div class="card">
            <h3>Reset</h3>
            <button id="reset">Reset all settings</button>
            <p class="help">This deletes your saved searches too.</p>
          </div>
        </div>

        <div class="pane" data-pane="help">${tutorialHtml()}</div>
      </div>`;
  }

  function tutorialHtml() {
    const step = (n, title, body) =>
      `<div class="step"><div class="n">${n}</div><div><p><b>${title}</b></p><p class="note" style="margin:0">${body}</p></div></div>`;

    return `
      <h2>What this does</h2>
      <p class="note">Two reports Jira can't produce on its own. Everything is read live from Jira using the
        login you're already signed in with — nothing is uploaded, stored, or shared.</p>

      <div class="card">
        <h3>Hours by person</h3>
        <p class="note" style="margin:0">How many hours each person logged. Jira's own reports count by who an
          issue is <i>assigned</i> to, which is a different question — people routinely log time on issues that
          aren't theirs. This counts by who actually logged it, across every issue they touched.</p>
      </div>

      <div class="card">
        <h3>Time in status</h3>
        <p class="note" style="margin:0">How long issues sat in To Do, In Progress, Review and so on, worked out
          from each issue's own history. This is the report that shows where work piles up.</p>
      </div>

      <h2>Running a report</h2>
      ${step(1, "Pick a project", "The dropdown lists every project you can see. Leave it on “All projects” to search all of them.")}
      ${step(2, "Pick a date range", "The buttons cover the common cases. <b>This month</b> is the usual choice; <b>All time</b> removes the limit.")}
      ${step(3, "Choose which issues to include", "For Hours by person, keep the default. For Time in status, switch to “All issues, ignoring the dates” — an issue's history is unrelated to whether anyone logged hours on it, so filtering by worklogs would hide most of it.")}
      ${step(4, "Click Run report", "Or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>. Large searches take a while; there's a progress bar, and Stop cancels.")}
      ${step(5, "Read the results", "Click any column heading to sort by it. The box above each table filters rows as you type. Issue keys link back to Jira.")}
      ${step(6, "Export", "In the Export tab, tick the columns you want and download a CSV. Your choices are remembered.")}

      <h2>Hours logged vs time in status</h2>
      <p class="note">These measure different things and are never combined. <b>Hours logged</b> is effort
        someone typed in — “3h on this”. <b>Time in status</b> is elapsed clock time from the issue's history.
        The same issue can show 4 hours logged and 11 days in status, and both are correct.</p>

      <h2>Clock time vs work hours</h2>
      <p class="note">Every duration appears twice. <b>Clock time</b> is raw elapsed time — an issue sitting over
        a weekend reads 3 days. <b>Work hours</b> counts only time inside your working day (Settings; Mon–Fri
        9–5 by default), so the same issue reads 8 hours.</p>

      <h2>Why some issues are left out of averages</h2>
      <p class="note">An issue still sitting in a status hasn't finished its stay — nobody yet knows how long it
        will take. Including those unfinished numbers would drag every average down and make the team look
        faster than it is. So averages count only issues that have already left the status, and anything still
        in progress appears in its own table instead.</p>

      <h2>Shortcuts</h2>
      <p class="note">
        <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> opens and closes this panel · <kbd>Esc</kbd> closes it ·
        <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs the report · drag the title bar to move it, or the bottom-right
        corner to resize · <b>Saved searches</b> stores a query you run regularly.
      </p>`;
  }

  const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function wire() {
    const panel = shadow.querySelector(".panel");

    $("#close").onclick = () => toggle(false);
    $("#goHelp").onclick = () => selectTab("help");
    $("#goTheme").onclick = () => selectTab("settings");
    $("#run").onclick = run;
    $("#cancel").onclick = () => state.control && (state.control.cancelled = true);

    $("#reset").onclick = () => {
      settings = { ...DEFAULTS };
      applyPreset(settings.datePreset, true);
      save();
      panel.setAttribute("data-theme", settings.theme);
      fillForm();
      renderAll();
    };

    $$(".tab").forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

    // Date preset chips
    $("#chips").innerHTML = PRESETS.map(
      (p) => `<button class="chip" data-preset="${p.id}">${esc(p.label)}${p.rec ? '<span class="rec">rec</span>' : ""}</button>`
    ).join("");
    $$("#chips .chip").forEach((b) => (b.onclick = () => applyPreset(b.dataset.preset)));

    // Scope select
    $("#scope").innerHTML = SCOPES.map(
      (s) => `<option value="${s.id}">${esc(s.label)}${s.rec ? ` — ${esc(s.rec)}` : ""}</option>`
    ).join("");
    $("#scope").onchange = (e) => {
      settings.scope = e.target.value;
      save();
      updateScopeHelp();
      updateJqlPreview();
    };

    $("#project").onchange = (e) => {
      settings.project = e.target.value;
      save();
      updateJqlPreview();
    };

    const bindDate = (id, key) => {
      $("#" + id).onchange = (e) => {
        settings[key] = e.target.value;
        settings.datePreset = "custom";
        save();
        markChips();
        updateJqlPreview();
      };
    };
    bindDate("from", "from");
    bindDate("to", "to");

    $("#maxIssues").oninput = (e) => {
      settings.maxIssues = Math.max(1, Math.min(5000, Number(e.target.value) || 1));
      save();
    };

    $("#groupBy").onchange = (e) => {
      settings.groupBy = e.target.value;
      save();
      if (state.issues.length) recompute();
    };

    $("#advanced").onchange = (e) => {
      settings.advanced = e.target.checked;
      save();
      $("#advBox").style.display = settings.advanced ? "" : "none";
      $("#simple").style.display = settings.advanced ? "none" : "";
      updateJqlPreview();
    };
    $("#jql").oninput = (e) => {
      settings.jql = e.target.value;
      save();
      updateJqlPreview();
    };

    $("#unit").onchange = (e) => {
      settings.unit = e.target.value;
      save();
      renderAll();
    };
    $("#csvDuration").onchange = (e) => {
      settings.csvDuration = e.target.value;
      save();
    };
    $("#exportAll").onclick = () => {
      Object.keys(TABLES).forEach((id, i) => {
        if (TABLES[id].rows().length) setTimeout(() => exportCsv(id), i * 250);
      });
    };

    // Working window
    const rebuildB = () => {
      save();
      if (state.issues.length) recompute();
    };
    $("#workStart").onchange = (e) => {
      settings.workStart = e.target.value;
      rebuildB();
    };
    $("#workEnd").onchange = (e) => {
      settings.workEnd = e.target.value;
      rebuildB();
    };
    $("#minSpan").onchange = (e) => {
      settings.minSpanSeconds = Math.max(0, Math.min(86400, Number(e.target.value) || 0));
      rebuildB();
    };
    $("#workDays").innerHTML = DAY_NAMES.map(
      (n, i) => `<label class="chk"><input type="checkbox" data-day="${i}"> ${n}</label>`
    ).join("");
    $$("#workDays input").forEach((cb) => {
      cb.onchange = () => {
        const set = new Set(settings.workDays);
        cb.checked ? set.add(Number(cb.dataset.day)) : set.delete(Number(cb.dataset.day));
        settings.workDays = [...set].sort();
        rebuildB();
      };
    });

    // Themes
    $("#swatches").innerHTML = THEMES.map(
      (t) =>
        `<button class="sw" data-theme="${t.id}" title="${esc(t.name)}" style="background:linear-gradient(135deg, ${t.c[0]} 50%, ${t.c[1]} 50%)"></button>`
    ).join("");
    $$("#swatches .sw").forEach((b) => {
      b.onclick = () => {
        settings.theme = b.dataset.theme;
        save();
        panel.setAttribute("data-theme", settings.theme);
        markThemes();
      };
    });

    // Saved views
    $("#presetSave").onclick = () => {
      $("#presetNameBox").style.display = "";
      $("#presetName").focus();
    };
    $("#presetCancelBtn").onclick = () => ($("#presetNameBox").style.display = "none");
    $("#presetConfirm").onclick = () => {
      const name = $("#presetName").value.trim();
      if (!name) return;
      const view = {
        name,
        project: settings.project,
        scope: settings.scope,
        datePreset: settings.datePreset,
        from: settings.from,
        to: settings.to,
        groupBy: settings.groupBy,
        maxIssues: settings.maxIssues,
        advanced: settings.advanced,
        jql: settings.jql,
      };
      settings.presets = settings.presets.filter((p) => p.name !== name).concat([view]);
      save();
      $("#presetName").value = "";
      $("#presetNameBox").style.display = "none";
      fillPresets(name);
    };
    $("#presetDel").onclick = () => {
      const name = $("#presetSel").value;
      if (!name) return;
      settings.presets = settings.presets.filter((p) => p.name !== name);
      save();
      fillPresets("");
    };
    $("#presetSel").onchange = (e) => {
      const p = settings.presets.find((x) => x.name === e.target.value);
      if (!p) return;
      Object.assign(settings, p);
      delete settings.name;
      save();
      fillForm();
      fillPresets(p.name);
    };

    installKeyGuard();

    makeDraggable($("#hdr"), panel);

    // Remember size after a resize-handle drag.
    if (window.ResizeObserver) {
      let t = null;
      new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          const r = panel.getBoundingClientRect();
          settings.geom = { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
          save();
        }, 400);
      }).observe(panel);
    }

    loadProjects();
  }

  async function loadProjects() {
    const sel = $("#project");
    try {
      const projects = await JR.api.listProjects(null);
      state.projects = projects;
      sel.innerHTML =
        '<option value="">All projects</option>' +
        projects.map((p) => `<option value="${esc(p.key)}">${esc(p.name)} (${esc(p.key)})</option>`).join("");
      sel.value = settings.project || "";
      if (sel.value !== (settings.project || "")) {
        // Saved project no longer exists (or isn't visible) — fall back safely.
        settings.project = "";
        sel.value = "";
        save();
      }
    } catch (err) {
      sel.innerHTML = '<option value="">All projects</option>';
      state.errors.push("Couldn't load your list of projects: " + err.message + "\nYou can still run across all projects, or write the JQL yourself.");
      showErrors();
    }
    updateJqlPreview();
  }

  // Jira registers global keyboard shortcuts on `document`. Shadow DOM
  // retargets events on the way out, so Jira sees our keystrokes as coming from
  // a plain <div> rather than a text field, decides nobody is typing, and fires
  // the shortcut — pressing "f" in a filter box opened Jira's search and stole
  // focus.
  //
  // Listening on `document` in the CAPTURE phase means we see the event on the
  // way down, before it can reach Jira's handlers, and can stop it there. The
  // panel's own shortcuts have to be handled here too, since stopping
  // propagation also prevents the event reaching listeners inside the panel.
  // Typing itself is unaffected: stopPropagation doesn't cancel the default
  // action, only delivery to other listeners.
  let keyGuardInstalled = false;
  function installKeyGuard() {
    if (keyGuardInstalled) return;
    keyGuardInstalled = true;

    const isOurs = (e) => {
      const host = document.getElementById(HOST_ID);
      if (!host || host.style.display === "none") return false;
      return typeof e.composedPath === "function" ? e.composedPath().includes(host) : false;
    };

    document.addEventListener(
      "keydown",
      (e) => {
        if (!isOurs(e)) return;
        if (e.key === "Escape") {
          e.preventDefault();
          toggle(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          run();
        }
        e.stopPropagation();
      },
      true
    );

    // Jira's shortcut handling may bind any of these; block all three.
    ["keypress", "keyup"].forEach((type) => {
      document.addEventListener(type, (e) => isOurs(e) && e.stopPropagation(), true);
    });
  }

  function fillForm() {
    $("#from").value = settings.from;
    $("#to").value = settings.to;
    $("#scope").value = settings.scope;
    $("#groupBy").value = settings.groupBy;
    $("#maxIssues").value = settings.maxIssues;
    $("#unit").value = settings.unit;
    $("#csvDuration").value = settings.csvDuration;
    $("#workStart").value = settings.workStart;
    $("#workEnd").value = settings.workEnd;
    $("#minSpan").value = settings.minSpanSeconds;
    $("#advanced").checked = settings.advanced;
    $("#jql").value = settings.jql;
    $("#advBox").style.display = settings.advanced ? "" : "none";
    $("#simple").style.display = settings.advanced ? "none" : "";
    if (state.projects.length) $("#project").value = settings.project || "";
    $$("#workDays input").forEach((cb) => (cb.checked = settings.workDays.includes(Number(cb.dataset.day))));
    markChips();
    markThemes();
    updateScopeHelp();
    updateJqlPreview();
    fillPresets($("#presetSel") ? $("#presetSel").value : "");
    selectTab(settings.seenTutorial ? settings.tab || "a" : "help");
    settings.seenTutorial = true;
    save();
  }

  function fillPresets(selected) {
    const sel = $("#presetSel");
    sel.innerHTML =
      '<option value="">—</option>' + settings.presets.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
    sel.value = selected || "";
  }

  function markChips() {
    $$("#chips .chip").forEach((b) => b.classList.toggle("on", b.dataset.preset === settings.datePreset));
  }

  function markThemes() {
    $$("#swatches .sw").forEach((b) => b.classList.toggle("on", b.dataset.theme === settings.theme));
    const t = THEMES.find((x) => x.id === settings.theme);
    $("#themeName").textContent = t ? t.name : "";
  }

  function updateScopeHelp() {
    const map = {
      all: "Searches everything, then the date range is applied to worklogs afterwards. Both reports come out complete. Slower on a large project — watch the max-issues limit.",
      worklog: "Searches only issues with time logged in the range. Hours by person is unaffected (it filters by date in the browser anyway), but Time in status will only cover issues someone happened to log time against — usually not what you want from it.",
      updated: "Only issues that changed during the range. Time in status will cover just those issues.",
      created: "Only issues raised during the range. Useful for “how long did this quarter's work take?”",
    };
    $("#scopeHelp").textContent = map[settings.scope] || "";
  }

  function updateJqlPreview() {
    $("#jqlPreview").textContent = buildJql();
    const hint = $("#jqlHint");
    if (hint) {
      // Explain the bound rather than letting it look like something we made up.
      hint.textContent =
        !settings.advanced && JR.query.usesOpenBound(settings)
          ? "“All time” has no end points to search between, so this asks for the last 20 years — everything, in practice."
          : "";
    }
  }

  function selectTab(tab) {
    settings.tab = tab;
    save();
    $$(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    $$(".pane").forEach((p) => p.classList.toggle("on", p.dataset.pane === tab));
  }

  function makeDraggable(handle, panel) {
    let sx = 0, sy = 0, sl = 0, st = 0, dragging = false;
    handle.addEventListener("mousedown", (e) => {
      if (e.target.tagName === "BUTTON") return;
      const r = panel.getBoundingClientRect();
      dragging = true;
      sx = e.clientX;
      sy = e.clientY;
      sl = r.left;
      st = r.top;
      panel.style.right = "auto";
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      panel.style.left = Math.max(0, sl + e.clientX - sx) + "px";
      panel.style.top = Math.max(0, st + e.clientY - sy) + "px";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      const r = panel.getBoundingClientRect();
      settings.geom = { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      save();
    });
  }

  // ---------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------
  const setStatus = (html) => ($("#status").innerHTML = html);

  function showErrors() {
    $("#errors").innerHTML = state.errors.length ? `<div class="err">${esc(state.errors.join("\n"))}</div>` : "";
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.errors = [];
    showErrors();
    state.control = { cancelled: false };
    $("#run").disabled = true;
    $("#cancel").style.display = "";

    const control = state.control;
    const bar = (label, done, total) => {
      const w = total ? Math.round((done / total) * 100) : 100;
      setStatus(
        `<div class="note" style="margin-bottom:2px">${esc(label)} ${done}${total ? " / " + total : ""}</div>
         <div class="progress"><i style="width:${w}%"></i></div>`
      );
    };

    try {
      const jql = buildJql();
      bar("Looking for issues…", 0, null);
      const issues = await JR.api.searchIssues(jql, {
        maxIssues: settings.maxIssues,
        control,
        onProgress: (n) => bar("Looking for issues…", n, null),
      });

      if (control.cancelled) throw new Error("cancelled");
      if (!issues.length) {
        state.issues = [];
        state.reportA = state.reportB = null;
        setStatus('<div class="note">No issues matched. Try “All time”, a different project, or set “which issues” to “All issues, ignoring the dates”.</div>');
        renderAll();
        return;
      }

      const worklogs = await U.pool(issues, 5, (i) => JR.api.getWorklogs(i, control), (d, t) => bar("Reading worklogs…", d, t), control);
      if (control.cancelled) throw new Error("cancelled");

      const changelogs = await U.pool(issues, 5, (i) => JR.api.getChangelog(i, control), (d, t) => bar("Reading status history…", d, t), control);
      if (control.cancelled) throw new Error("cancelled");

      const wlMap = new Map();
      const clMap = new Map();
      let failed = 0;
      issues.forEach((issue, i) => {
        const w = worklogs[i];
        const c = changelogs[i];
        if (w && w.__error) failed++;
        else wlMap.set(issue.key, w || []);
        if (c && c.__error) failed++;
        else clMap.set(issue.key, c || []);
      });
      if (failed) state.errors.push(`${failed} request${failed === 1 ? "" : "s"} failed, so some issues are missing from these numbers.`);

      state.issues = issues;
      state.wlMap = wlMap;
      state.clMap = clMap;
      state.lastRun = Date.now();
      recompute();

      const hitCap = issues.length >= settings.maxIssues;
      setStatus(
        `<div class="note">${issues.length} issues · ${state.reportA.entriesCounted} worklog entr${
          state.reportA.entriesCounted === 1 ? "y" : "ies"
        } inside your dates${state.reportA.entriesSkipped ? `, ${state.reportA.entriesSkipped} outside them` : ""}${
          hitCap ? " · <b>hit the max-issues limit</b> — raise it, or narrow the search" : ""
        }</div>`
      );
      $("#lastRun").textContent = "Last run at " + new Date(state.lastRun).toLocaleTimeString();
      showErrors();
    } catch (err) {
      if (String(err.message) === "cancelled") {
        setStatus('<div class="note">Stopped.</div>');
      } else {
        setStatus("");
        state.errors.push(err.message || String(err));
        showErrors();
      }
    } finally {
      state.running = false;
      state.control = null;
      $("#run").disabled = false;
      $("#cancel").style.display = "none";
    }
  }

  function recompute() {
    state.reportA = JR.reports.buildReportA(state.issues, state.wlMap, {
      fromMs: U.dayStart(settings.from),
      toMs: U.dayEnd(settings.to),
      groupBy: settings.groupBy,
    });
    state.reportB = JR.reports.buildReportB(state.issues, state.clMap, workCfg());
    renderAll();
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  // Renders one cell, including the proportional bar and truncation tooltip.
  function cellHtml(c, r, barMax) {
    const raw = c.cell(r);
    const inner = c.html ? raw : esc(raw);
    const cls = (c.num ? "num " : "") + (c.trunc ? "trunc" : "");
    const title = c.trunc ? ` title="${esc(raw)}"` : "";

    if (c.bar && barMax[c.id]) {
      const w = Math.max(1, Math.round((c.bar(r) / barMax[c.id]) * 100));
      return `<td class="${cls}"><div class="cb"><span>${inner}</span><i style="width:${w}%"></i></div></td>`;
    }
    return `<td class="${cls}"${title}>${inner}</td>`;
  }

  function sortRows(tableId, cols, rows) {
    const sort = state.sort[tableId];
    if (!sort) return rows;
    const col = cols.find((c) => c.id === sort.col);
    if (!col) return rows;
    const f = col.sortVal || col.csv;
    return rows.slice().sort((a, b) => {
      const x = f(a), y = f(b);
      const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "desc" ? -r : r;
    });
  }

  function barMaxes(cols, data) {
    const max = {};
    cols.forEach((c) => {
      if (!c.bar) return;
      // Deliberately a reduce, not Math.max(...array): spreading a large array
      // into a call blows the argument limit and throws RangeError. A big query
      // can easily produce tens of thousands of spans.
      max[c.id] = data.reduce((m, r) => Math.max(m, c.bar(r) || 0), 1);
    });
    return max;
  }

  const grpToggle = () =>
    `<label class="chk grpchk" title="Untick for a flat table you can sort by any column"><input type="checkbox" id="grpSpans" ${
      settings.groupSpans ? "checked" : ""
    }> Group by issue</label>`;

  function tableBar(tableId, shown, all, extra) {
    return `
      <div class="tablebar">
        <input type="search" placeholder="Filter rows…" data-filter="${tableId}" value="${esc(state.filter[tableId] || "")}">
        <button class="ghost" data-copy="${tableId}" title="Copy as tab-separated text, ready to paste into a spreadsheet">Copy</button>
        ${extra || ""}
        <span class="count">${shown}${shown !== all ? " of " + all : ""} row${all === 1 ? "" : "s"}</span>
      </div>`;
  }

  function renderTable(tableId, cols, totalRow, extra) {
    const rows = visibleRows(tableId, cols);
    const all = TABLES[tableId].rows().length;
    const sort = state.sort[tableId];
    const data = sortRows(tableId, cols, rows);
    const bmax = barMaxes(cols, data);

    const head = cols
      .map(
        (c) =>
          `<th class="${c.num ? "num" : ""}" data-col="${c.id}">${esc(c.label)}${
            sort && sort.col === c.id ? (sort.dir === "desc" ? " ↓" : " ↑") : ""
          }</th>`
      )
      .join("");

    const body = data.map((r) => "<tr>" + cols.map((c) => cellHtml(c, r, bmax)).join("") + "</tr>").join("");

    const foot = totalRow
      ? `<tr class="total">${cols.map((c) => `<td class="${c.num ? "num" : ""}">${esc(safeCell(c, totalRow))}</td>`).join("")}</tr>`
      : "";

    return (
      tableBar(tableId, rows.length, all, extra) +
      `<div class="scroll"><table data-table="${tableId}"><thead><tr>${head}</tr></thead><tbody>${body}${foot}</tbody></table></div>`
    );
  }

  // The per-span table is the hardest one to read: one issue produces several
  // rows, so the key and summary repeat and the eye has nothing to anchor on.
  // Grouped view prints each issue once as a header, then its spans beneath in
  // the order they actually happened.
  function renderGroupedSpans(tableId, cols) {
    const rows = visibleRows(tableId, cols);
    const all = TABLES[tableId].rows().length;

    // Columns that belong on the issue header rather than each span row.
    const spanCols = cols.filter((c) => !["key", "summary", "project"].includes(c.id));
    const bmax = barMaxes(spanCols, rows);

    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.key)) groups.set(r.key, []);
      groups.get(r.key).push(r);
    }

    const span = spanCols.length + 1; // +1 for the step column
    const head = `<th class="step">#</th>` + spanCols.map((c) => `<th class="${c.num ? "num" : ""}">${esc(c.label)}</th>`).join("");

    let body = "";
    for (const [key, list] of groups) {
      const first = list[0];
      const totalCal = list.reduce((s, r) => s + r.calMs, 0);
      body +=
        `<tr class="grp"><td colspan="${span}">` +
        `<a class="lnk" href="${location.origin}/browse/${encodeURIComponent(key)}" target="_blank" rel="noreferrer">${esc(key)}</a>` +
        // Leading space matters: without it the key and summary run together
        // when the table is copied or pasted elsewhere.
        ` <span class="gs">${esc(first.summary)}</span>` +
        `<span class="grptot">${list.length} span${list.length === 1 ? "" : "s"} · ${esc(U.formatMs(totalCal, settings.unit, U.DAY))} total</span>` +
        `</td></tr>`;

      list.forEach((r, i) => {
        body += `<tr><td class="step">${i + 1}</td>` + spanCols.map((c) => cellHtml(c, r, bmax)).join("") + "</tr>";
      });
    }

    return (
      tableBar(tableId, rows.length, all, grpToggle()) +
      `<div class="scroll"><table data-table="${tableId}" data-grouped="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
    );
  }

  function safeCell(col, row) {
    try {
      const v = col.cell(row);
      return typeof v === "string" && v.startsWith("<") ? "" : v;
    } catch (_) {
      return "";
    }
  }

  function wirePane(pane) {
    pane.querySelectorAll("th[data-col]").forEach((th) => {
      th.onclick = () => {
        const tableId = th.closest("table").dataset.table;
        const col = th.dataset.col;
        const cur = state.sort[tableId];
        state.sort[tableId] = cur && cur.col === col ? { col, dir: cur.dir === "desc" ? "asc" : "desc" } : { col, dir: "desc" };
        renderAll();
      };
    });

    pane.querySelectorAll("input[data-filter]").forEach((inp) => {
      inp.oninput = () => {
        const id = inp.dataset.filter;
        state.filter[id] = inp.value;
        // Hide rows in place rather than re-rendering, so the box keeps focus.
        const q = inp.value.trim().toLowerCase();
        const table = pane.querySelector(`table[data-table="${id}"]`);
        const shown = table.dataset.grouped ? filterGrouped(table, q) : filterFlat(table, q);

        const all = TABLES[id].rows().length;
        inp.parentElement.querySelector(".count").textContent =
          `${shown}${shown !== all ? " of " + all : ""} row${all === 1 ? "" : "s"}`;
      };
    });

    const grp = pane.querySelector("#grpSpans");
    if (grp) {
      grp.onchange = () => {
        settings.groupSpans = grp.checked;
        save();
        renderAll();
      };
    }

    pane.querySelectorAll("button[data-copy]").forEach((b) => (b.onclick = () => copyTable(b.dataset.copy)));
  }

  function filterFlat(table, q) {
    let shown = 0;
    table.querySelectorAll("tbody tr:not(.total)").forEach((tr) => {
      const hit = !q || tr.textContent.toLowerCase().includes(q);
      tr.style.display = hit ? "" : "none";
      if (hit) shown++;
    });
    return shown;
  }

  // In grouped mode a match on the issue header (key or summary) keeps all of
  // that issue's spans, and a header whose spans all vanish is hidden too —
  // otherwise you'd be left with headers standing over nothing.
  function filterGrouped(table, q) {
    const trs = [...table.querySelectorAll("tbody tr")];
    let shown = 0;
    let i = 0;
    while (i < trs.length) {
      if (!trs[i].classList.contains("grp")) {
        i++;
        continue;
      }
      const header = trs[i];
      const headerHit = !q || header.textContent.toLowerCase().includes(q);
      let j = i + 1;
      let inGroup = 0;
      while (j < trs.length && !trs[j].classList.contains("grp")) {
        const hit = headerHit || trs[j].textContent.toLowerCase().includes(q);
        trs[j].style.display = hit ? "" : "none";
        if (hit) inGroup++;
        j++;
      }
      header.style.display = inGroup ? "" : "none";
      shown += inGroup;
      i = j;
    }
    return shown;
  }

  function tiles(list) {
    return `<div class="tiles">${list.map((t) => `<div class="tile"><div class="v">${esc(t.v)}</div><div class="k">${esc(t.k)}</div></div>`).join("")}</div>`;
  }

  function renderAll() {
    renderPaneA();
    renderPaneB();
    renderExportPane();
    wirePane($('[data-pane="a"]'));
    wirePane($('[data-pane="b"]'));
  }

  // Compares our arithmetic against Jira's own stored per-issue total. A gap
  // means we're not seeing every worklog — most often because some are
  // restricted to a role or group, which otherwise under-reports silently.
  function reconcileNote(a) {
    const diff = a.jiraSeconds - a.allSeconds;

    // A silent safety net is indistinguishable from a broken one, so report the
    // passing case too. Without this, "no warning" could equally mean "Jira
    // never sent us its totals and the check never ran".
    if (!a.jiraSeconds) {
      return a.allSeconds
        ? `<p class="note">Couldn't verify these totals — Jira didn't return its own figures this time, so there's no way to confirm nothing is missing.</p>`
        : "";
    }
    if (Math.abs(diff) < 60) {
      return `<p class="note">✓ Totals match. Jira's own figure (${U.hours2(a.jiraSeconds)}h) equals the worklogs
      read back (${U.hours2(a.allSeconds)}h), so nothing is hidden from your account.</p>`;
    }
    const pctOff = Math.abs(diff / a.jiraSeconds) * 100;
    return `<div class="err">Totals don't match. Jira records <b>${U.hours2(a.jiraSeconds)}h</b> logged against
      these issues, but the worklogs visible to you only add up to <b>${U.hours2(a.allSeconds)}h</b> — a gap of
      ${U.hours2(Math.abs(diff))}h (${pctOff.toFixed(1)}%). This almost always means some worklogs are
      restricted to a role or group you're not in, so treat the figures below as a minimum rather than the
      full picture.</div>`;
  }

  function renderPaneA() {
    const pane = $('[data-pane="a"]');
    const a0 = state.reportA;
    if (!a0 || !a0.rows.length) {
      const seen = a0 ? a0.entriesCounted + a0.entriesSkipped : 0;
      let why;
      if (!a0 || !state.issues.length) {
        why = "Nothing here yet — run a report and the numbers will show up.";
      } else if (seen === 0) {
        why = `Found ${state.issues.length} issue${state.issues.length === 1 ? "" : "s"}, but none of them have any worklogs. Either nobody has logged time yet, or the entries are hidden from your account.`;
      } else {
        why = `Found ${seen} worklog entr${seen === 1 ? "y" : "ies"}, but ${seen === 1 ? "it falls" : "they all fall"} outside ${esc(settings.from || "the start")} – ${esc(settings.to || "now")}. Click <b>All time</b> to include ${seen === 1 ? "it" : "them"}.`;
      }
      pane.innerHTML = (a0 ? reconcileNote(a0) : "") + `<p class="note">${why}</p>`;
      return;
    }
    const a = a0;
    let html =
      reconcileNote(a) +
      tiles([
        { v: U.hours2(a.grandSeconds), k: "Total hours" },
        { v: a.rows.length, k: a.rows.length === 1 ? "Person" : "People" },
        { v: a.entriesCounted, k: "Worklog entries" },
        { v: state.issues.length, k: "Issues scanned" },
      ]) +
      `<h2>${esc(TABLES.a.title)}</h2>` +
      renderTable("a", selectedCols("a"), TABLES.a.totalRow());

    if (settings.groupBy !== "none") {
      html += `<h2>By ${esc(settings.groupBy)}</h2>`;
      if (settings.groupBy === "component") {
        html += '<p class="note">If an issue has several components, its hours are counted against the first one. Splitting them would be guesswork, and counting them twice would be worse.</p>';
      }
      html += renderTable("aGroup", selectedCols("aGroup"));
    }
    pane.innerHTML = html;
  }

  function renderPaneB() {
    const box = $("#bBody");
    if (!state.reportB || !state.reportB.perIssue.length) {
      box.innerHTML = '<p class="note">Nothing here yet — run a report and the numbers will show up.</p>';
      return;
    }
    const b = state.reportB;
    const slowest = b.perStatus[0];

    // Any scope other than "all" narrows the search, and this report has no way
    // to compensate — issues the query never returned simply aren't here. Say so
    // where the numbers are, not only in the picker at the top.
    const narrowed =
      settings.scope !== "all" && !settings.advanced
        ? `<div class="err">This only covers issues the search returned —
             ${esc((JR.query.SCOPES.find((x) => x.id === settings.scope) || {}).label || "a narrowed set")}.
             Anything else in the project is missing from these figures. Set
             <b>which issues to look at</b> to <b>All issues</b> for the full picture.</div>`
        : "";

    box.innerHTML =
      narrowed +
      tiles([
        { v: state.issues.length, k: "Issues" },
        { v: b.perStatus.length, k: "Statuses" },
        { v: b.open.length, k: "Still in status" },
        { v: slowest ? slowest.status : "—", k: "Slowest on average" },
      ]) +
      `<h2>${esc(TABLES.bStatus.title)}</h2>` +
      (b.briefSkipped
        ? `<p class="note">Hid ${b.briefSkipped} status change${b.briefSkipped === 1 ? "" : "s"} shorter than ${
            settings.minSpanSeconds
          } seconds — usually a workflow artefact rather than real time. Adjust this in Settings.</p>`
        : "") +
      '<p class="note">These averages only count issues that have already left the status. An issue still sitting in one hasn\'t finished its stay, and counting it early would make everything look faster than it is.</p>' +
      renderTable("bStatus", selectedCols("bStatus")) +
      `<h2>${esc(TABLES.bOpen.title)}</h2>` +
      renderTable("bOpen", selectedCols("bOpen")) +
      `<h2>${esc(TABLES.bIssue.title)}</h2>` +
      '<p class="note">Every issue, in order, with how long it spent in each status along the way.</p>' +
      (settings.groupSpans
        ? renderGroupedSpans("bIssue", selectedCols("bIssue"))
        : renderTable("bIssue", selectedCols("bIssue"), null, grpToggle()));
  }

  function renderExportPane() {
    const box = $("#exportBody");
    const order = ["a", "aGroup", "bStatus", "bOpen", "bIssue"];
    box.innerHTML = order
      .map((id) => {
        const t = TABLES[id];
        const chosen = new Set(selectedCols(id).map((c) => c.id));
        const n = t.rows().length;
        return `
          <div class="card">
            <h3>${esc(t.title)} <span class="muted">· ${n} row${n === 1 ? "" : "s"}</span></h3>
            <div class="cols">
              ${t.columns
                .map(
                  (c) =>
                    `<label class="chk"><input type="checkbox" data-t="${id}" data-c="${c.id}" ${chosen.has(c.id) ? "checked" : ""}> ${esc(c.label)}</label>`
                )
                .join("")}
            </div>
            <button data-export="${id}" ${n ? "" : "disabled"}>Download CSV</button>
            <button class="ghost" data-copy2="${id}" ${n ? "" : "disabled"}>Copy</button>
          </div>`;
      })
      .join("");

    box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.onchange = () => {
        const tableId = cb.dataset.t;
        settings.exportCols = settings.exportCols || {};
        const cur = new Set(selectedCols(tableId).map((c) => c.id));
        cb.checked ? cur.add(cb.dataset.c) : cur.delete(cb.dataset.c);
        settings.exportCols[tableId] = TABLES[tableId].columns.filter((c) => cur.has(c.id)).map((c) => c.id);
        save();
        renderAll();
      };
    });
    box.querySelectorAll("button[data-export]").forEach((b) => (b.onclick = () => exportCsv(b.dataset.export)));
    box.querySelectorAll("button[data-copy2]").forEach((b) => (b.onclick = () => copyTable(b.dataset.copy2)));
  }

  // ---------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------
  function exportCsv(tableId) {
    const t = TABLES[tableId];
    const cols = selectedCols(tableId);
    if (!cols.length) return;
    const rows = visibleRows(tableId, cols).map((r) => cols.map((c) => c.csv(r)));
    U.downloadCsv(`${t.file}-${U.isoDayLocal(Date.now())}.csv`, U.toCsv(cols.map((c) => c.label), rows));
  }

  async function copyTable(tableId) {
    const cols = selectedCols(tableId);
    const rows = visibleRows(tableId, cols);
    const tsv = [cols.map((c) => c.label).join("\t")]
      .concat(rows.map((r) => cols.map((c) => String(c.csv(r)).replace(/\t/g, " ")).join("\t")))
      .join("\n");
    try {
      await navigator.clipboard.writeText(tsv);
      flash("Copied " + rows.length + " row" + (rows.length === 1 ? "" : "s") + " to the clipboard.");
    } catch (_) {
      flash("Couldn't reach the clipboard. Use Download CSV instead.");
    }
  }

  let flashTimer = null;
  function flash(msg) {
    setStatus(`<div class="note">${esc(msg)}</div>`);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setStatus(""), 3000);
  }

  // ---------------------------------------------------------------------
  // Toggle
  // ---------------------------------------------------------------------
  async function toggle(force) {
    const existing = document.getElementById(HOST_ID);
    const show = force === undefined ? !existing || existing.style.display === "none" : force;

    if (!show) {
      if (existing) existing.style.display = "none";
      return;
    }
    if (existing) {
      existing.style.display = "";
      return;
    }
    await load();
    buildPanel();
    fillForm();
    renderAll();
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "JR_TOGGLE") toggle();
    });
  } catch (_) {
    /* orphaned content script from a previous extension load; page reload fixes it */
  }
})();
