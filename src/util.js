// Shared helpers. Content scripts listed in the manifest share one isolated
// world, so these files can talk to each other through a single global.
// It must be `var`, not `const`: they also share one top-level lexical scope,
// and a second `const JR` in any sibling file is a redeclaration SyntaxError.
var JR = (window.JR = window.JR || {});

JR.util = (() => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- dates ---------------------------------------------------------------

  // An <input type="date"> gives "YYYY-MM-DD". We interpret it in the user's
  // LOCAL timezone: "from 2026-08-01" means 00:00:00 local on that day.
  function dayStart(isoDay) {
    if (!isoDay) return null;
    const [y, m, d] = isoDay.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }

  function dayEnd(isoDay) {
    if (!isoDay) return null;
    const [y, m, d] = isoDay.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }

  function parseJiraDate(s) {
    // Jira returns e.g. "2026-08-01T10:00:00.000-0700". V8 parses that fine.
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }

  function isoDayLocal(dateLike) {
    const d = new Date(dateLike);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ---- business time -------------------------------------------------------

  // Overlap in milliseconds between [startMs, endMs] and the configured
  // working window, evaluated day by day in LOCAL time. Day-by-day iteration
  // is not the fastest possible approach, but it is obviously correct and it
  // handles DST for free (setHours works on local wall-clock time).
  function businessMs(startMs, endMs, cfg) {
    if (!(endMs > startMs)) return 0;
    const days = new Set(cfg.workDays);
    if (days.size === 0) return 0;

    const [sh, sm] = cfg.workStart.split(":").map(Number);
    const [eh, em] = cfg.workEnd.split(":").map(Number);
    if (eh * 60 + em <= sh * 60 + sm) return 0; // invalid window

    let total = 0;
    const cursor = new Date(startMs);
    cursor.setHours(0, 0, 0, 0);

    // Safety valve: a span longer than ~50 years is bad data, not a real span.
    let guard = 0;
    while (cursor.getTime() <= endMs && guard++ < 20000) {
      if (days.has(cursor.getDay())) {
        const ws = new Date(cursor);
        ws.setHours(sh, sm, 0, 0);
        const we = new Date(cursor);
        we.setHours(eh, em, 0, 0);
        const a = Math.max(ws.getTime(), startMs);
        const b = Math.min(we.getTime(), endMs);
        if (b > a) total += b - a;
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return total;
  }

  function businessDayMs(cfg) {
    const [sh, sm] = cfg.workStart.split(":").map(Number);
    const [eh, em] = cfg.workEnd.split(":").map(Number);
    const mins = eh * 60 + em - (sh * 60 + sm);
    return Math.max(mins, 0) * 60 * 1000;
  }

  // ---- formatting ----------------------------------------------------------

  // dayMs is what counts as "a day" for this column: 24h for calendar time,
  // the length of the working day for business time.
  function formatMs(ms, unit, dayMs) {
    if (ms == null) return "";
    if (unit === "hours") return (ms / HOUR).toFixed(2) + "h";
    if (unit === "days") return (ms / dayMs).toFixed(2) + "d";
    // auto
    if (ms >= dayMs) {
      const d = Math.floor(ms / dayMs);
      const h = (ms - d * dayMs) / HOUR;
      return h >= 0.05 ? `${d}d ${h.toFixed(1)}h` : `${d}d`;
    }
    if (ms >= HOUR) return (ms / HOUR).toFixed(1) + "h";
    return Math.round(ms / 60000) + "m";
  }

  const hours2 = (seconds) => (seconds / 3600).toFixed(2);

  // ---- concurrency ---------------------------------------------------------

  // Run fn over items with a bounded number in flight. Jira rate-limits, and
  // firing 500 requests at once is the fastest way to get 429'd.
  async function pool(items, limit, fn, onProgress, control) {
    const results = new Array(items.length);
    let index = 0;
    let done = 0;

    async function worker() {
      while (true) {
        if (control && control.cancelled) return;
        const i = index++;
        if (i >= items.length) return;
        try {
          results[i] = await fn(items[i], i);
        } catch (err) {
          results[i] = { __error: err.message || String(err) };
        }
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  // ---- CSV -----------------------------------------------------------------

  function csvCell(v) {
    if (v == null) return "";
    const s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(headers, rows) {
    const lines = [headers.map(csvCell).join(",")];
    for (const r of rows) lines.push(r.map(csvCell).join(","));
    // BOM so Excel opens UTF-8 correctly.
    return "﻿" + lines.join("\r\n");
  }

  function downloadCsv(filename, csv) {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return {
    HOUR,
    DAY,
    sleep,
    dayStart,
    dayEnd,
    parseJiraDate,
    isoDayLocal,
    businessMs,
    businessDayMs,
    formatMs,
    hours2,
    pool,
    toCsv,
    downloadCsv,
  };
})();
