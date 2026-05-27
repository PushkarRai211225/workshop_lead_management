/**
 * ping-monitor.js
 *
 * Measures round-trip latency to /api/ping every PING_INTERVAL_MS.
 * - Renders a colour-coded pill in every topbar-profile header.
 * - When latency exceeds HIGH_PING_THRESHOLD_MS it overlays the UI with a
 *   blocking card so counsellors cannot submit actions that would likely fail
 *   or arrive out of order due to network instability.
 * - Once GOOD_STREAK_TO_UNBLOCK consecutive readings fall back below the
 *   threshold the overlay is automatically dismissed.
 */

const PING_INTERVAL_MS        = 8000;   // measure every 8 s (was 5 s — reduced to cut background requests)
const HIGH_PING_THRESHOLD_MS  = 300;    // ms — block above this
const PING_REQUEST_TIMEOUT_MS = 8000;   // abort if server doesn't respond in 8 s
// Require this many back-to-back good readings before unblocking, so a brief
// dip does not prematurely dismiss the overlay on a still-flaky connection.
const GOOD_STREAK_TO_UNBLOCK  = 2;

let pingTimer     = null;
let blocked       = false;
let goodStreak    = 0;

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function getPillEl()    { return document.getElementById("dvPingPill");    }
function getOverlayEl() { return document.getElementById("dvPingOverlay"); }

function setPillState(ping, state) {
  const pill = getPillEl();
  if (!pill) return;
  const dot   = pill.querySelector(".ping-pill__dot");
  const value = pill.querySelector(".ping-pill__value");
  pill.className        = `ping-pill ping-pill--${state}`;
  dot.className         = `ping-pill__dot ping-pill__dot--${state}`;
  value.textContent     = ping !== null ? `${ping} ms` : "…";
  pill.title            = ping !== null ? `Network latency: ${ping} ms` : "Measuring latency…";
}

function setOverlayPing(ping) {
  const valueEl = document.getElementById("dvPingOverlayValue");
  if (valueEl) {
    valueEl.textContent = ping !== null ? `${ping} ms` : "Measuring…";
  }
  const dot = getOverlayEl()?.querySelector(".ping-pill__dot");
  if (dot) {
    dot.className = "ping-pill__dot ping-pill__dot--bad";
  }
}

function setBlockedState(nextBlocked) {
  if (blocked === nextBlocked) return;
  blocked = nextBlocked;
  const overlay = getOverlayEl();
  if (!overlay) return;
  if (nextBlocked) {
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }
}

// ─── Measurement ──────────────────────────────────────────────────────────────

async function measurePing() {
  const start = performance.now();
  let ping  = null;
  let state = "idle";

  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), PING_REQUEST_TIMEOUT_MS);
    const response   = await fetch("/api/ping", {
      method:      "GET",
      credentials: "same-origin",
      cache:       "no-store",
      headers:     { Accept: "application/json" },
      signal:      controller.signal
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      ping  = Math.round(performance.now() - start);
      state = ping < 150
        ? "good"
        : ping < HIGH_PING_THRESHOLD_MS
          ? "warn"
          : "bad";
    } else {
      state = "bad";
    }
  } catch (_err) {
    // Network failure or abort — treat as worst-case latency.
    state = "bad";
  }

  setPillState(ping, state);

  if (state === "bad") {
    goodStreak = 0;
    setBlockedState(true);
    setOverlayPing(ping);
  } else {
    goodStreak++;
    if (goodStreak >= GOOD_STREAK_TO_UNBLOCK) {
      setBlockedState(false);
    } else {
      // Still accumulating the required streak — keep overlay if already shown.
      if (blocked) setOverlayPing(ping);
    }
  }
}

// ─── DOM injection ────────────────────────────────────────────────────────────

function buildPillEl() {
  const pill     = document.createElement("div");
  pill.id        = "dvPingPill";
  pill.className = "ping-pill ping-pill--idle";
  pill.title     = "Measuring latency…";
  pill.innerHTML = `
    <span class="ping-pill__dot ping-pill__dot--idle" aria-hidden="true"></span>
    <span class="ping-pill__value">…</span>
  `;
  return pill;
}

function buildOverlayEl() {
  const overlay     = document.createElement("div");
  overlay.id        = "dvPingOverlay";
  overlay.className = "ping-overlay hidden";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "High network latency — actions are paused");
  overlay.innerHTML = `
    <div class="ping-overlay__card">
      <div class="ping-overlay__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9"  x2="12"    y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
      </div>
      <h3 class="ping-overlay__title">High Network Latency Detected</h3>
      <p class="ping-overlay__desc">
        Please wait for your connection to stabilize.<br>
        Actions are temporarily paused to prevent data loss.
      </p>
      <div class="ping-overlay__meter">
        <span class="ping-pill__dot ping-pill__dot--bad" aria-hidden="true"></span>
        <span id="dvPingOverlayValue">Measuring…</span>
      </div>
    </div>
  `;
  return overlay;
}

/**
 * Mount (or re-mount after soft navigation) the pill into the current page's
 * .topbar-profile.  Safe to call multiple times — skips if the pill already
 * exists in the current topbar.
 */
export function mountPingPill() {
  const profile = document.querySelector(".topbar-profile");
  if (!profile) return;

  // Remove any stale pill from a previous soft-nav render.
  const stale = document.getElementById("dvPingPill");
  if (stale && !profile.contains(stale)) {
    stale.remove();
  }

  if (!document.getElementById("dvPingPill")) {
    profile.insertBefore(buildPillEl(), profile.firstChild);
  }

  // Restore visual state to match whatever was last measured.
  // (The overlay persists in <body> so it does not need re-mounting.)
  const pill = getPillEl();
  if (pill && blocked) {
    pill.className = "ping-pill ping-pill--bad";
    const dot = pill.querySelector(".ping-pill__dot");
    if (dot) dot.className = "ping-pill__dot ping-pill__dot--bad";
  }
}

/**
 * Start the ping monitor.  Should be called once after the user is
 * authenticated.  Returns a cleanup function.
 */
export function startPingMonitor() {
  if (typeof document === "undefined" || typeof performance === "undefined") {
    return () => undefined;
  }

  mountPingPill();

  if (!document.getElementById("dvPingOverlay")) {
    document.body.appendChild(buildOverlayEl());
  }

  // First reading immediately so the pill does not show "…" for 5 s.
  void measurePing();

  function tick() {
    if (document.visibilityState !== "hidden") {
      void measurePing();
    }
  }

  pingTimer = setInterval(tick, PING_INTERVAL_MS);

  function handleVisibility() {
    if (document.visibilityState === "visible") {
      void measurePing();
    }
  }

  document.addEventListener("visibilitychange", handleVisibility);

  return () => {
    clearInterval(pingTimer);
    document.removeEventListener("visibilitychange", handleVisibility);
  };
}

/** Returns true when the latency is above the threshold (overlay is shown). */
export function isPingBlocked() {
  return blocked;
}
