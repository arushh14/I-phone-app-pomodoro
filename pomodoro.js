// Pomodoro timer state machine.
// - Phases: idle, focus, shortBreak, longBreak.
// - Uses Date.now() deltas so it stays accurate when iOS Safari throttles tabs.
// - Persists state in localStorage so reopening resumes the current session.
// - Emits phase-change beeps via WebAudio and updates document.title.

(function (global) {
  "use strict";

  const STORAGE_KEY = "pomodoro.v1";
  const DAY_KEY = "pomodoro.day.v1";

  const DEFAULT_SETTINGS = {
    focusMin: 25,
    shortMin: 5,
    longMin: 15,
    cyclesBeforeLong: 4,
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem("pomodoro.settings.v1");
      if (!raw) return { ...DEFAULT_SETTINGS };
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch (_) {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(s) {
    localStorage.setItem("pomodoro.settings.v1", JSON.stringify({
      focusMin: +s.focusMin || DEFAULT_SETTINGS.focusMin,
      shortMin: +s.shortMin || DEFAULT_SETTINGS.shortMin,
      longMin:  +s.longMin  || DEFAULT_SETTINGS.longMin,
      cyclesBeforeLong: +s.cyclesBeforeLong || DEFAULT_SETTINGS.cyclesBeforeLong,
    }));
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function loadDay() {
    try {
      const raw = JSON.parse(localStorage.getItem(DAY_KEY) || "{}");
      if (raw.day !== todayKey()) return { day: todayKey(), completed: 0 };
      return raw;
    } catch (_) {
      return { day: todayKey(), completed: 0 };
    }
  }

  function saveDay(d) {
    localStorage.setItem(DAY_KEY, JSON.stringify(d));
  }

  function loadState() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  function saveState(s) {
    if (!s) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.62);
      osc.onended = () => ctx.close();
    } catch (_) { /* silent */ }
  }

  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function createPomodoro(options) {
    const onTick = options.onTick || (() => {});
    let settings = loadSettings();
    let day = loadDay();
    let state = loadState() || {
      phase: "idle",        // idle | focus | shortBreak | longBreak | paused
      prevPhase: null,      // if paused, what we were in
      phaseEndsAt: null,    // epoch ms
      remainingOnPause: 0,  // ms remaining when paused
      cycleIndex: 0,        // focus cycles completed in the current set (0..cyclesBeforeLong)
    };

    if (day.day !== todayKey()) day = { day: todayKey(), completed: 0 };

    let rafId = null;

    function phaseDurationMs(phase) {
      if (phase === "focus") return settings.focusMin * 60_000;
      if (phase === "shortBreak") return settings.shortMin * 60_000;
      if (phase === "longBreak") return settings.longMin * 60_000;
      return 0;
    }

    function remaining() {
      if (state.phase === "paused") return state.remainingOnPause;
      if (state.phase === "idle") return phaseDurationMs("focus");
      if (!state.phaseEndsAt) return 0;
      return state.phaseEndsAt - Date.now();
    }

    function snapshot() {
      return {
        phase: state.phase,
        prevPhase: state.prevPhase,
        remainingMs: remaining(),
        remainingLabel: fmt(remaining()),
        cycleIndex: state.cycleIndex,
        cyclesBeforeLong: settings.cyclesBeforeLong,
        completedToday: day.completed,
        running: state.phase !== "idle" && state.phase !== "paused",
      };
    }

    function emit() { onTick(snapshot()); }

    function loop() {
      rafId = null;
      if (state.phase === "idle" || state.phase === "paused") {
        emit();
        return;
      }
      const rem = remaining();
      if (rem <= 0) {
        advancePhase();
      } else {
        emit();
        rafId = setTimeout(loop, 250);
      }
    }

    function startPhase(phase) {
      state.phase = phase;
      state.prevPhase = null;
      state.phaseEndsAt = Date.now() + phaseDurationMs(phase);
      state.remainingOnPause = 0;
      saveState(state);
      beep();
      loop();
    }

    function advancePhase() {
      const finished = state.phase;
      if (finished === "focus") {
        state.cycleIndex += 1;
        day.completed += 1;
        saveDay(day);
        const next = (state.cycleIndex >= settings.cyclesBeforeLong) ? "longBreak" : "shortBreak";
        if (next === "longBreak") state.cycleIndex = 0;
        startPhase(next);
      } else {
        // After any break, go back to focus.
        startPhase("focus");
      }
    }

    function start() {
      if (state.phase === "paused" && state.prevPhase) {
        state.phaseEndsAt = Date.now() + state.remainingOnPause;
        state.phase = state.prevPhase;
        state.prevPhase = null;
        state.remainingOnPause = 0;
        saveState(state);
        loop();
        return;
      }
      if (state.phase === "idle") {
        startPhase("focus");
      }
    }

    function pause() {
      if (state.phase === "idle" || state.phase === "paused") return;
      state.remainingOnPause = Math.max(0, state.phaseEndsAt - Date.now());
      state.prevPhase = state.phase;
      state.phase = "paused";
      state.phaseEndsAt = null;
      saveState(state);
      emit();
    }

    function toggle() {
      if (state.phase === "idle" || state.phase === "paused") start();
      else pause();
    }

    function skip() {
      if (state.phase === "idle") return;
      if (state.phase === "paused") {
        state.phase = state.prevPhase || "focus";
      }
      // Finish current phase immediately.
      state.phaseEndsAt = Date.now();
      advancePhase();
    }

    function reset() {
      if (rafId) { clearTimeout(rafId); rafId = null; }
      state = {
        phase: "idle",
        prevPhase: null,
        phaseEndsAt: null,
        remainingOnPause: 0,
        cycleIndex: 0,
      };
      saveState(null);
      emit();
    }

    function updateSettings(next) {
      settings = { ...settings, ...next };
      saveSettings(settings);
      // If idle, emit to refresh the displayed default duration.
      if (state.phase === "idle") emit();
    }

    function getSettings() { return { ...settings }; }

    function init() {
      // On load, if a phase was in flight and has already elapsed, fast-forward.
      if (state.phase !== "idle" && state.phase !== "paused") {
        while (state.phase !== "idle" && state.phase !== "paused" && remaining() <= 0) {
          advancePhase();
          // advancePhase starts a new phase; if that one has also elapsed during the gap, loop.
        }
        loop();
      } else {
        emit();
      }
    }

    return {
      init,
      start, pause, toggle, skip, reset,
      updateSettings, getSettings,
      snapshot,
    };
  }

  global.Pomodoro = { create: createPomodoro, DEFAULTS: DEFAULT_SETTINGS };
})(typeof window !== "undefined" ? window : globalThis);
