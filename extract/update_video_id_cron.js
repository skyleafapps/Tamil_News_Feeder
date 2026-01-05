// update_videoId_firestore.js (Node 18+)
// Run: node update_videoId_firestore.js
//
// Does:
// 1) Read state from Firestore: channel_id/channels (items[])
// 2) Check YouTube live status + update each state's item's id if changed
// 3) Write back to Firestore state doc (merge:true so other fields remain)
// 4) If any id changed -> patch channels/list by TITLE and update ONLY `id` there,
//    keeping url/image/m3u8/etc same + version++

import { config as dotenvConfig } from "dotenv";
import admin from "firebase-admin";

dotenvConfig();

// ---------- Firebase init (supports FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_KEY like your uploader) ----------
let raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_KEY;

if (!raw) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_JSON (or FIREBASE_KEY) in env.");
  process.exit(1);
}

// If base64, decode
if (!raw.trim().startsWith("{")) {
  raw = Buffer.from(raw, "base64").toString("utf8");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(raw);
} catch (e) {
  console.error("❌ Firebase service account env is not valid JSON.");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ✅ State doc (your channel ids source of truth)
const STATE_REF = db.collection("channel_id").doc("channels");

// ✅ Publish doc (your app uses this; includes m3u8 + youtube)
const PUBLISH_REF = db.collection("channels").doc("list");

// ---------- IST time helper ----------
function nowIST() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} IST`;
}

// ---------- YouTube helpers ----------
const YT_API_KEY = process.env.YT_API_KEY;
if (!YT_API_KEY) {
  console.error("❌ Missing YT_API_KEY in env");
  process.exit(1);
}

async function ytGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube API ${res.status}: ${text}`);
  }
  return res.json();
}

async function isVideoLive(videoId) {
  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    `?part=snippet,liveStreamingDetails&id=${encodeURIComponent(videoId)}` +
    `&key=${encodeURIComponent(YT_API_KEY)}`;

  const data = await ytGet(url);
  const item = data.items?.[0];
  if (!item) return false;

  if (item.snippet?.liveBroadcastContent === "live") return true;
  if (item.liveStreamingDetails?.actualEndTime) return false;

  return false;
}

async function getCurrentLiveVideoId(channelId) {
  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=id&channelId=${encodeURIComponent(channelId)}` +
    `&eventType=live&type=video&maxResults=1` +
    `&key=${encodeURIComponent(YT_API_KEY)}`;

  const data = await ytGet(url);
  return data.items?.[0]?.id?.videoId || null;
}

// ---------- Publish: update ONLY `id` in channels/list by matching title ----------
async function publishToChannelsList(stateChannels) {
  // Map: title -> latest id from state
  const idByTitle = new Map();
  for (const ch of stateChannels || []) {
    const t = String(ch?.title || "").trim();
    const id = String(ch?.id || "").trim();
    if (t && id) idByTitle.set(t, id);
  }

  const snap = await PUBLISH_REF.get();
  if (!snap.exists) {
    throw new Error("❌ channels/list doc not found. Create it once with items first.");
  }

  const data = snap.data() || {};
  const items = Array.isArray(data.items) ? data.items : [];

  let changed = 0;

  // Patch ONLY id; keep url/image/etc same
  for (const item of items) {
    const title = String(item?.title || "").trim();
    if (!title) continue;

    const newId = idByTitle.get(title);
    if (!newId) continue;

    const oldId = item?.id ? String(item.id).trim() : "";
    if (oldId !== newId) {
      item.id = newId;
      changed++;
    }
  }

  if (changed === 0) {
    console.log("⏭️ channels/list already up-to-date. No publish needed.");
    return;
  }

  const currentVersion = data.version ? Number(data.version) : 0;
  const newVersion = currentVersion + 1;

  await PUBLISH_REF.set(
    {
      version: newVersion,
      items, // same array, only ids patched
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true } // ✅ keep any other fields in the doc
  );

  console.log(`✅ channels/list patched (id-only by title)`);
  console.log(`🧩 IDs updated: ${changed}`);
  console.log(`➡️ Old Version: ${currentVersion}`);
  console.log(`➡️ New Version: ${newVersion}`);
  console.log(`📦 Total items: ${items.length}`);
}

// ---------- Main ----------
async function main() {
  // 1) READ from Firestore state doc
  const snap = await STATE_REF.get();
  const state = snap.exists ? snap.data() : { items: [] };
  const channels = Array.isArray(state?.items) ? state.items : [];

  if (!channels.length) {
    console.log("⚠️ No items found in Firestore: channel_id/channels.items");
    console.log("👉 First seed it using your upload_channels_tofirestore.js");
  }

  const runTimeIST = nowIST();
  let updatedCount = 0;

  // 2) Update state ids
  for (const ch of channels) {
    const title = String(ch.title || "").trim();
    const channelId = ch.youtubeChannelId;
    const oldVideoId = ch.id;

    if (!title || !channelId) continue;

    if (oldVideoId) {
      let stillLive = false;
      try {
        stillLive = await isVideoLive(oldVideoId);
      } catch (e) {
        console.log(`⚠️ ${title}: live-check failed, will search. (${e.message})`);
      }

      if (stillLive) {
        console.log(`✅ ${title}: still live (${oldVideoId})`);
        continue;
      }
    }

    const newLiveId = await getCurrentLiveVideoId(channelId);

    if (newLiveId && newLiveId !== oldVideoId) {
      ch.id = newLiveId;
      updatedCount++;
      console.log(`🔁 ${title}: ${oldVideoId || "-"} → ${newLiveId}`);
    } else if (!newLiveId) {
      console.log(`• ${title}: currently not live`);
    } else {
      console.log(`• ${title}: no change`);
    }
  }

  console.log("\n✅ RESULT");
  console.log(`channels updated: ${updatedCount}`);
  console.log(`lastRunIST:       ${runTimeIST}`);

  // 3) WRITE back state doc (merge true so you don't delete extra fields)
  await STATE_REF.set({ lastRunIST: runTimeIST, items: channels }, { merge: true });

  // 4) Publish ONLY if something changed
  if (updatedCount > 0) {
    console.log("\n🚀 Changes found. Publishing ONLY id updates to channels/list...");
    await publishToChannelsList(channels);
    console.log("✅ Publish completed.");
  } else {
    console.log("\n⏭️ No changes detected. Skipping publish.");
  }
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
