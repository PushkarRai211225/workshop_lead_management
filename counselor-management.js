import { registerPageCleanup } from "./page-runtime.js";
import {
  bootstrapLocalState,
  getAllocation as getStoredAllocation,
  getCounselors as getStoredCounselors,
  getLeads as getStoredLeads,
  getMarketingUsers as getStoredMarketingUsers,
  saveAllocation as persistAllocation,
  saveCounselors as persistCounselors,
  saveLeads as persistLeads,
  saveMarketingUsers as persistMarketingUsers,
  startStatePolling,
  syncStateFromLocalAndVerify
} from "./state-sync.js";

await bootstrapLocalState();

const DEFAULT_PERMISSIONS = {
  dashboard: false,
  preWorkshop: true,
  postWorkshop: true,
  lostLeads: true,
  monitoring: true
};

const counselorForm = document.getElementById("counselorForm");
const counselorFormMessage = document.getElementById("counselorFormMessage");
const counselorList = document.getElementById("counselorList");

function setMessage(text, isError = true) {
  counselorFormMessage.textContent = text;
  counselorFormMessage.style.color = isError ? "var(--danger)" : "var(--success)";
}

function getCounselors() {
  return getStoredCounselors().map((item) => ({
    ...item,
    email: String(item.email || "").toLowerCase(),
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...(item.permissions || {})
    }
  }));
}

function saveCounselors(counselors) {
  return persistCounselors(counselors);
}

function getLeads() {
  return getStoredLeads();
}

function saveLeads(leads) {
  return persistLeads(leads);
}

function getAllocation() {
  return getStoredAllocation();
}

function saveAllocation(allocation) {
  return persistAllocation(allocation);
}

async function syncAllocationWithCounselors(counselors) {
  const counselorNames = [...new Set(
    counselors
      .map((item) => String(item.name || "").trim())
      .filter(Boolean)
  )];

  const existing = getAllocation();
  const byName = new Map(
    existing.map((item) => [String(item.name || "").trim().toLowerCase(), Number(item.percentage || 0)])
  );

  const next = counselorNames.map((name) => ({
    name,
    percentage: byName.get(name.toLowerCase()) || 0
  }));

  await saveAllocation(next);
}

function rebalanceAllocation(items) {
  if (!items.length) {
    return [];
  }

  const total = items.reduce((sum, item) => sum + Number(item.percentage || 0), 0);
  if (total <= 0) {
    const even = 100 / items.length;
    return items.map((item) => ({
      name: item.name,
      percentage: Number(even.toFixed(2))
    }));
  }

  let normalized = items.map((item) => ({
    name: item.name,
    percentage: Number((((Number(item.percentage || 0) / total) * 100).toFixed(2)))
  }));

  const roundedTotal = normalized.reduce((sum, item) => sum + item.percentage, 0);
  const delta = Number((100 - roundedTotal).toFixed(2));
  if (normalized.length && delta !== 0) {
    normalized[normalized.length - 1].percentage = Number(
      (normalized[normalized.length - 1].percentage + delta).toFixed(2)
    );
  }

  return normalized;
}

async function removeCounselor(counselorId) {
  const counselors = getCounselors();
  const target = counselors.find((item) => item.id === counselorId);
  if (!target) {
    setMessage("Counselor not found.", true);
    return;
  }

  const confirmed = window.confirm(`Remove counselor ${target.name}?`);
  if (!confirmed) {
    return;
  }

  const nextCounselors = counselors.filter((item) => item.id !== counselorId);
  const saveCounselorResult = await saveCounselors(nextCounselors);
  if (!saveCounselorResult || saveCounselorResult.ok === false) {
    setMessage(saveCounselorResult?.message || "Failed to save counselor changes. Please check your connection.", true);
    return;
  }
  await syncAllocationWithCounselors(nextCounselors);

  const leads = getLeads();
  let changed = false;
  const updatedLeads = leads.map((lead) => {
    if (String(lead.counselor || "").toLowerCase() === target.name.toLowerCase()) {
      changed = true;
      return {
        ...lead,
        counselor: "Unassigned"
      };
    }
    return lead;
  });
  if (changed) {
    const saveLeadsResult = await saveLeads(updatedLeads);
    if (!saveLeadsResult || saveLeadsResult.ok === false) {
      setMessage(saveLeadsResult?.message || "Counselor removed but failed to unassign leads. Please reload and retry.", true);
      return;
    }
  }

  const allocation = getAllocation();
  const filteredAllocation = allocation.filter(
    (item) => String(item.name || "").toLowerCase() !== target.name.toLowerCase()
  );
  if (filteredAllocation.length !== allocation.length) {
    const saveAllocResult = await saveAllocation(rebalanceAllocation(filteredAllocation));
    if (!saveAllocResult || saveAllocResult.ok === false) {
      setMessage(saveAllocResult?.message || "Counselor removed but failed to update allocation. Please reload and retry.", true);
      return;
    }
  }

  const syncResult = await syncStateFromLocalAndVerify();
  if (!syncResult.ok) {
    setMessage(syncResult.message || `Backend confirmation failed after removing counselor ${target.name}.`, true);
    return;
  }

  setMessage(`Counselor ${target.name} removed successfully.`, false);
  renderCounselorList();
}

function permissionText(permissions) {
  const names = [];
  if (permissions.preWorkshop) names.push("Workshop Calling");
  if (permissions.postWorkshop) names.push("Admission Calling");
  if (permissions.lostLeads) names.push("Lost Leads");
  if (permissions.monitoring) names.push("Monitoring");
  return names.length ? names.join(", ") : "No access";
}

function renderCounselorList() {
  const counselors = getCounselors();

  counselorList.innerHTML = `
    <div class="table-scroll">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Permissions</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${counselors
            .map(
              (counselor) => `
                <tr>
                  <td>${counselor.name}</td>
                  <td>${counselor.email}</td>
                  <td>${counselor.phone || "-"}</td>
                  <td>${permissionText(counselor.permissions || DEFAULT_PERMISSIONS)}</td>
                  <td>
                    <button
                      type="button"
                      class="btn-ghost remove-counselor-btn"
                      data-counselor-id="${counselor.id}"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  document.querySelectorAll(".remove-counselor-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const counselorId = button.getAttribute("data-counselor-id");
      if (!counselorId) {
        return;
      }
      void removeCounselor(counselorId);
    });
  });
}

function getSelectedPermissions() {
  const checked = Array.from(
    document.querySelectorAll("input[name='permission']:checked")
  ).map((item) => item.value);

  return {
    dashboard: false,
    preWorkshop: checked.includes("preWorkshop"),
    postWorkshop: checked.includes("postWorkshop"),
    lostLeads: checked.includes("lostLeads"),
    monitoring: checked.includes("monitoring")
  };
}

counselorForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("counselorName").value.trim();
  const email = document.getElementById("counselorEmail").value.trim().toLowerCase();
  const phone = document.getElementById("counselorPhone").value.trim();
  const password = document.getElementById("counselorPassword").value.trim();
  const permissions = getSelectedPermissions();

  if (!name || !email || !phone || !password) {
    setMessage("All counselor fields are required.", true);
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMessage("Enter a valid counselor email address.", true);
    return;
  }

  if (!Object.values(permissions).some(Boolean)) {
    setMessage("Select at least one access permission.", true);
    return;
  }

  const counselors = getCounselors();
  if (counselors.some((item) => item.email === email)) {
    setMessage("A counselor with this email already exists.", true);
    return;
  }

  counselors.push({
    id: `c-${Date.now()}`,
    name,
    email,
    phone,
    password,
    permissions
  });

  await saveCounselors(counselors);
  await syncAllocationWithCounselors(counselors);

  const syncResult = await syncStateFromLocalAndVerify();
  if (!syncResult.ok) {
    setMessage(syncResult.message || "Backend confirmation failed after saving the counselor.", true);
    return;
  }

  counselorForm.reset();

  // restore default checked state for convenience
  document.querySelectorAll("input[name='permission']").forEach((item) => {
    item.checked = true;
  });

  setMessage("Counselor created successfully.", false);
  renderCounselorList();
});

renderCounselorList();
const stopStatePolling = startStatePolling(() => {
  renderCounselorList();
  renderMarketingList();
});
registerPageCleanup(stopStatePolling);

// ── Marketing Users ───────────────────────────────────────────────────────────

const marketingForm = document.getElementById("marketingForm");
const marketingFormMessage = document.getElementById("marketingFormMessage");
const marketingList = document.getElementById("marketingList");

function setMarketingMessage(text, isError = true) {
  marketingFormMessage.textContent = text;
  marketingFormMessage.style.color = isError ? "var(--danger)" : "var(--success)";
}

function getMarketingUsers() {
  return getStoredMarketingUsers().map((item) => ({
    ...item,
    email: String(item.email || "").toLowerCase()
  }));
}

function saveMarketingUsers(users) {
  return persistMarketingUsers(users);
}

async function removeMarketingUser(userId) {
  const users = getMarketingUsers();
  const target = users.find((item) => item.id === userId);
  if (!target) return;

  const confirmed = window.confirm(`Remove marketing user ${target.name}?`);
  if (!confirmed) return;

  const next = users.filter((item) => item.id !== userId);
  const result = await saveMarketingUsers(next);
  if (!result || result.ok === false) {
    setMarketingMessage(result?.message || "Failed to remove marketing user.", true);
    return;
  }

  const syncResult = await syncStateFromLocalAndVerify();
  if (!syncResult.ok) {
    setMarketingMessage(syncResult.message || "Backend confirmation failed.", true);
    return;
  }

  setMarketingMessage(`${target.name} removed successfully.`, false);
  renderMarketingList();
}

function renderMarketingList() {
  const users = getMarketingUsers();

  if (!users.length) {
    marketingList.innerHTML = "<p style=\"opacity:0.5;font-size:0.85rem;\">No marketing users yet.</p>";
    return;
  }

  marketingList.innerHTML = `
    <div class="table-scroll">
      <table class="compact-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td>${u.name}</td>
              <td>${u.email}</td>
              <td>
                <button type="button" class="btn-ghost remove-marketing-btn" data-user-id="${u.id}">Remove</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  document.querySelectorAll(".remove-marketing-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-user-id");
      if (id) void removeMarketingUser(id);
    });
  });
}

marketingForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = document.getElementById("marketingName").value.trim();
  const email = document.getElementById("marketingEmail").value.trim().toLowerCase();
  const password = document.getElementById("marketingPassword").value.trim();

  if (!name || !email || !password) {
    setMarketingMessage("All fields are required.", true);
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setMarketingMessage("Enter a valid email address.", true);
    return;
  }

  const users = getMarketingUsers();
  if (users.some((u) => u.email === email)) {
    setMarketingMessage("A marketing user with this email already exists.", true);
    return;
  }

  users.push({ id: `m-${Date.now()}`, name, email, password });

  const result = await saveMarketingUsers(users);
  if (!result || result.ok === false) {
    setMarketingMessage(result?.message || "Failed to save marketing user.", true);
    return;
  }

  const syncResult = await syncStateFromLocalAndVerify();
  if (!syncResult.ok) {
    setMarketingMessage(syncResult.message || "Backend confirmation failed.", true);
    return;
  }

  marketingForm.reset();
  setMarketingMessage("Marketing user created successfully.", false);
  renderMarketingList();
});

renderMarketingList();
