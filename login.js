import { bootstrapLocalState } from "./state-sync.js";

const USERS = {
  admin: { id: "dvanalytics@W@2010", password: "dv@dataanalytics@2010W", name: "Admin" }
};

const COUNSELORS_KEY = "dvCounselors";

const DEFAULT_PERMISSIONS = {
  dashboard: false,
  preWorkshop: true,
  postWorkshop: true,
  lostLeads: true,
  monitoring: true
};

await bootstrapLocalState();

function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    ...options,
    signal: controller.signal
  }).finally(() => clearTimeout(timeoutId));
}

function normalizeCounselors(counselors) {
  if (!Array.isArray(counselors)) {
    return [];
  }

  return counselors.map((item) => ({
    ...item,
    email: String(item.email || "").toLowerCase(),
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...(item.permissions || {})
    }
  }));
}

function getLocalCounselors() {
  const raw = localStorage.getItem(COUNSELORS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid counselor payload");
    }

    return normalizeCounselors(parsed);
  } catch {
    return [];
  }
}

async function getCounselors() {
  try {
    const response = await fetchWithTimeout("/api/counselors", {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    });

    if (response.ok) {
      const counselors = normalizeCounselors(await response.json());
      localStorage.setItem(COUNSELORS_KEY, JSON.stringify(counselors));
      return counselors;
    }
  } catch {
    // Fall back to local browser state when the shared API is unavailable.
  }

  return getLocalCounselors();
}

const roleButtons = document.querySelectorAll(".role-btn");
const selectedRoleInput = document.getElementById("selectedRole");
const loginForm = document.getElementById("loginForm");
const loginMessage = document.getElementById("loginMessage");

roleButtons.forEach((button) => {
  button.addEventListener("click", () => {
    roleButtons.forEach((btn) => btn.classList.remove("active"));
    button.classList.add("active");
    selectedRoleInput.value = button.dataset.role;
    loginMessage.textContent = "";
  });
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const role = selectedRoleInput.value;
  const identifier = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value.trim();

  if (role === "admin") {
    const user = USERS.admin;
    if (user.id === identifier && user.password === password) {
      localStorage.setItem(
        "dvWorkshopSession",
        JSON.stringify({ role, name: user.name, email: user.id, loginTime: Date.now() })
      );
      window.location.href = "dashboard.html";
      return;
    }
  }

  if (role === "counselor") {
    const email = identifier.toLowerCase();
    const counselors = await getCounselors();
    const counselor = counselors.find(
      (item) => item.email === email && item.password === password
    );

    if (counselor) {
      localStorage.setItem(
        "dvWorkshopSession",
        JSON.stringify({
          role,
          name: counselor.name,
          email: counselor.email,
          loginTime: Date.now(),
          permissions: counselor.permissions
        })
      );

      const permissions = counselor.permissions || DEFAULT_PERMISSIONS;
      const landing = permissions.preWorkshop
        ? "pre-workshop.html"
        : permissions.postWorkshop
          ? "post-workshop.html"
          : permissions.lostLeads
            ? "lost-leads.html"
            : permissions.monitoring
              ? "monitoring.html"
              : "index.html";

      window.location.href = landing;
      return;
    }

    if (!counselors.length) {
      loginMessage.textContent = "Counselor credentials are not available on this deployment. Check Vercel MONGODB_URI and make sure counselor records exist in the shared database.";
      return;
    }
  }

  loginMessage.textContent = "Invalid credentials for selected role.";
});
