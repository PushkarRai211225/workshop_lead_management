require("dotenv").config();
const express    = require("express");
const path       = require("path");
const crypto     = require("crypto");
const compress   = require("compression");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "dv_workshop_site";
const MONGODB_STATE_COLLECTION = process.env.MONGODB_STATE_COLLECTION || "app_state";
const MONGODB_SESSION_COLLECTION = process.env.MONGODB_SESSION_COLLECTION || "user_sessions";
const MONGODB_PREFERENCE_COLLECTION = process.env.MONGODB_PREFERENCE_COLLECTION || "user_preferences";
const MONGODB_META_CONFIG_COLLECTION = process.env.MONGODB_META_CONFIG_COLLECTION || "meta_config";
const MONGODB_META_LOGS_COLLECTION = process.env.MONGODB_META_LOGS_COLLECTION || "meta_logs";
const STATE_DOC_ID = "global";
const META_CONFIG_DOC_ID = "meta_integration";
const MAX_META_LOGS = 200;
const SESSION_COOKIE_NAME = "dvWorkshopSession";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ADMIN_USER = {
  id: "dvanalytics@W@2010",
  password: "dv@dataanalytics@2010W",
  name: "Admin"
};

const DEFAULT_PERMISSIONS = {
  dashboard: false,
  preWorkshop: true,
  postWorkshop: true,
  taskTracker: true,
  lostLeads: true,
  monitoring: true
};

// ─── Ping FIRST — absolute minimal path, no auth, no JSON parsing overhead ───
// Registered before all middleware so the latency measurement is as accurate
// as possible and is not inflated by gzip, JSON body parsing, or static file
// lookups.  Keep this response tiny to avoid network serialisation skewing the
// round-trip time reading.
app.get("/api/ping", (_req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end('{"ok":true}');
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

// Compress all responses ≥ 1 KB — dramatically reduces /api/state payload size.
app.use(compress({ threshold: 1024 }));
app.use(express.json({
  limit: "5mb",
  verify: (req, _res, buf) => {
    // Capture raw body for Meta webhook signature verification.
    if (req.originalUrl && req.originalUrl.startsWith("/api/meta/webhook")) {
      req.rawBody = buf;
    }
  }
}));
app.use(express.static(ROOT_DIR));

let stateCollection;
let sessionCollection;
let preferenceCollection;
let metaConfigCollection;
let metaLogsCollection;
let mongoInitPromise;
let cachedStateDoc    = null;
let cachedStateDocAt  = 0;
// Re-read from Mongo after 5 s so stale serverless instances pick up writes
// from other instances sooner. Shorter TTL reduces the window in which a
// concurrent GET can return stale data after a PUT on a different instance.
const STATE_CACHE_TTL_MS = 5000;

// In-process session cache — avoids a MongoDB round-trip on every authenticated
// request.  Entries expire after 60 s so a deleted/expired session is noticed
// within a minute without hammering the DB.
const SESSION_CACHE_TTL_MS = 60000;
const sessionCache = new Map(); // token → { session, cachedAt }

function getCachedSession(token) {
  const entry = sessionCache.get(token);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(token);
    return null;
  }
  return entry.session;
}

function setCachedSession(token, session) {
  sessionCache.set(token, { session, cachedAt: Date.now() });
}

function evictCachedSession(token) {
  sessionCache.delete(token);
}

function parseCookies(headerValue = "") {
  return headerValue
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex === -1) {
        return cookies;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function buildOwnerKey(session) {
  return `${String(session?.role || "guest").trim().toLowerCase()}:${String(session?.email || "anonymous").trim().toLowerCase()}`;
}

function sanitizeSession(session = {}) {
  return {
    role: String(session.role || "").trim(),
    name: String(session.name || "").trim(),
    email: String(session.email || "").trim().toLowerCase(),
    permissions: {
      ...DEFAULT_PERMISSIONS,
      ...(session.permissions || {})
    },
    loginTime: session.loginTime || Date.now()
  };
}

async function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = String(cookies[SESSION_COOKIE_NAME] || "").trim();
  if (!token) {
    return null;
  }

  // Serve from in-process cache to avoid a MongoDB round-trip on every
  // authenticated API call (e.g. every 15 s state poll hits this path).
  const cached = getCachedSession(token);
  if (cached) {
    return { token, session: cached };
  }

  const sessionDoc = await sessionCollection.findOne({
    token,
    expiresAt: { $gt: new Date().toISOString() }
  });

  if (!sessionDoc) {
    return null;
  }

  const session = sanitizeSession(sessionDoc);
  setCachedSession(token, session);
  return { token, session };
}

async function persistSession(res, session) {
  const token = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const normalized = sanitizeSession(session);

  await sessionCollection.insertOne({
    token,
    ...normalized,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt
  });

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: SESSION_TTL_MS,
    path: "/"
  });

  return normalized;
}

function normalizeStateDoc(state = {}) {
  return {
    _id: STATE_DOC_ID,
    leads: Array.isArray(state.leads) ? state.leads : [],
    counselors: Array.isArray(state.counselors) ? state.counselors : [],
    marketingUsers: Array.isArray(state.marketingUsers) ? state.marketingUsers : [],
    allocation: Array.isArray(state.allocation) ? state.allocation : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    createdAt: state.createdAt || new Date().toISOString(),
    updatedAt: state.updatedAt || new Date().toISOString(),
    clearedAt: state.clearedAt || null
  };
}

function cacheStateDoc(state) {
  cachedStateDoc = normalizeStateDoc(state);
  cachedStateDocAt = Date.now();
  return cachedStateDoc;
}

function buildStateResponse(state) {
  const normalized = normalizeStateDoc(state);
  return {
    leads: normalized.leads,
    counselors: normalized.counselors,
    marketingUsers: normalized.marketingUsers,
    allocation: normalized.allocation,
    tasks: normalized.tasks,
    updatedAt: normalized.updatedAt || null,
    clearedAt: normalized.clearedAt || null
  };
}

function buildStateEtag(state) {
  return `"${state?.updatedAt || "init"}"`.replace(/\s/g, "_");
}

async function initMongo() {
  if (stateCollection) {
    return;
  }

  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in environment.");
  }

  if (!mongoInitPromise) {
    mongoInitPromise = (async () => {
      const client = new MongoClient(MONGODB_URI, {
        // Larger pool so concurrent serverless invocations don't queue waiting
        // for a connection.  minPoolSize keeps a couple of connections warm so
        // cold-start latency is lower on the first request after idle time.
        maxPoolSize: 10,
        minPoolSize: 2,
        // Fail fast on cold starts rather than hanging for 30 s.
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        // Generous socket timeout for high-latency or slow-network writes.
        socketTimeoutMS: 45000
      });
      await client.connect();
      const db = client.db(MONGODB_DB_NAME);
      stateCollection      = db.collection(MONGODB_STATE_COLLECTION);
      sessionCollection    = db.collection(MONGODB_SESSION_COLLECTION);
      preferenceCollection = db.collection(MONGODB_PREFERENCE_COLLECTION);
      metaConfigCollection = db.collection(MONGODB_META_CONFIG_COLLECTION);
      metaLogsCollection   = db.collection(MONGODB_META_LOGS_COLLECTION);
      // Ensure a fast index on the session token so every auth'd request
      // resolves in a single indexed lookup instead of a full collection scan.
      await sessionCollection.createIndex(
        { token: 1 },
        { unique: true, background: true }
      ).catch(() => undefined); // ignore if index already exists
      await metaLogsCollection.createIndex(
        { receivedAt: -1 },
        { background: true }
      ).catch(() => undefined);
    })();
  }

  await mongoInitPromise;
}

// ─── Meta Integration Helpers ───────────────────────────────────────────────

async function getMetaConfig() {
  const doc = await metaConfigCollection.findOne({ _id: META_CONFIG_DOC_ID });
  return doc || {
    _id: META_CONFIG_DOC_ID,
    enabled: false,
    verifyToken: "",
    appSecret: "",
    pageAccessToken: "",
    pageId: "",
    formIds: [],
    roundRobinIndex: 0
  };
}

async function saveMetaLog(entry) {
  const log = { ...entry, receivedAt: new Date().toISOString() };
  await metaLogsCollection.insertOne(log);
  // Prune oldest entries beyond the cap to keep collection small.
  const count = await metaLogsCollection.countDocuments();
  if (count > MAX_META_LOGS) {
    const excess = count - MAX_META_LOGS;
    const oldest = await metaLogsCollection
      .find({}, { projection: { _id: 1 } })
      .sort({ receivedAt: 1 })
      .limit(excess)
      .toArray();
    if (oldest.length) {
      await metaLogsCollection.deleteMany({ _id: { $in: oldest.map((d) => d._id) } });
    }
  }
}

function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const parts = String(signatureHeader).split("=");
  if (parts.length < 2 || parts[0] !== "sha256") return false;
  try {
    const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
    const providedBuf = Buffer.from(parts[1], "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (providedBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

async function fetchMetaLeadDetails(leadgenId, pageAccessToken) {
  const fields = "field_data,created_time,form_id,ad_id,ad_name,adset_name,campaign_name,page_id";
  const graphUrl =
    `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}` +
    `?fields=${fields}&access_token=${encodeURIComponent(pageAccessToken)}`;
  // native fetch available in Node 18+; fall back to https for older runtimes
  if (typeof fetch === "function") {
    const resp = await fetch(graphUrl);
    const json = await resp.json();
    if (!resp.ok || json.error) throw new Error(json?.error?.message || `Meta API ${resp.status}`);
    return json;
  }
  // https fallback
  return new Promise((resolve, reject) => {
    const https = require("https");
    https.get(graphUrl, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json);
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function assignCounselorRoundRobin(stateDoc) {
  const counselors = (Array.isArray(stateDoc.counselors) ? stateDoc.counselors : [])
    .filter((c) => !c.disabled);
  if (!counselors.length) return "Unassigned";
  // Atomically increment so concurrent webhook calls never collide.
  const result = await metaConfigCollection.findOneAndUpdate(
    { _id: META_CONFIG_DOC_ID },
    { $inc: { roundRobinIndex: 1 } },
    { returnDocument: "after", upsert: true }
  );
  const newIdx = Number(result.roundRobinIndex) || 1;
  const idx = ((newIdx - 1) % counselors.length + counselors.length) % counselors.length;
  return counselors[idx].name;
}

function buildMetaLead(fieldData, meta, counselorName, nextId) {
  const fields = {};
  (fieldData || []).forEach(({ name, values }) => {
    fields[String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_")] = (values || [])[0] ?? "";
  });

  const firstName = String(fields.first_name || "").trim();
  const lastName = String(fields.last_name || "").trim();
  const fullName = String(fields.full_name || fields.name || "").trim();
  const name = fullName || (firstName ? `${firstName} ${lastName}`.trim() : "Unknown");
  const email = String(fields.email || fields.email_address || "").trim().toLowerCase();
  const phone = String(fields.phone_number || fields.phone || fields.mobile_phone || fields.mobile || "").trim();

  const knownKeys = new Set(["full_name", "name", "first_name", "last_name", "email", "email_address", "phone_number", "phone", "mobile_phone", "mobile"]);
  const extraEntries = Object.entries(fields).filter(([k]) => !knownKeys.has(k) && fields[k]);
  const extraNoteText = extraEntries.map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join("; ");

  return {
    id: nextId,
    name,
    email: email || `meta-${meta.leadgenId}@noemail.lead`,
    phone,
    workshop: "",
    status: "New",
    source: "Meta",
    metaLeadId: String(meta.leadgenId || ""),
    metaFormId: String(meta.formId || ""),
    metaAdId: String(meta.adId || ""),
    metaAdName: String(meta.adName || ""),
    metaAdsetName: String(meta.adsetName || ""),
    metaCampaignName: String(meta.campaignName || ""),
    createdAt: new Date().toISOString().slice(0, 10),
    dialed: "",
    callStatus: "",
    wsStatus: "",
    whatsappInvite: "",
    counselor: counselorName,
    postDialed: "",
    coursePitched: "",
    courseStatus: "",
    admissionStatus: "",
    postStatusUpdated: false,
    preActivityUpdates: 0,
    postActivityUpdates: 0,
    workshopActivityHistory: [],
    admissionActivityHistory: [],
    whatsappGroupStatus: "",
    leadNotes: extraNoteText
      ? [{ text: `Meta form data: ${extraNoteText}`, createdAt: new Date().toISOString() }]
      : [],
    importSourceFiles: ["Meta Lead Ads"],
    importSourceSheets: []
  };
}

// ─── Meta API Routes ──────────────────────────────────────────────────────────

// Webhook verification (GET) — called once by Meta when you register the webhook.
app.get("/api/meta/webhook", async (req, res) => {
  try {
    await initMongo();
    const mode      = String(req.query["hub.mode"] || "");
    const token     = String(req.query["hub.verify_token"] || "");
    const challenge = String(req.query["hub.challenge"] || "");

    if (mode !== "subscribe" || !token) {
      return res.status(400).json({ message: "Invalid verification request." });
    }

    const config = await getMetaConfig();
    if (!config.verifyToken || token !== config.verifyToken) {
      return res.status(403).json({ message: "Verify token mismatch." });
    }

    res.setHeader("Content-Type", "text/plain");
    return res.send(challenge);
  } catch (err) {
    return res.status(500).json({ message: "Webhook verification failed.", details: err.message });
  }
});

// Webhook event receiver (POST) — Meta sends lead events here.
app.post("/api/meta/webhook", async (req, res) => {
  // Respond 200 immediately so Meta doesn't retry; process async.
  res.status(200).json({ ok: true });

  try {
    await initMongo();
    const config = await getMetaConfig();

    // Verify HMAC-SHA256 signature to confirm the request is from Meta.
    if (config.appSecret) {
      const sig = req.headers["x-hub-signature-256"] || "";
      const rawBuf = req.rawBody;
      if (!rawBuf || !verifyWebhookSignature(rawBuf, sig, config.appSecret)) {
        await saveMetaLog({ type: "error", message: "Signature verification failed", headers: { sig } });
        return;
      }
    }

    const body = req.body || {};
    if (body.object !== "page") {
      await saveMetaLog({ type: "ignored", message: "Non-page event", object: body.object });
      return;
    }

    const entries = Array.isArray(body.entry) ? body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change.field !== "leadgen") continue;
        const value = change.value || {};
        const leadgenId = String(value.leadgen_id || "");
        const formId    = String(value.form_id || "");
        const pageId    = String(value.page_id || entry.id || "");

        if (!leadgenId) {
          await saveMetaLog({ type: "error", message: "Missing leadgen_id", raw: value });
          continue;
        }

        // Filter to configured page and forms (if specified).
        if (config.pageId && pageId && pageId !== String(config.pageId)) {
          await saveMetaLog({ type: "ignored", message: `Page ID mismatch: got ${pageId}`, leadgenId });
          continue;
        }
        const allowedForms = Array.isArray(config.formIds) ? config.formIds.filter(Boolean) : [];
        if (allowedForms.length && !allowedForms.includes(formId)) {
          await saveMetaLog({ type: "ignored", message: `Form ID ${formId} not in allowed list`, leadgenId });
          continue;
        }

        let metaLead = null;
        try {
          if (!config.pageAccessToken) throw new Error("Page Access Token not configured.");
          metaLead = await fetchMetaLeadDetails(leadgenId, config.pageAccessToken);
        } catch (fetchErr) {
          await saveMetaLog({ type: "error", message: `Failed to fetch lead details: ${fetchErr.message}`, leadgenId, formId });
          continue;
        }

        const stateDoc = await getStateDoc();
        const leads = Array.isArray(stateDoc.leads) ? stateDoc.leads : [];

        // De-duplicate: skip if lead with same Meta ID already exists.
        const isDuplicate = leads.some((l) => String(l.metaLeadId || "") === leadgenId);
        if (isDuplicate) {
          await saveMetaLog({ type: "ignored", message: "Duplicate lead (already imported)", leadgenId });
          continue;
        }

        const counselorName = await assignCounselorRoundRobin(stateDoc);
        const nextId = Math.max(...leads.map((l) => Number(l.id) || 0), 0) + 1;
        const newLead = buildMetaLead(
          metaLead.field_data,
          { leadgenId, formId, adId: metaLead.ad_id, adName: metaLead.ad_name, adsetName: metaLead.adset_name, campaignName: metaLead.campaign_name },
          counselorName,
          nextId
        );

        const now = new Date().toISOString();
        await stateCollection.updateOne(
          { _id: STATE_DOC_ID },
          {
            $push: { leads: newLead },
            $set:  { updatedAt: now },
            $setOnInsert: { counselors: [], allocation: [], tasks: [], createdAt: now }
          },
          { upsert: true }
        );
        // Invalidate cache so the next read hits MongoDB.
        cachedStateDoc   = null;
        cachedStateDocAt = 0;

        await saveMetaLog({
          type: "success",
          message: `Lead created: ${newLead.name} → ${counselorName}`,
          leadgenId,
          formId,
          leadId: nextId,
          leadName: newLead.name,
          counselor: counselorName,
          campaignName: newLead.metaCampaignName
        });
      }
    }
  } catch (err) {
    // Errors here are internal; Meta already got 200 OK.
    try { await saveMetaLog({ type: "error", message: `Webhook processing error: ${err.message}` }); } catch {}
  }
});

// Get Meta integration config (admin or marketing).
app.get("/api/meta/config", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession || !["admin", "marketing"].includes(activeSession.session.role)) {
      return res.status(403).json({ message: "Access required." });
    }
    const config = await getMetaConfig();
    // Never return the raw app secret or access token to the browser;
    // return masked indicators so the UI can show configured/not configured.
    return res.json({
      enabled:          config.enabled ?? false,
      verifyToken:      config.verifyToken || "",
      appSecretSet:     !!(config.appSecret),
      pageAccessTokenSet: !!(config.pageAccessToken),
      pageId:           config.pageId || "",
      formIds:          Array.isArray(config.formIds) ? config.formIds : [],
      roundRobinIndex:  config.roundRobinIndex ?? 0
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch Meta config.", details: err.message });
  }
});

// Save Meta integration config (admin only).
app.put("/api/meta/config", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession || activeSession.session.role !== "admin") {
      return res.status(403).json({ message: "Admin access required." });
    }

    const body = req.body || {};
    const patch = {};

    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.verifyToken === "string") patch.verifyToken = String(body.verifyToken).trim();
    // Only update secrets when explicitly provided (non-empty string).
    if (typeof body.appSecret === "string" && body.appSecret.trim()) {
      patch.appSecret = String(body.appSecret).trim();
    }
    if (typeof body.pageAccessToken === "string" && body.pageAccessToken.trim()) {
      patch.pageAccessToken = String(body.pageAccessToken).trim();
    }
    if (typeof body.pageId === "string") patch.pageId = String(body.pageId).trim();
    if (Array.isArray(body.formIds)) {
      patch.formIds = body.formIds.map((f) => String(f).trim()).filter(Boolean);
    }

    const now = new Date().toISOString();
    await metaConfigCollection.updateOne(
      { _id: META_CONFIG_DOC_ID },
      { $set: { ...patch, updatedAt: now }, $setOnInsert: { roundRobinIndex: 0, createdAt: now } },
      { upsert: true }
    );

    const updated = await getMetaConfig();
    return res.json({
      ok: true,
      enabled:            updated.enabled ?? false,
      verifyToken:        updated.verifyToken || "",
      appSecretSet:       !!(updated.appSecret),
      pageAccessTokenSet: !!(updated.pageAccessToken),
      pageId:             updated.pageId || "",
      formIds:            Array.isArray(updated.formIds) ? updated.formIds : [],
      roundRobinIndex:    updated.roundRobinIndex ?? 0
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to save Meta config.", details: err.message });
  }
});

// Get recent webhook logs (admin or marketing).
app.get("/api/meta/logs", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession || !["admin", "marketing"].includes(activeSession.session.role)) {
      return res.status(403).json({ message: "Access required." });
    }
    const limit = Math.min(Number(req.query.limit) || 50, MAX_META_LOGS);
    const logs = await metaLogsCollection
      .find({}, { projection: { _id: 0 } })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .toArray();
    return res.json(logs);
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch logs.", details: err.message });
  }
});

// Clear webhook logs (admin only).
app.delete("/api/meta/logs", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession || activeSession.session.role !== "admin") {
      return res.status(403).json({ message: "Admin access required." });
    }
    await metaLogsCollection.deleteMany({});
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ message: "Failed to clear logs.", details: err.message });
  }
});

// Reset round-robin pointer (admin only).
app.post("/api/meta/rr-state/reset", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession || activeSession.session.role !== "admin") {
      return res.status(403).json({ message: "Admin access required." });
    }
    await metaConfigCollection.updateOne(
      { _id: META_CONFIG_DOC_ID },
      { $set: { roundRobinIndex: 0, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );
    return res.json({ ok: true, roundRobinIndex: 0 });
  } catch (err) {
    return res.status(500).json({ message: "Failed to reset round-robin.", details: err.message });
  }
});

app.use("/api", async (_req, res, next) => {
  try {
    await initMongo();
    next();
  } catch (error) {
    res.status(500).json({ message: "Database connection failed", details: error.message });
  }
});

function sanitizeState(payload = {}) {
  const next = {};

  if (Array.isArray(payload.leads)) {
    next.leads = payload.leads;
  }
  if (Array.isArray(payload.counselors)) {
    next.counselors = payload.counselors;
  }
  if (Array.isArray(payload.marketingUsers)) {
    next.marketingUsers = payload.marketingUsers;
  }
  if (Array.isArray(payload.allocation)) {
    next.allocation = payload.allocation;
  }
  if (Array.isArray(payload.tasks)) {
    next.tasks = payload.tasks;
  }

  return next;
}

async function getStateDoc() {
  // Return the in-memory cache only when it is still fresh.
  // This ensures that writes from other server instances (e.g. on Vercel) are picked up
  // within STATE_CACHE_TTL_MS without requiring a full process restart.
  if (cachedStateDoc && (Date.now() - cachedStateDocAt) < STATE_CACHE_TTL_MS) {
    return cachedStateDoc;
  }

  const existing = await stateCollection.findOne({ _id: STATE_DOC_ID });
  if (existing) {
    return cacheStateDoc(existing);
  }

  const initial = cacheStateDoc({
    _id: STATE_DOC_ID,
    leads: [],
    counselors: [],
    allocation: [],
    tasks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });

  await stateCollection.insertOne(initial);
  return initial;
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const role = String(req.body?.role || "").trim().toLowerCase();
    const identifier = String(req.body?.identifier || "").trim();
    const password = String(req.body?.password || "").trim();

    if (!role || !identifier || !password) {
      return res.status(400).json({ message: "Role, identifier, and password are required." });
    }

    if (role === "admin") {
      if (identifier !== ADMIN_USER.id || password !== ADMIN_USER.password) {
        return res.status(401).json({ message: "Invalid credentials for selected role." });
      }

      const session = await persistSession(res, {
        role,
        name: ADMIN_USER.name,
        email: ADMIN_USER.id,
        permissions: {
          ...DEFAULT_PERMISSIONS,
          dashboard: true,
          preWorkshop: true,
          postWorkshop: true,
          taskTracker: false,
          lostLeads: true,
          monitoring: true
        }
      });

      return res.json({
        session,
        landing: "dashboard.html"
      });
    }

    if (role === "marketing") {
      const state = await getStateDoc();
      const marketingUsers = Array.isArray(state.marketingUsers) ? state.marketingUsers : [];
      const email = identifier.toLowerCase();
      const marketingUser = marketingUsers.find(
        (item) => String(item.email || "").trim().toLowerCase() === email && String(item.password || "") === password
      );

      if (!marketingUser) {
        if (!marketingUsers.length) {
          return res.status(404).json({
            message: "Marketing credentials are not available. Make sure marketing user records exist in the shared database."
          });
        }
        return res.status(401).json({ message: "Invalid credentials for selected role." });
      }

      const session = await persistSession(res, {
        role,
        name: marketingUser.name,
        email: marketingUser.email,
        permissions: { metaIntegration: true }
      });

      return res.json({ session, landing: "meta-integration.html" });
    }

    if (role !== "counselor") {
      return res.status(400).json({ message: "Unsupported role." });
    }

    const state = await getStateDoc();
    const counselors = Array.isArray(state.counselors) ? state.counselors : [];
    const email = identifier.toLowerCase();
    const counselor = counselors.find(
      (item) => String(item.email || "").trim().toLowerCase() === email && String(item.password || "") === password
    );

    if (!counselor) {
      if (!counselors.length) {
        return res.status(404).json({
          message: "Counselor credentials are not available on this deployment. Check Vercel MONGODB_URI and make sure counselor records exist in the shared database."
        });
      }

      return res.status(401).json({ message: "Invalid credentials for selected role." });
    }

    const permissions = {
      ...DEFAULT_PERMISSIONS,
      ...(counselor.permissions || {}),
      dashboard: false
    };

    const session = await persistSession(res, {
      role,
      name: counselor.name,
      email: counselor.email,
      permissions
    });

    const landing = permissions.preWorkshop
      ? "pre-workshop.html"
      : permissions.postWorkshop
        ? "post-workshop.html"
        : permissions.lostLeads
          ? "lost-leads.html"
          : permissions.monitoring
            ? "monitoring.html"
            : "index.html";

    return res.json({ session, landing });
  } catch (error) {
    return res.status(500).json({ message: "Login failed", details: error.message });
  }
});

app.get("/api/auth/session", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession) {
      return res.status(401).json({ message: "No active session." });
    }

    return res.json(activeSession.session);
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch session", details: error.message });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    const token = String(cookies[SESSION_COOKIE_NAME] || "").trim();
    if (token) {
      evictCachedSession(token);
      await sessionCollection.deleteOne({ token });
    }

    res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: "Logout failed", details: error.message });
  }
});

app.get("/api/preferences/:scope", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession) {
      return res.status(401).json({ message: "No active session." });
    }

    const scope = String(req.params.scope || "").trim();
    if (!scope) {
      return res.status(400).json({ message: "Preference scope is required." });
    }

    const preference = await preferenceCollection.findOne({
      ownerKey: buildOwnerKey(activeSession.session),
      scope
    });

    return res.json({ value: preference?.value ?? null });
  } catch (error) {
    return res.status(500).json({ message: "Failed to fetch preference", details: error.message });
  }
});

app.put("/api/preferences/:scope", async (req, res) => {
  try {
    const activeSession = await getSessionFromRequest(req);
    if (!activeSession) {
      return res.status(401).json({ message: "No active session." });
    }

    const scope = String(req.params.scope || "").trim();
    if (!scope) {
      return res.status(400).json({ message: "Preference scope is required." });
    }

    const now = new Date().toISOString();
    const ownerKey = buildOwnerKey(activeSession.session);
    const value = req.body?.value ?? null;

    await preferenceCollection.updateOne(
      { ownerKey, scope },
      {
        $set: {
          value,
          updatedAt: now
        },
        $setOnInsert: {
          ownerKey,
          scope,
          createdAt: now
        }
      },
      { upsert: true }
    );

    return res.json({ ok: true, value });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save preference", details: error.message });
  }
});

app.get("/api/state", async (req, res) => {
  try {
    const state = await getStateDoc();
    // Use updatedAt as a cheap ETag so clients can send If-None-Match and get
    // a 304 Not Modified when nothing has changed — avoiding re-transferring
    // the full (potentially 200 KB) payload on every 15 s poll.
    const etag = buildStateEtag(state);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache"); // allow conditional GET, no blind caching
    if (req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    res.json(buildStateResponse(state));
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch state", details: error.message });
  }
});

app.put("/api/state", async (req, res) => {
  try {
    const sanitized = sanitizeState(req.body || {});
    if (!Object.keys(sanitized).length) {
      return res.status(400).json({ message: "No valid state fields provided." });
    }

    const currentState = await getStateDoc();
    const expectedEtag = String(req.headers["if-match"] || "").trim();
    const currentEtag = buildStateEtag(currentState);

    if (expectedEtag && expectedEtag !== currentEtag) {
      return res.status(412).json({
        message: "State changed on the server. Reload the latest data and retry your update.",
        updatedAt: currentState.updatedAt || null
      });
    }

    const now = new Date().toISOString();
    const nextState = cacheStateDoc({
      ...currentState,
      ...sanitized,
      updatedAt: now
    });

    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          ...sanitized,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );

    res.setHeader("ETag", buildStateEtag(nextState));
    return res.json(buildStateResponse(nextState));
  } catch (error) {
    return res.status(500).json({ message: "Failed to update state", details: error.message });
  }
});

app.put("/api/state/reset", async (_req, res) => {
  try {
    const now = new Date().toISOString();
    const resetFields = {
      leads: [],
      allocation: [],
      tasks: [],
      updatedAt: now,
      clearedAt: now
    };

    const result = await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: resetFields,
        $setOnInsert: {
          counselors: [],
          createdAt: now
        }
      },
      { upsert: true }
    );

    const currentState = await getStateDoc();
    const nextState = cacheStateDoc({ ...currentState, ...resetFields });

    return res.json(buildStateResponse(nextState));
  } catch (error) {
    return res.status(500).json({ message: "Failed to reset state", details: error.message });
  }
});

app.get("/api/leads", async (_req, res) => {
  try {
    const state = await getStateDoc();
    res.json(Array.isArray(state.leads) ? state.leads : []);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch leads", details: error.message });
  }
});

app.put("/api/leads", async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ message: "Leads payload must be an array." });
  }

  try {
    const currentState = await getStateDoc();
    const nextState = cacheStateDoc({
      ...currentState,
      leads: req.body,
      updatedAt: new Date().toISOString()
    });

    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          leads: req.body,
          updatedAt: nextState.updatedAt
        },
        $setOnInsert: {
          counselors: [],
          allocation: [],
          tasks: [],
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save leads", details: error.message });
  }
});

app.get("/api/counselors", async (_req, res) => {
  try {
    const state = await getStateDoc();
    res.json(Array.isArray(state.counselors) ? state.counselors : []);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch counselors", details: error.message });
  }
});

app.put("/api/counselors", async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ message: "Counselors payload must be an array." });
  }

  try {
    const currentState = await getStateDoc();
    const nextState = cacheStateDoc({
      ...currentState,
      counselors: req.body,
      updatedAt: new Date().toISOString()
    });

    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          counselors: req.body,
          updatedAt: nextState.updatedAt
        },
        $setOnInsert: {
          leads: [],
          allocation: [],
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save counselors", details: error.message });
  }
});

app.get("/api/allocation", async (_req, res) => {
  try {
    const state = await getStateDoc();
    res.json(Array.isArray(state.allocation) ? state.allocation : []);
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch allocation", details: error.message });
  }
});

app.put("/api/allocation", async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ message: "Allocation payload must be an array." });
  }

  try {
    const currentState = await getStateDoc();
    const nextState = cacheStateDoc({
      ...currentState,
      allocation: req.body,
      updatedAt: new Date().toISOString()
    });

    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          allocation: req.body,
          updatedAt: nextState.updatedAt
        },
        $setOnInsert: {
          leads: [],
          counselors: [],
          tasks: [],
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ message: "Failed to save allocation", details: error.message });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "dashboard.html"));
});

app.get("/meta-integration", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "meta-integration.html"));
});

async function start() {
  await initMongo();

  app.listen(PORT, () => {
    console.log(`DV Workshop platform is running at http://localhost:${PORT}`);
    console.log(`Mongo dataset: ${MONGODB_DB_NAME}.${MONGODB_STATE_COLLECTION}`);
  });
}

if (process.env.VERCEL) {
  module.exports = app;
} else {
  start().catch((error) => {
    console.error("Server startup failed:", error.message);
    process.exit(1);
  });
}
