const SESSION_KEY = "dvWorkshopSession";
const COUNSELORS_KEY = "dvCounselors";
const current = window.location.pathname.split("/").pop() || "dashboard.html";

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
    const isActive = link.getAttribute("href") === current;
    link.classList.toggle("active", isActive);
  });
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
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
  const raw = localStorage.getItem(COUNSELORS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  if (current === "task-tracker.html" && session.role !== "counselor") {
    window.location.href = session.role === "admin" ? "dashboard.html" : "index.html";
    return false;
  }

  if (current === "counselor-management.html" && session.role !== "admin") {
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
  const permissionKey = PAGE_PERMISSION_MAP[current];
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
    button.addEventListener("click", () => {
      localStorage.removeItem(SESSION_KEY);
      window.location.href = "index.html";
    });
  });
}

function guardProtectedPages() {
  const session = getSession();
  if (!session?.role) {
    window.location.href = "index.html";
    return null;
  }
  return session;
}

const session = guardProtectedPages();
if (session) {
  applyRoleVisibility(session);
  const allowed = enforceAccess(session);
  if (allowed) {
    applyActiveSidebarState();
    hydrateRoleTag(session);
    bindLogout();
  }
}
