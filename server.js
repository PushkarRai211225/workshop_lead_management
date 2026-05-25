require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
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

app.use(express.json({ limit: "5mb" }));

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.use(express.static(ROOT_DIR));

let stateCollection;
let sessionCollection;
let preferenceCollection;
let mongoInitPromise;
let cachedStateDoc = null;

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

  const sessionDoc = await sessionCollection.findOne({
    token,
    expiresAt: { $gt: new Date().toISOString() }
  });

  if (!sessionDoc) {
    return null;
  }

  return {
    token,
    session: sanitizeSession(sessionDoc)
  };
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
      const client = new MongoClient(MONGODB_URI);
      await client.connect();
      const db = client.db(MONGODB_DB_NAME);
      stateCollection = db.collection(MONGODB_STATE_COLLECTION);
      sessionCollection = db.collection(MONGODB_SESSION_COLLECTION);
      preferenceCollection = db.collection(MONGODB_PREFERENCE_COLLECTION);
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
  if (cachedStateDoc) {
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

app.get("/api/state", async (_req, res) => {
  try {
    const state = await getStateDoc();
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

    return res.json(buildStateResponse(nextState));
  } catch (error) {
    return res.status(500).json({ message: "Failed to update state", details: error.message });
  }
});

app.put("/api/state/reset", async (_req, res) => {
  try {
    const currentState = await getStateDoc();
    const now = new Date().toISOString();
    const nextState = cacheStateDoc({
      ...currentState,
      leads: [],
      allocation: [],
      tasks: [],
      updatedAt: now,
      clearedAt: now
    });

    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          leads: [],
          allocation: [],
          tasks: [],
          updatedAt: now,
          clearedAt: now
        },
        $setOnInsert: {
          counselors: [],
          createdAt: now
        }
      },
      { upsert: true }
    );

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
