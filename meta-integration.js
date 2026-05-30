import { registerPageCleanup } from "./page-runtime.js";
import { bootstrapLocalState, getSession, getCounselors, startStatePolling } from "./state-sync.js";

await bootstrapLocalState();

const session = getSession();
if (!session || !["admin", "marketing"].includes(session.role)) {
  window.location.href = "index.html";
  throw new Error("Access required.");
}

// ── DOM refs ─────────────────────────────────────────────────────────────────

const integrationStatusBadge  = null; // replaced by status pills
const webhookUrlInput          = document.getElementById("webhookUrl");
const copyWebhookUrlBtn        = document.getElementById("copyWebhookUrlBtn");
const verifyTokenInput         = document.getElementById("verifyTokenInput");
const generateVerifyTokenBtn   = document.getElementById("generateVerifyTokenBtn");
const pageIdInput              = document.getElementById("pageIdInput");
const formIdsList              = document.getElementById("formIdsList");
const addFormIdBtn             = document.getElementById("addFormIdBtn");
const appSecretInput           = document.getElementById("appSecretInput");
const appSecretStatus          = document.getElementById("appSecretStatus");
const pageAccessTokenInput     = document.getElementById("pageAccessTokenInput");
const pageAccessTokenStatus    = document.getElementById("pageAccessTokenStatus");
const enabledToggle            = document.getElementById("enabledToggle");
const saveConfigBtn            = document.getElementById("saveConfigBtn");
const saveConfigMessage        = document.getElementById("saveConfigMessage");
const rrIndexDisplay           = document.getElementById("rrIndexDisplay");
const rrNextCounselor          = document.getElementById("rrNextCounselor");
const rrCounselorCount         = document.getElementById("rrCounselorCount");
const resetRrBtn               = document.getElementById("resetRrBtn");
const rrMessage                = document.getElementById("rrMessage");
const refreshLogsBtn           = document.getElementById("refreshLogsBtn");
const clearLogsBtn             = document.getElementById("clearLogsBtn");
const logsTableBody            = document.getElementById("logsTableBody");
const logTypeFilter            = document.getElementById("logTypeFilter");

// Raw log data (used for client-side filtering).
let allLogs = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function showMessage(el, text, isError = false) {
  el.textContent = text;
  el.style.color = isError ? "var(--danger, #ef4444)" : "var(--success, #22c55e)";
  if (text) {
    setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 5000);
  }
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "medium" });
  } catch {
    return iso;
  }
}

function generateToken(length = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

function buildWebhookUrl() {
  const origin = window.location.origin;
  return `${origin}/api/meta/webhook`;
}

// ── Config load / render ──────────────────────────────────────────────────────

async function loadConfig() {
  try {
    const res = await fetch("/api/meta/config", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    showMessage(saveConfigMessage, `Failed to load config: ${err.message}`, true);
    return null;
  }
}

function setStatusPill(pillId, valueId, ok, label) {
  const pill  = document.getElementById(pillId);
  const value = document.getElementById(valueId);
  if (!pill || !value) return;
  pill.className  = `status-pill ${ok ? "status-pill--ok" : "status-pill--err"}`;
  value.textContent = label;
}

function applyConfig(config) {
  if (!config) return;

  // Status pills
  setStatusPill("statusPillIntegration", "statusValIntegration",
    config.enabled, config.enabled ? "Enabled" : "Disabled");
  setStatusPill("statusPillAppSecret", "statusValAppSecret",
    config.appSecretSet, config.appSecretSet ? "Configured" : "Not set");
  setStatusPill("statusPillToken", "statusValToken",
    config.pageAccessTokenSet, config.pageAccessTokenSet ? "Configured" : "Not set");
  setStatusPill("statusPillVerifyToken", "statusValVerifyToken",
    !!(config.verifyToken), config.verifyToken ? "Set" : "Not set");

  enabledToggle.checked = !!config.enabled;
  verifyTokenInput.value = config.verifyToken || "";
  pageIdInput.value      = config.pageId || "";
  webhookUrlInput.value  = buildWebhookUrl();

  // Credential status chips
  if (config.appSecretSet) {
    appSecretStatus.textContent = "✓ Saved";
    appSecretStatus.className   = "cred-status cred-status--ok";
  } else {
    appSecretStatus.textContent = "Not set";
    appSecretStatus.className   = "cred-status cred-status--err";
  }
  if (config.pageAccessTokenSet) {
    pageAccessTokenStatus.textContent = "✓ Saved";
    pageAccessTokenStatus.className   = "cred-status cred-status--ok";
  } else {
    pageAccessTokenStatus.textContent = "Not set";
    pageAccessTokenStatus.className   = "cred-status cred-status--err";
  }

  // Form IDs
  renderFormIds(Array.isArray(config.formIds) ? config.formIds : []);

  // Round-robin
  const rrIdx = Number(config.roundRobinIndex) || 0;
  rrIndexDisplay.textContent = rrIdx;
  updateRRDisplay(rrIdx);
}

function updateRRDisplay(rrIdx) {
  const counselors = getCounselors().filter((c) => !c.disabled);
  if (rrCounselorCount) rrCounselorCount.textContent = counselors.length;
  if (!counselors.length) {
    rrNextCounselor.textContent = "No counselors";
    return;
  }
  const idx = (rrIdx % counselors.length + counselors.length) % counselors.length;
  rrNextCounselor.textContent = counselors[idx]?.name || "—";
}

// ── Form IDs list ─────────────────────────────────────────────────────────────

function renderFormIds(ids) {
  formIdsList.innerHTML = "";
  ids.forEach((id) => addFormIdRow(id));
}

function addFormIdRow(value = "") {
  const row = document.createElement("div");
  row.className = "form-id-row";
  row.innerHTML = `
    <input type="text" class="form-id-input" placeholder="e.g. 1234567890123456" value="${escapeHtml(value)}" />
    <button type="button" class="remove-form-id-btn" aria-label="Remove">✕</button>
  `;
  row.querySelector(".remove-form-id-btn").addEventListener("click", () => row.remove());
  formIdsList.appendChild(row);
}

function getFormIds() {
  return Array.from(formIdsList.querySelectorAll(".form-id-input"))
    .map((el) => el.value.trim())
    .filter(Boolean);
}

// ── Save config ───────────────────────────────────────────────────────────────

async function saveConfig() {
  saveConfigBtn.disabled = true;
  showMessage(saveConfigMessage, "Saving…");

  const payload = {
    enabled:          enabledToggle.checked,
    verifyToken:      verifyTokenInput.value.trim(),
    pageId:           pageIdInput.value.trim(),
    formIds:          getFormIds()
  };

  const appSecret = appSecretInput.value.trim();
  if (appSecret) payload.appSecret = appSecret;

  const pat = pageAccessTokenInput.value.trim();
  if (pat) payload.pageAccessToken = pat;

  try {
    const res = await fetch("/api/meta/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);

    // Clear secret fields after successful save (they're now stored server-side).
    appSecretInput.value       = "";
    pageAccessTokenInput.value = "";

    applyConfig(json);
    showMessage(saveConfigMessage, "Settings saved successfully.");
  } catch (err) {
    showMessage(saveConfigMessage, `Save failed: ${err.message}`, true);
  } finally {
    saveConfigBtn.disabled = false;
  }
}

// ── Logs ──────────────────────────────────────────────────────────────────────

async function loadLogs() {
  logsTableBody.innerHTML = '<tr><td colspan="5" class="log-empty">Loading…</td></tr>';
  try {
    const res = await fetch("/api/meta/logs?limit=50", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allLogs = await res.json();
    renderLogs(allLogs);
  } catch (err) {
    logsTableBody.innerHTML = `<tr><td colspan="5" class="log-empty" style="color:var(--danger)">Failed to load logs: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderLogs(logs) {
  const filter = logTypeFilter?.value || "all";
  const filtered = filter === "all" ? logs : logs.filter((l) => l.type === filter);

  if (!filtered.length) {
    logsTableBody.innerHTML = '<tr><td colspan="5" class="log-empty">No events match the selected filter.</td></tr>';
    return;
  }
  logsTableBody.innerHTML = filtered.map((log) => {
    const typeClass = `log-type--${log.type || "ignored"}`;
    const leadInfo = log.leadName
      ? `${escapeHtml(log.leadName)} <span style="opacity:.5">→</span> ${escapeHtml(log.counselor || "")}`
      : log.leadgenId
        ? `ID: ${escapeHtml(log.leadgenId)}`
        : "—";
    return `
      <tr>
        <td style="white-space:nowrap;font-size:.78rem;opacity:.7;">${escapeHtml(formatTime(log.receivedAt))}</td>
        <td><span class="log-type ${typeClass}">${escapeHtml(log.type || "?")}</span></td>
        <td>${escapeHtml(log.message || "")}</td>
        <td>${leadInfo}</td>
        <td>${escapeHtml(log.campaignName || "—")}</td>
      </tr>
    `;
  }).join("");
}

async function clearLogs() {
  if (!window.confirm("Clear all webhook logs? This cannot be undone.")) return;
  clearLogsBtn.disabled = true;
  try {
    const res = await fetch("/api/meta/logs", {
      method: "DELETE",
      credentials: "same-origin"
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderLogs([]);
  } catch (err) {
    showMessage(rrMessage, `Failed to clear logs: ${err.message}`, true);
  } finally {
    clearLogsBtn.disabled = false;
  }
}

// ── Round-robin reset ─────────────────────────────────────────────────────────

async function resetRoundRobin() {
  if (!window.confirm("Reset the round-robin counter to 0? The next Meta lead will be assigned to the first counselor.")) return;
  resetRrBtn.disabled = true;
  showMessage(rrMessage, "Resetting…");
  try {
    const res = await fetch("/api/meta/rr-state/reset", {
      method: "POST",
      credentials: "same-origin"
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
    rrIndexDisplay.textContent = 0;
    updateRRDisplay(0);
    showMessage(rrMessage, "Round-robin reset to 0.");
  } catch (err) {
    showMessage(rrMessage, `Reset failed: ${err.message}`, true);
  } finally {
    resetRrBtn.disabled = false;
  }
}

// ── Secret field visibility toggles ──────────────────────────────────────────

document.querySelectorAll(".toggle-secret-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.target;
    const input    = document.getElementById(targetId);
    if (!input) return;
    const isShowing = input.type === "text";
    input.type = isShowing ? "password" : "text";
    btn.textContent = isShowing ? "Show" : "Hide";
  });
});

// ── Event bindings ────────────────────────────────────────────────────────────

copyWebhookUrlBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(webhookUrlInput.value);
    copyWebhookUrlBtn.textContent = "Copied!";
    setTimeout(() => { copyWebhookUrlBtn.textContent = "Copy"; }, 2000);
  } catch {
    webhookUrlInput.select();
  }
});

generateVerifyTokenBtn.addEventListener("click", () => {
  verifyTokenInput.value = generateToken(32);
});

addFormIdBtn.addEventListener("click", () => addFormIdRow());

saveConfigBtn.addEventListener("click", saveConfig);

resetRrBtn.addEventListener("click", resetRoundRobin);

refreshLogsBtn.addEventListener("click", loadLogs);

clearLogsBtn.addEventListener("click", clearLogs);

if (logTypeFilter) {
  logTypeFilter.addEventListener("change", () => renderLogs(allLogs));
}

// ── Init ──────────────────────────────────────────────────────────────────────

webhookUrlInput.value = buildWebhookUrl();

const config = await loadConfig();
applyConfig(config);
await loadLogs();

const stopPolling = startStatePolling(15000, () => {
  // Refresh RR display if counselor list changes.
  const rrIdx = Number(rrIndexDisplay.textContent) || 0;
  updateRRDisplay(rrIdx);
});

registerPageCleanup(() => {
  stopPolling?.();
});
