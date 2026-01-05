// seed_channels_to_firestore.js (Node 18+)
// Run: node seed_channels_to_firestore.js

import fs from "fs/promises";
import { config as dotenvConfig } from "dotenv";
import admin from "firebase-admin";

dotenvConfig();

// ---------- CONFIG ----------
const LOCAL_JSON_PATH = "../json/channelids.json";
const COLLECTION = "channel_id";
const DOC_ID = "channels";

// ---------- Firebase init ----------
const sa = process.env.FIREBASE_KEY;
if (!sa) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_JSON (service account JSON string).");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(sa)),
  });
}

const db = admin.firestore();

// ---------- Main ----------
async function main() {
  // 1) Read local JSON
  const raw = JSON.parse(await fs.readFile(LOCAL_JSON_PATH, "utf-8"));

  // Supports both formats:
  // A) { lastRunIST, items:[...] }
  // B) [ ...items... ]
  const items = Array.isArray(raw) ? raw : (raw.items || []);
  const lastRunIST =
    (!Array.isArray(raw) && raw.lastRunIST) ? raw.lastRunIST : null;

  if (!Array.isArray(items) || items.length === 0) {
    console.error("❌ No items found in local JSON.");
    process.exit(1);
  }

  // Basic cleanup (optional)
  const cleaned = items
    .map((x) => ({
      title: String(x.title || "").trim(),
      youtubeChannelId: String(x.youtubeChannelId || "").trim(),
      id: x.id ? String(x.id).trim() : "",
    }))
    .filter((x) => x.title && x.youtubeChannelId);

  if (cleaned.length === 0) {
    console.error("❌ After cleanup, items list is empty.");
    process.exit(1);
  }

  // 2) Upload to Firestore
  await db.collection(COLLECTION).doc(DOC_ID).set(
    {
      lastRunIST: lastRunIST || "seeded_from_local_json",
      items: cleaned,
      seededAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true } // keeps any other fields if you add later
  );

  console.log("✅ Uploaded to Firestore:");
  console.log(`   ${COLLECTION}/${DOC_ID}`);
  console.log(`   items: ${cleaned.length}`);
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
