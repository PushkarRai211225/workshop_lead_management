require("dotenv").config();
const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "dv_workshop_site";
const MONGODB_STATE_COLLECTION = process.env.MONGODB_STATE_COLLECTION || "app_state";
const STATE_DOC_ID = "global";

app.use(express.json({ limit: "5mb" }));

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.use(express.static(ROOT_DIR));

let stateCollection;
let mongoInitPromise;

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
  const existing = await stateCollection.findOne({ _id: STATE_DOC_ID });
  if (existing) {
    return existing;
  }

  const initial = {
    _id: STATE_DOC_ID,
    leads: [],
    counselors: [],
    allocation: [],
    tasks: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  await stateCollection.insertOne(initial);
  return initial;
}

app.get("/api/state", async (_req, res) => {
  try {
    const state = await getStateDoc();
    res.json({
      leads: Array.isArray(state.leads) ? state.leads : [],
      counselors: Array.isArray(state.counselors) ? state.counselors : [],
      allocation: Array.isArray(state.allocation) ? state.allocation : [],
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
      updatedAt: state.updatedAt || null
    });
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

    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          ...sanitized,
          updatedAt: new Date().toISOString()
        },
        $setOnInsert: {
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    const state = await getStateDoc();
    return res.json({
      leads: Array.isArray(state.leads) ? state.leads : [],
      counselors: Array.isArray(state.counselors) ? state.counselors : [],
      allocation: Array.isArray(state.allocation) ? state.allocation : [],
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
      updatedAt: state.updatedAt || null
    });
  } catch (error) {
    return res.status(500).json({ message: "Failed to update state", details: error.message });
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
    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          leads: req.body,
          updatedAt: new Date().toISOString()
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
    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          counselors: req.body,
          updatedAt: new Date().toISOString()
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
    await stateCollection.updateOne(
      { _id: STATE_DOC_ID },
      {
        $set: {
          allocation: req.body,
          updatedAt: new Date().toISOString()
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
