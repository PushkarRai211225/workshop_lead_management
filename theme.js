const STORAGE_KEY = "dvWorkshopTheme";
const THEME_EVENT = "dv-theme-change";

function getRoot() {
  return document.documentElement;
}

function getStoredTheme() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "light" ? value : null;
  } catch (_error) {
    return null;
  }
}

function getSystemTheme() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getCurrentTheme() {
  return getRoot().getAttribute("data-theme") || getStoredTheme() || getSystemTheme();
}

export function readThemePalette() {
  const styles = window.getComputedStyle(getRoot());
  return {
    chartLine: styles.getPropertyValue("--chart-1").trim() || "#1e3a8a",
    chartFill: styles.getPropertyValue("--chart-fill").trim() || "rgba(30, 58, 138, 0.12)",
    chartGrid: styles.getPropertyValue("--chart-grid").trim() || "rgba(148, 163, 184, 0.18)",
    chartSeries: ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"].map((token, index) => {
      const value = styles.getPropertyValue(token).trim();
      const fallback = ["#1e3a8a", "#3b82f6", "#0f766e", "#94a3b8", "#ea580c"][index];
      return value || fallback;
    })
  };
}

function emitThemeChange(theme) {
  document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
}

function updateToggleLabel(button, theme) {
  const label = button.querySelector("[data-theme-label]");
  if (label) {
    label.textContent = theme === "dark" ? "Dark" : "Light";
  }

  const targetTheme = theme === "dark" ? "light" : "dark";
  button.setAttribute("aria-label", `Switch to ${targetTheme} mode`);
  button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
  button.dataset.themeState = theme;
}

function applyTheme(theme, options = {}) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  const root = getRoot();
  const persist = options.persist !== false;
  const emit = options.emit !== false;

  root.setAttribute("data-theme", nextTheme);
  root.style.colorScheme = nextTheme;

  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, nextTheme);
    } catch (_error) {
      // Ignore storage access failures.
    }
  }

  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    updateToggleLabel(button, nextTheme);
  });

  if (emit) {
    emitThemeChange(nextTheme);
  }

  return nextTheme;
}

function createThemeIcon(kind) {
  const isSun = kind === "sun";
  return `
    <span class="theme-toggle__icon theme-toggle__icon--${kind}" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="presentation" focusable="false">
        ${isSun
          ? `
            <circle cx="12" cy="12" r="4.5"></circle>
            <path d="M12 1.8v2.4M12 19.8v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M1.8 12h2.4M19.8 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"></path>
          `
          : `
            <path d="M20.2 14.7A8.2 8.2 0 0 1 9.3 3.8a8.5 8.5 0 1 0 10.9 10.9Z"></path>
          `}
      </svg>
    </span>
  `;
}

function createToggleButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "theme-toggle";
  button.setAttribute("data-theme-toggle", "true");
  button.innerHTML = `
    <span class="theme-toggle__stack" aria-hidden="true">
      ${createThemeIcon("sun")}
      ${createThemeIcon("moon")}
    </span>
    <span class="theme-toggle__label" data-theme-label>Light</span>
  `;
  return button;
}

function ensureAuthToggle() {
  const authCard = document.querySelector(".auth-card");
  if (!authCard || authCard.querySelector("[data-theme-toggle]")) {
    return;
  }

  const toolbar = document.createElement("div");
  toolbar.className = "auth-toolbar";
  toolbar.appendChild(createToggleButton());
  authCard.prepend(toolbar);
}

function bindToggleButton(button) {
  if (button.dataset.themeBound === "true") {
    updateToggleLabel(button, getCurrentTheme());
    return;
  }

  button.dataset.themeBound = "true";
  updateToggleLabel(button, getCurrentTheme());

  button.addEventListener("click", () => {
    const nextTheme = getCurrentTheme() === "dark" ? "light" : "dark";
    getRoot().classList.add("theme-transitioning");
    applyTheme(nextTheme, { persist: true, emit: true });
    window.setTimeout(() => {
      getRoot().classList.remove("theme-transitioning");
    }, 260);
  });
}

export function bindThemeControls() {
  ensureAuthToggle();

  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    bindToggleButton(button);
  });
}

export function initThemeSystem() {
  applyTheme(getStoredTheme() || getCurrentTheme(), { persist: false, emit: false });
  bindThemeControls();
}

export function onThemeChange(handler) {
  if (typeof handler !== "function") {
    return () => undefined;
  }

  document.addEventListener(THEME_EVENT, handler);
  return () => document.removeEventListener(THEME_EVENT, handler);
}

export function toggleTheme() {
  const nextTheme = getCurrentTheme() === "dark" ? "light" : "dark";
  return applyTheme(nextTheme);
}