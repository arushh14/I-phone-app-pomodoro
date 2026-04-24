// Minimal ICS (iCalendar) parser for Cowork feeds.
// Parses VEVENT blocks with SUMMARY / DTSTART / DTEND / DESCRIPTION / LOCATION,
// handles line unfolding (RFC 5545 §3.1), UTC Z and TZID=... date-times, and
// all-day DATE values. No external dependencies.

(function (global) {
  "use strict";

  function unfold(text) {
    // Join continuation lines: a line starting with space or tab belongs to the previous line.
    return text.replace(/\r?\n[ \t]/g, "");
  }

  function unescape(value) {
    return value
      .replace(/\\n/gi, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\");
  }

  // "20260424T090000Z" | "20260424T090000" | "20260424"
  function parseICSDate(value, params) {
    if (!value) return null;
    const isAllDay = /^\d{8}$/.test(value);
    if (isAllDay) {
      const y = +value.slice(0, 4);
      const m = +value.slice(4, 6) - 1;
      const d = +value.slice(6, 8);
      const dt = new Date(y, m, d);
      dt._allDay = true;
      return dt;
    }
    const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!match) return null;
    const [, y, mo, d, h, mi, s, z] = match;
    if (z === "Z") {
      return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    }
    if (params && params.TZID) {
      // Best effort: interpret as that TZ by formatting via Intl.
      // Safari/iOS supports Intl timezone fully.
      const asUTC = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
      const tzOffset = tzOffsetMs(params.TZID, asUTC);
      return new Date(asUTC - tzOffset);
    }
    // Floating local time.
    return new Date(+y, +mo - 1, +d, +h, +mi, +s);
  }

  function tzOffsetMs(tz, utcMs) {
    try {
      const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      const parts = dtf.formatToParts(new Date(utcMs));
      const o = {};
      for (const p of parts) if (p.type !== "literal") o[p.type] = p.value;
      const asLocal = Date.UTC(
        +o.year, +o.month - 1, +o.day,
        +o.hour % 24, +o.minute, +o.second
      );
      return asLocal - utcMs;
    } catch (_) {
      return 0;
    }
  }

  function parseParams(rest) {
    // rest: ";TZID=Europe/London;VALUE=DATE"
    const params = {};
    if (!rest) return params;
    const parts = rest.split(";").filter(Boolean);
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
    }
    return params;
  }

  function splitNameAndParams(left) {
    const sc = left.indexOf(";");
    if (sc === -1) return { name: left.toUpperCase(), params: {} };
    return {
      name: left.slice(0, sc).toUpperCase(),
      params: parseParams(left.slice(sc)),
    };
  }

  function parseICS(text) {
    const unfolded = unfold(text);
    const lines = unfolded.split(/\r?\n/);
    const events = [];
    let current = null;

    for (const line of lines) {
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const left = line.slice(0, colon);
      const value = line.slice(colon + 1);

      if (left === "BEGIN" && value === "VEVENT") {
        current = {};
        continue;
      }
      if (left === "END" && value === "VEVENT") {
        if (current && current.start) events.push(current);
        current = null;
        continue;
      }
      if (!current) continue;

      const { name, params } = splitNameAndParams(left);
      switch (name) {
        case "UID":         current.uid = value; break;
        case "SUMMARY":     current.summary = unescape(value); break;
        case "DESCRIPTION": current.description = unescape(value); break;
        case "LOCATION":    current.location = unescape(value); break;
        case "DTSTART":     current.start = parseICSDate(value, params); break;
        case "DTEND":       current.end   = parseICSDate(value, params); break;
      }
    }

    return events
      .filter((e) => e.summary && e.start)
      .sort((a, b) => a.start - b.start);
  }

  // ------------------------------------------------------------------
  // Grouping + summarization
  // ------------------------------------------------------------------

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
  }

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function startOfWeek(d, weekStartsOn /* 0=Sun, 1=Mon */) {
    const x = startOfDay(d);
    const day = x.getDay();
    const delta = (day - weekStartsOn + 7) % 7;
    x.setDate(x.getDate() - delta);
    return x;
  }

  function endOfWeek(d, weekStartsOn) {
    const s = startOfWeek(d, weekStartsOn);
    const e = new Date(s);
    e.setDate(e.getDate() + 7);
    return e;
  }

  function eventsOnDay(events, day) {
    const s = startOfDay(day);
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    return events.filter((ev) => ev.start < e && (ev.end ? ev.end > s : sameDay(ev.start, s)));
  }

  function eventsInRange(events, from, to) {
    return events.filter((ev) => ev.start < to && (ev.end ? ev.end > from : ev.start >= from));
  }

  function groupByDay(events, from, to) {
    const map = new Map();
    const cur = new Date(from);
    while (cur < to) {
      const key = cur.toISOString().slice(0, 10);
      map.set(key, eventsOnDay(events, cur));
      cur.setDate(cur.getDate() + 1);
    }
    return map;
  }

  function fmtTime(d) {
    if (d._allDay) return "all-day";
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function summarizeDay(events) {
    if (!events.length) return "Nothing scheduled.";
    const timed = events.filter((e) => !e.start._allDay);
    const allDay = events.filter((e) => e.start._allDay);
    const parts = [];
    parts.push(events.length === 1 ? "1 item" : `${events.length} items`);
    if (timed.length) {
      const first = timed[0];
      const last = timed[timed.length - 1];
      parts.push(`from ${fmtTime(first.start)} to ${fmtTime(last.end || last.start)}`);
    }
    if (allDay.length) parts.push(`${allDay.length} all-day`);
    return parts.join(" · ") + ".";
  }

  function summarizeWeek(events, from, to) {
    const inRange = eventsInRange(events, from, to);
    if (!inRange.length) return "Nothing scheduled this week.";
    const days = new Set(inRange.map((e) => e.start.toDateString())).size;
    return `${inRange.length} items across ${days} ${days === 1 ? "day" : "days"}.`;
  }

  global.ICal = {
    parseICS,
    groupByDay,
    eventsOnDay,
    eventsInRange,
    summarizeDay,
    summarizeWeek,
    startOfDay,
    startOfWeek,
    endOfWeek,
    fmtTime,
  };
})(typeof window !== "undefined" ? window : globalThis);
