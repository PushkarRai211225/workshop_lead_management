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
const STATE_DOC_ID = "global";
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
app.use(express.json({ limit: "5mb" }));
app.use(express.static(ROOT_DIR));

let stateCollection;
let sessionCollection;
let preferenceCollection;
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
    allocation: normalized.allocation,
    tasks: normalized.tasks,
    updatedAt: normalized.updatedAt || null,
    clearedAt: normalized.clearedAt || null
  };
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
      // Ensure a fast index on the session token so every auth'd request
      // resolves in a single indexed lookup instead of a full collection scan.
      await sessionCollection.createIndex(
        { token: 1 },
        { unique: true, background: true }
      ).catch(() => undefined); // ignore if index already exists
    })();
  }

  await mongoInitPromise;
}

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
    const etag = `"${state.updatedAt || "init"}"`.replace(/\s/g, "_");
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

    const now = new Date().toISOString();
    const currentState = await getStateDoc();

    // Use findOneAndUpdate with returnDocument:'after' so we return (and cache)
    // exactly what MongoDB stored, not just what we sent.  writeConcern j:true
    // ensures the write is flushed to the journal before MongoDB acknowledges it,
    // which prevents acknowledged-but-not-durable data loss on a crash/restart.
    const result = await stateCollection.findOneAndUpdate(
      { _id: STATE_DOC_ID },
      {
        $set: {
          ...sanitized,
          updatedAt: now
        },
        $setOnInsert: {
          leads: currentState.leads || [],
          counselors: currentState.counselors || [],
          allocation: currentState.allocation || [],
          tasks: currentState.tasks || [],
          createdAt: now
        }
      },
      {
        upsert: true,
        returnDocument: "after"
      }
    );

    // Fallback: if findOneAndUpdate returns null for some driver version, merge manually.
    const written = result?.value ?? result ?? { ...currentState, ...sanitized, updatedAt: now };
    const nextState = cacheStateDoc(written);

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

    const result = await stateCollection.findOneAndUpdate(
      { _id: STATE_DOC_ID },
      {
        $set: resetFields,
        $setOnInsert: {
          counselors: [],
          createdAt: now
        }
      },
      {
        upsert: true,
        returnDocument: "after"
      }
    );

    const written = result?.value ?? result ?? resetFields;
    const nextState = cacheStateDoc(written);

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
