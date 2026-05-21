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

function getCounselors() {
  const raw = localStorage.getItem(COUNSELORS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid counselor payload");
    }

    return parsed.map((item) => ({
      ...item,
      email: String(item.email || "").toLowerCase(),
      permissions: {
        ...DEFAULT_PERMISSIONS,
        ...(item.permissions || {})
      }
    }));
  } catch {
    return [];
  }
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

loginForm.addEventListener("submit", (event) => {
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
    const counselor = getCounselors().find(
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
  }

  loginMessage.textContent = "Invalid credentials for selected role.";
});
