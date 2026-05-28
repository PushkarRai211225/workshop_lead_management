import { runPageCleanup } from "./page-runtime.js";
import { bindThemeControls, initThemeSystem } from "./theme.js";
import { bootstrapLocalState, getSession, getStateField, logout, refreshSession, refreshState, awaitPendingMutations } from "./state-sync.js";
import { startPingMonitor, mountPingPill } from "./ping-monitor.js";

let currentRoute = window.location.pathname.split("/").pop() || "dashboard.html";
let activeSession = null;
let activeNavigationToken = 0;
const loadedAssetUrls = new Set(
  Array.from(document.querySelectorAll("script[src]:not([type='module'])"), (script) => script.src)
);

const PAGE_PERMISSION_MAP = {
  "dashboard.html": "dashboard",
  "pre-workshop.html": "preWorkshop",
  "post-workshop.html": "postWorkshop",
  "task-tracker.html": "taskTracker",
  "lost-leads.html": "lostLeads",
  "monitoring.html": "monitoring"
};

const DEFAULT_PERMISSIONS = {
  dashboard: false,
  preWorkshop: true,
  postWorkshop: true,
  taskTracker: true,
  lostLeads: true,
  monitoring: true
};

function applyActiveSidebarState() {
  const sidebarLinks = document.querySelectorAll(".sidebar-link");
  sidebarLinks.forEach((link) => {
    const isActive = link.getAttribute("href") === currentRoute;
    link.classList.toggle("active", isActive);
  });
}

const prefetchedRoutes = new Set();

function prefetchRoute(href) {
  const route = String(href || "").trim();
  if (!route || prefetchedRoutes.has(route) || route.startsWith("http") || route.startsWith("#")) {
    return;
  }

  prefetchedRoutes.add(route);

  const link = document.createElement("link");
  link.rel = "prefetch";
  link.as = "document";
  link.href = route;
  document.head.appendChild(link);
}

function warmSidebarRoutes() {
  const sidebarLinks = document.querySelectorAll(".sidebar-link[href]");

  sidebarLinks.forEach((link) => {
    const href = link.getAttribute("href") || "";
    const warm = () => prefetchRoute(href);
    link.addEventListener("pointerenter", warm, { once: true });
    link.addEventListener("focus", warm, { once: true });
  });

  const eagerWarm = () => {
    sidebarLinks.forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (href && href !== currentRoute) {
        prefetchRoute(href);
      }
    });
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(eagerWarm, { timeout: 1500 });
  } else {
    window.setTimeout(eagerWarm, 800);
  }
}

function hydrateRoleTag(session) {
  const roleTags = document.querySelectorAll("[data-role-tag]");
  const text = session?.role === "admin" ? "Admin" : "Counselor";
  roleTags.forEach((tag) => {
    tag.textContent = text;
  });
}

function getCounselors() {
  return getStateField("counselors");
}

function getCounselorPermissions(session) {
  const counselors = getCounselors();
  const counselor = counselors.find(
    (item) => String(item.email || "").toLowerCase() === String(session.email || "").toLowerCase()
  );

  return {
    ...DEFAULT_PERMISSIONS,
    ...(session.permissions || {}),
    ...(counselor?.permissions || {}),
    // Dashboard remains admin-only even if older counselor records still have it enabled.
    dashboard: false
  };
}

function getFirstAllowedPage(permissions) {
  if (permissions.preWorkshop) return "pre-workshop.html";
  if (permissions.postWorkshop) return "post-workshop.html";
  if (permissions.lostLeads) return "lost-leads.html";
  if (permissions.monitoring) return "monitoring.html";
  return "index.html";
}

function applyRoleVisibility(session) {
  const adminOnlyElements = document.querySelectorAll("[data-admin-only='true']");
  const counselorOnlyElements = document.querySelectorAll("[data-counselor-only='true']");
  const isAdmin = session.role === "admin";
  const isCounselor = session.role === "counselor";
  adminOnlyElements.forEach((element) => {
    element.classList.toggle("hidden", !isAdmin);
  });
  counselorOnlyElements.forEach((element) => {
    element.classList.toggle("hidden", !isCounselor);
  });
}

function enforceAccess(session) {
  if (currentRoute === "task-tracker.html" && session.role !== "counselor") {
    window.location.href = session.role === "admin" ? "dashboard.html" : "index.html";
    return false;
  }

  if (currentRoute === "counselor-management.html" && session.role !== "admin") {
    const fallback =
      session.role === "counselor"
        ? getFirstAllowedPage(getCounselorPermissions(session))
        : "index.html";
    window.location.href = fallback;
    return false;
  }

  if (session.role !== "counselor") {
    return true;
  }

  const permissions = getCounselorPermissions(session);
  const permissionKey = PAGE_PERMISSION_MAP[currentRoute];
  if (!permissionKey) {
    return true;
  }

  if (!permissions[permissionKey]) {
    window.location.href = getFirstAllowedPage(permissions);
    return false;
  }

  const links = document.querySelectorAll(".sidebar-link");
  links.forEach((link) => {
    const href = link.getAttribute("href") || "";
    const key = PAGE_PERMISSION_MAP[href];
    if (key && !permissions[key]) {
      link.classList.add("hidden");
    }
  });

  return true;
}

function bindLogout() {
  const buttons = document.querySelectorAll("[data-logout]");
  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      await logout();
      window.location.href = "index.html";
    });
  });
}

function isRoutablePage(href) {
  return /^[^?#]+\.html(?:[?#].*)?$/i.test(String(href || ""));
}

function resolveRoute(href, baseUrl = window.location.href) {
  const url = new URL(href, baseUrl);
  return {
    route: url.pathname.split("/").pop() || "dashboard.html",
    url
  };
}

function ensureExternalScript(sourceUrl) {
  if (!sourceUrl || loadedAssetUrls.has(sourceUrl)) {
    return Promise.resolve();
  }

  loadedAssetUrls.add(sourceUrl);

  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = sourceUrl;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${sourceUrl}`));
    document.head.appendChild(script);
  });
}

async function ensureRouteAssets(targetDocument, targetUrl) {
  const externalScripts = Array.from(targetDocument.querySelectorAll("script[src]:not([type='module'])"));

  for (const script of externalScripts) {
    const source = script.getAttribute("src");
    if (!source) {
      continue;
    }

    await ensureExternalScript(new URL(source, targetUrl).href);
  }
}

async function loadRouteModules(targetDocument, targetUrl) {
  const moduleScripts = Array.from(targetDocument.querySelectorAll("script[type='module'][src]"))
    .map((script) => script.getAttribute("src"))
    .filter((source) => source && !source.endsWith("layouts.js"));

  for (const source of moduleScripts) {
    const moduleUrl = new URL(source, targetUrl);
    moduleUrl.searchParams.set("view", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await import(moduleUrl.href);
  }
}

async function navigateToRoute(href, options = {}) {
  const { pushState = true } = options;
  const { route, url } = resolveRoute(href);

  if (!activeSession || !isRoutablePage(route) || route === currentRoute) {
    return;
  }

  const navigationToken = ++activeNavigationToken;

  try {
    document.body.classList.add("route-loading");

    const response = await fetch(url.href, {
      credentials: "same-origin",
      headers: {
        Accept: "text/html"
      }
    });

    if (!response.ok) {
      throw new Error(`Route request failed with status ${response.status}`);
    }

    const html = await response.text();
    if (navigationToken !== activeNavigationToken) {
      return;
    }

    const parser = new DOMParser();
    const targetDocument = parser.parseFromString(html, "text/html");
    const nextMainContent = targetDocument.querySelector(".main-content");
    if (!nextMainContent) {
      throw new Error(`Missing .main-content in ${route}`);
    }

    await ensureRouteAssets(targetDocument, url.href);
    if (navigationToken !== activeNavigationToken) {
      return;
    }

    // Wait for any queued state mutations to complete before reading back the
    // server state. Without this, a counselor saving an activity and immediately
    // clicking a sidebar link could trigger refreshState() before the PUT
    // response arrives, causing the optimistic update to be overwritten with
    // the pre-mutation server state.
    await awaitPendingMutations();
    if (navigationToken !== activeNavigationToken) {
      return;
    }

    await refreshState();
    if (navigationToken !== activeNavigationToken) {
      return;
    }

    runPageCleanup();

    const currentMainContent = document.querySelector(".main-content");
    if (!currentMainContent) {
      throw new Error("Missing current .main-content container.");
    }

    currentMainContent.replaceWith(nextMainContent);
    document.title = targetDocument.title || document.title;
    document.body.className = targetDocument.body.className;

    currentRoute = route;
    applyRoleVisibility(activeSession);
    const allowed = enforceAccess(activeSession);
    if (!allowed) {
      return;
    }

    applyActiveSidebarState();
    hydrateRoleTag(activeSession);
    bindLogout();
    bindThemeControls();
    mountPingPill();

    if (pushState) {
      window.history.pushState({ route }, "", route);
    }

    window.scrollTo({ top: 0, behavior: "instant" });
    await loadRouteModules(targetDocument, url.href);
  } catch (error) {
    console.error("Soft navigation failed, falling back to a full page load.", error);
    window.location.href = href;
  } finally {
    document.body.classList.remove("route-loading");
  }
}

function bindClientRouter() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest(".sidebar-link[href]");
    if (!link) {
      return;
    }

    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const href = link.getAttribute("href") || "";
    if (!isRoutablePage(href)) {
      return;
    }

    event.preventDefault();
    void navigateToRoute(href);
  });

  window.addEventListener("popstate", () => {
    const route = window.location.pathname.split("/").pop() || "dashboard.html";
    if (!isRoutablePage(route) || route === currentRoute) {
      return;
    }

    void navigateToRoute(route, { pushState: false });
  });
}

async function guardProtectedPages() {
  await bootstrapLocalState();
  initThemeSystem();
  const session = getSession() || await refreshSession().catch(() => null);
  if (!session?.role) {
    window.location.href = "index.html";
    return null;
  }
  return session;
}

const session = await guardProtectedPages();
if (session) {
  activeSession = session;
  applyRoleVisibility(session);
  const allowed = enforceAccess(session);
  if (allowed) {
    applyActiveSidebarState();
    warmSidebarRoutes();
    hydrateRoleTag(session);
    bindLogout();
    bindThemeControls();
    bindClientRouter();
    startPingMonitor();
  }
}
