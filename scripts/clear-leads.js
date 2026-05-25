require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "dv_workshop_site";
const MONGODB_STATE_COLLECTION = process.env.MONGODB_STATE_COLLECTION || "app_state";

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI in environment.");
  process.exit(1);
}

async function run() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();

    const db = client.db(MONGODB_DB_NAME);
    const collection = db.collection(MONGODB_STATE_COLLECTION);

    const result = await collection.updateOne(
      { _id: "global" },
      {
        $set: {
          leads: [],
          allocation: [],
          tasks: [],
          updatedAt: new Date().toISOString()
        },
        $setOnInsert: {
          counselors: [],
          createdAt: new Date().toISOString()
        }
      },
      { upsert: true }
    );

    console.log(
      `Cleared leads, allocation, and tasks in ${MONGODB_DB_NAME}.${MONGODB_STATE_COLLECTION} while preserving counselor credentials (matched: ${result.matchedCount}, modified: ${result.modifiedCount}).`
    );
  } finally {
    await client.close();
  }
}

run().catch((error) => {
  console.error("Failed to clear leads:", error.message);
  process.exit(1);
});
