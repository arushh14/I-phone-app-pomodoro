// View router, settings, Cowork iCal fetch pipeline, Pomodoro bindings.

(function () {
  "use strict";

  const SETTINGS_KEY = "brief.settings.v1";
  const CACHE_KEY = "brief.ical.cache.v1";
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const DEFAULT_PROXY = "https://corsproxy.io/?";
  const WEEK_STARTS_ON = 1; // Monday

  const DEFAULTS = {
    icalUrl: "",
    corsProxy: DEFAULT_PROXY,
    theme: "auto",
  };

  // ------- Settings persistence -------

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme || "auto");
  }

  // ------- Cache -------

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); }
    catch (_) { return null; }
  }

  function saveCache(text) {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), text }));
  }

  // ------- Fetch -------

  async function fetchICS(rawUrl, proxy) {
    if (!rawUrl) throw new Error("No iCal URL set. Open Settings to add one.");
    // If the URL starts with webcal://, coerce to https://.
    const url = rawUrl.replace(/^webcal:\/\//i, "https://");
    const target = proxy ? (proxy + encodeURIComponent(url)) : url;
    const res = await fetch(target, { cache: "no-store" });
    if (!res.ok) throw new Error(`Feed responded ${res.status}`);
    const text = await res.text();
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That URL didn't return an iCal feed.");
    return text;
  }

  // ------- Rendering -------

  const dateFmtLong = new Intl.DateTimeFormat(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
  const dateFmtShort = new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    if (children) for (const c of children) if (c) node.appendChild(c);
    return node;
  }

  function timeRange(ev) {
    if (ev.start._allDay) return "All day";
    const start = ICal.fmtTime(ev.start);
    if (!ev.end || ev.end <= ev.start) return start;
    const end = ICal.fmtTime(ev.end);
    return `${start} – ${end}`;
  }

  function renderEventList(ul, events) {
    ul.innerHTML = "";
    if (!events.length) {
      ul.classList.add("empty");
      ul.appendChild(el("li", { class: "what", text: "Nothing scheduled." }));
      return;
    }
    ul.classList.remove("empty");
    for (const ev of events) {
      const when = el("span", { class: "when", text: timeRange(ev) });
      const title = el("span", { class: "what", text: ev.summary });
      if (ev.location) {
        title.appendChild(el("small", { class: "where", text: ev.location }));
      }
      ul.appendChild(el("li", null, [when, title]));
    }
  }

  function renderToday(events) {
    const now = new Date();
    document.getElementById("today-date").textContent = dateFmtLong.format(now);
    const todays = ICal.eventsOnDay(events, now);
    document.getElementById("today-summary").textContent = ICal.summarizeDay(todays);
    renderEventList(document.getElementById("today-list"), todays);
  }

  function renderWeek(events) {
    const now = new Date();
    const from = ICal.startOfWeek(now, WEEK_STARTS_ON);
    const to = ICal.endOfWeek(now, WEEK_STARTS_ON);
    const last = new Date(to); last.setDate(last.getDate() - 1);

    document.getElementById("week-range").textContent =
      `${dateFmtShort.format(from)} – ${dateFmtShort.format(last)}`;
    document.getElementById("week-summary").textContent = ICal.summarizeWeek(events, from, to);

    const body = document.getElementById("week-body");
    body.innerHTML = "";
    const map = ICal.groupByDay(events, from, to);
    for (const [key, evs] of map) {
      const day = new Date(key + "T00:00:00");
      const block = el("div", { class: "day-block" });
      block.appendChild(el("h3", { text: dateFmtLong.format(day) }));
      const ul = el("ul", { class: "event-list" });
      renderEventList(ul, evs);
      block.appendChild(ul);
      body.appendChild(block);
    }
  }

  function setStatus(id, message, isError) {
    const node = document.getElementById(id);
    if (!node) return;
    if (!message) { node.hidden = true; node.textContent = ""; return; }
    node.hidden = false;
    node.textContent = message;
    node.style.color = isError ? "#b00020" : "";
  }

  // ------- View routing -------

  const VIEWS = ["today", "week", "timer", "settings"];

  function currentView() {
    const hash = location.hash.replace(/^#\//, "");
    return VIEWS.includes(hash) ? hash : "today";
  }

  function showView(name) {
    for (const v of VIEWS) {
      document.getElementById("view-" + v).hidden = v !== name;
    }
    for (const a of document.querySelectorAll(".tabs a")) {
      a.toggleAttribute("aria-current", a.dataset.tab === name);
      if (a.dataset.tab === name) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    }
  }

  // ------- Data pipeline -------

  let allEvents = [];

  function renderAll() {
    renderToday(allEvents);
    renderWeek(allEvents);
  }

  async function refreshData({ force } = {}) {
    const settings = loadSettings();
    const cache = loadCache();
    const fresh = cache && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;

    if (cache && (!force || fresh)) {
      try {
        allEvents = ICal.parseICS(cache.text);
        renderAll();
      } catch (_) { /* ignore cache parse errors */ }
    }

    if (!settings.icalUrl) {
      setStatus("today-status", "Set your Cowork iCal URL in Settings.", false);
      setStatus("week-status", "Set your Cowork iCal URL in Settings.", false);
      return;
    }

    if (fresh && !force) {
      setStatus("today-status", `Updated ${timeAgo(cache.fetchedAt)}.`, false);
      setStatus("week-status", `Updated ${timeAgo(cache.fetchedAt)}.`, false);
      return;
    }

    setStatus("today-status", "Refreshing…", false);
    setStatus("week-status", "Refreshing…", false);

    try {
      const text = await fetchICS(settings.icalUrl, settings.corsProxy);
      saveCache(text);
      allEvents = ICal.parseICS(text);
      renderAll();
      setStatus("today-status", `Updated just now.`, false);
      setStatus("week-status", `Updated just now.`, false);
      setStatus("settings-status", "Feed loaded.", false);
    } catch (err) {
      console.error(err);
      const msg = `Couldn't refresh: ${err.message}`;
      setStatus("today-status", msg, true);
      setStatus("week-status", msg, true);
      setStatus("settings-status", msg, true);
    }
  }

  function timeAgo(ts) {
    const secs = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `${hrs}h ago`;
  }

  // ------- Settings form -------

  function hydrateSettingsForm() {
    const s = loadSettings();
    const p = Pomodoro.create({ onTick: () => {} }).getSettings();
    document.getElementById("s-ical-url").value = s.icalUrl;
    document.getElementById("s-proxy").value = s.corsProxy;
    document.getElementById("s-theme").value = s.theme;
    document.getElementById("s-focus").value = p.focusMin;
    document.getElementById("s-short").value = p.shortMin;
    document.getElementById("s-long").value = p.longMin;
    document.getElementById("s-cycles").value = p.cyclesBeforeLong;
  }

  function wireSettingsForm(pomodoro) {
    const form = document.getElementById("settings-form");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const next = {
        icalUrl: document.getElementById("s-ical-url").value.trim(),
        corsProxy: document.getElementById("s-proxy").value.trim() || DEFAULT_PROXY,
        theme: document.getElementById("s-theme").value,
      };
      saveSettings(next);
      applyTheme(next.theme);

      pomodoro.updateSettings({
        focusMin: +document.getElementById("s-focus").value,
        shortMin: +document.getElementById("s-short").value,
        longMin:  +document.getElementById("s-long").value,
        cyclesBeforeLong: +document.getElementById("s-cycles").value,
      });

      setStatus("settings-status", "Saved.", false);
      refreshData({ force: true });
    });

    document.getElementById("s-refresh").addEventListener("click", () => {
      refreshData({ force: true });
    });
  }

  // ------- Pomodoro wiring -------

  function phaseLabel(phase) {
    switch (phase) {
      case "focus":      return "Focus";
      case "shortBreak": return "Short break";
      case "longBreak":  return "Long break";
      case "paused":     return "Paused";
      default:           return "Ready";
    }
  }

  function wirePomodoro() {
    const display = document.getElementById("timer-display");
    const phaseEl = document.getElementById("timer-phase");
    const metaEl = document.getElementById("timer-meta");
    const toggleBtn = document.getElementById("timer-toggle");
    const skipBtn = document.getElementById("timer-skip");
    const resetBtn = document.getElementById("timer-reset");

    const pomodoro = Pomodoro.create({
      onTick: (s) => {
        display.textContent = s.remainingLabel;
        phaseEl.textContent = phaseLabel(s.phase === "paused" ? s.prevPhase : s.phase);
        metaEl.textContent = `${s.cycleIndex} / ${s.cyclesBeforeLong} cycles · ${s.completedToday} today`;
        toggleBtn.textContent = s.running ? "Pause" : (s.phase === "paused" ? "Resume" : "Start");

        if (s.running) {
          document.title = `${s.remainingLabel} · ${phaseLabel(s.phase)}`;
        } else {
          document.title = "Brief";
        }
      },
    });

    toggleBtn.addEventListener("click", () => pomodoro.toggle());
    skipBtn.addEventListener("click", () => pomodoro.skip());
    resetBtn.addEventListener("click", () => pomodoro.reset());

    pomodoro.init();
    return pomodoro;
  }

  // ------- Boot -------

  function boot() {
    const s = loadSettings();
    applyTheme(s.theme);

    const pomodoro = wirePomodoro();
    hydrateSettingsForm();
    wireSettingsForm(pomodoro);

    window.addEventListener("hashchange", () => showView(currentView()));
    showView(currentView());

    refreshData();

    // Refresh when the app returns to focus (iOS re-activation).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshData();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
