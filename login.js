import { bootstrapLocalState, getSession, login, refreshSession } from "./state-sync.js";

await bootstrapLocalState();

const existingSession = await refreshSession().catch(() => null);
if (existingSession?.role) {
  window.location.href = existingSession.role === "admin"
    ? "dashboard.html"
    : existingSession.permissions?.preWorkshop
      ? "pre-workshop.html"
      : existingSession.permissions?.postWorkshop
        ? "post-workshop.html"
        : existingSession.permissions?.lostLeads
          ? "lost-leads.html"
          : existingSession.permissions?.monitoring
            ? "monitoring.html"
            : "index.html";
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

  const result = await login({ role, identifier, password });
  if (!result.ok) {
    loginMessage.textContent = result.message || "Invalid credentials for selected role.";
    return;
  }

  const session = result.session || getSession();
  if (!session?.role) {
    loginMessage.textContent = "Login succeeded but the session could not be restored.";
    return;
  }

  window.location.href = result.landing || "index.html";
});
