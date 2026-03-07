/**
 * update_all_streams.js
 *
 * Design:
 * - config.json contains 3 channels
 * - one channel can have "main": true
 * - cron runs every 30 mins
 * - main channel -> discovery every run
 * - other channels -> discovery every 1 hour (top-of-hour runs only)
 * - store ONLY live streams in Firestore
 * - Firestore doc path: all_streams/main
 * - doc shape:
 *   {
 *     updatedAt: 1710000000000,
 *     items: [
 *       {
 *         videoId: "xxxx",
 *         title: "Live title",
 *         channelName: "Polimer News",
 *         thumbnailUrl: "https://...",
 *         fetchedAt: 1710000000000
 *       }
 *     ]
 *   }
 *
 * ENV:
 * - YT_API_KEY_FOR_ALL_STREAMS
 * - FIREBASE_KEY
 *
 * Notes:
 * - FIREBASE_KEY can be:
 *   1) raw JSON string of service account
 *   2) base64 encoded JSON string
 *   3) JSON string with \n escaped in private_key
 */

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
require("dotenv").config();

// -----------------------------
// CONFIG
// -----------------------------
const CONFIG_PATH = path.join(__dirname, "config.json");
const YT_API_KEY = process.env.YT_API_KEY_FOR_ALL_STREAMS;
const FIREBASE_KEY = process.env.FIREBASE_KEY;

const FIRESTORE_COLLECTION = "all_streams";
const FIRESTORE_DOC_ID = "main";

const YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

// -----------------------------
// VALIDATIONS
// -----------------------------
if (!YT_API_KEY) {
  throw new Error("Missing env: YT_API_KEY_FOR_ALL_STREAMS");
}

if (!FIREBASE_KEY) {
  throw new Error("Missing env: FIREBASE_KEY");
}

if (!fs.existsSync(CONFIG_PATH)) {
  throw new Error(`config.json not found at: ${CONFIG_PATH}`);
}

// -----------------------------
// HELPERS
// -----------------------------
function parseFirebaseKey(input) {
  // Try raw JSON first
  try {
    const parsed = JSON.parse(input);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (_) {
    // continue
  }

  // Try base64 JSON
  try {
    const decoded = Buffer.from(input, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (_) {
    // continue
  }

  throw new Error("FIREBASE_KEY is not valid JSON or base64 JSON");
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const channels = JSON.parse(raw);

  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error("config.json must contain a non-empty array");
  }

  const validChannels = channels
    .filter((c) => c && c.title && c.youtubeChannelId)
    .map((c) => ({
      title: String(c.title).trim(),
      youtubeChannelId: String(c.youtubeChannelId).trim(),
      main: Boolean(c.main),
    }));

  if (validChannels.length === 0) {
    throw new Error("No valid channels found in config.json");
  }

  const mainChannels = validChannels.filter((c) => c.main);
  if (mainChannels.length > 1) {
    throw new Error("Only one channel should have main:true");
  }

  return validChannels;
}

function getRunMode(now = new Date()) {
  // Cron runs every 30 mins.
  // We discover:
  // - main channel every run
  // - other channels only at top-of-hour runs
  //
  // Example:
  // 10:00 -> main + others
  // 10:30 -> main only
  //
  // This keeps:
  // - main: every 30 mins
  // - others: every 1 hour

  const minute = now.getUTCMinutes();
  const isTopOfHourWindow = minute < 15; // safe window for cron around :00
  return {
    isTopOfHourWindow,
    iso: now.toISOString(),
    ts: Date.now(),
  };
}

function pickBestThumbnail(thumbnails = {}) {
  return (
    thumbnails.maxres?.url ||
    thumbnails.standard?.url ||
    thumbnails.high?.url ||
    thumbnails.medium?.url ||
    thumbnails.default?.url ||
    ""
  );
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function uniqueByVideoId(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.videoId) continue;
    map.set(item.videoId, item);
  }
  return Array.from(map.values());
}

// -----------------------------
// FIREBASE INIT
// -----------------------------
function initFirebase() {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  const serviceAccount = parseFirebaseKey(FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin.firestore();
}

// -----------------------------
// YOUTUBE DISCOVERY
// -----------------------------
async function fetchLiveStreamsForChannel(channel) {
  const params = new URLSearchParams({
    part: "snippet",
    channelId: channel.youtubeChannelId,
    eventType: "live",
    type: "video",
    maxResults: "50",
    key: YT_API_KEY,
  });

  const url = `${YOUTUBE_SEARCH_URL}?${params.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `YouTube search failed for ${channel.title} | status=${response.status} | body=${text}`
    );
  }

  const data = await response.json();
  const items = Array.isArray(data.items) ? data.items : [];

  return items
    .map((item) => {
      const videoId = item?.id?.videoId || "";
      const title = item?.snippet?.title || "";
      const thumbnailUrl = pickBestThumbnail(item?.snippet?.thumbnails);

      if (!videoId || !title) return null;

      return {
        videoId,
        title,
        channelName: channel.title, // from config.json only
        thumbnailUrl,
      };
    })
    .filter(Boolean);
}

// -----------------------------
// FIRESTORE DOC MERGE
// -----------------------------
async function loadCurrentDoc(db) {
  const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC_ID);
  const snap = await ref.get();

  if (!snap.exists) {
    return {
      ref,
      data: {
        updatedAt: 0,
        items: [],
      },
    };
  }

  const data = snap.data() || {};
  return {
    ref,
    data: {
      updatedAt: data.updatedAt || 0,
      items: Array.isArray(data.items) ? data.items : [],
    },
  };
}

function mergeLiveItems(existingItems, processedChannelNames, freshItems, nowTs) {
  // Remove older entries for channels processed in this run.
  // Then add freshly discovered live streams for those channels.
  // Unprocessed channels remain untouched.
  const processedSet = new Set(processedChannelNames);

  const remainingOldItems = existingItems.filter(
    (item) => !processedSet.has(item.channelName)
  );

  const normalizedFresh = freshItems.map((item) => ({
    videoId: item.videoId,
    title: item.title,
    channelName: item.channelName,
    thumbnailUrl: item.thumbnailUrl,
    fetchedAt: nowTs,
  }));

  const merged = [...remainingOldItems, ...normalizedFresh];

  // de-duplicate just in case
  return uniqueByVideoId(merged);
}

// -----------------------------
// MAIN RUN
// -----------------------------
async function run() {
  const now = new Date();
  const runMode = getRunMode(now);
  const db = initFirebase();
  const channels = readConfig();

  const mainChannel = channels.find((c) => c.main);
  const otherChannels = channels.filter((c) => !c.main);

  if (!mainChannel) {
    throw new Error("One channel must have main:true in config.json");
  }

  // Decide which channels to process this run
  const channelsToProcess = [mainChannel];

  if (runMode.isTopOfHourWindow) {
    channelsToProcess.push(...otherChannels);
  }

  console.log("==================================================");
  console.log("[ALL_STREAMS] Run started");
  console.log(`[ALL_STREAMS] UTC now          : ${runMode.iso}`);
  console.log(`[ALL_STREAMS] Top-of-hour run  : ${runMode.isTopOfHourWindow}`);
  console.log(
    `[ALL_STREAMS] Channels to scan : ${channelsToProcess
      .map((c) => c.title)
      .join(", ")}`
  );
  console.log("==================================================");

  // Discover live streams for selected channels
  const discoveredPerChannel = await Promise.all(
    channelsToProcess.map(async (channel) => {
      try {
        const items = await fetchLiveStreamsForChannel(channel);
        console.log(
          `[ALL_STREAMS] ${channel.title} -> found ${items.length} live stream(s)`
        );
        return {
          channelName: channel.title,
          items,
        };
      } catch (error) {
        console.error(
          `[ALL_STREAMS] ${channel.title} -> discovery failed: ${error.message}`
        );
        return {
          channelName: channel.title,
          items: null, // means keep existing items for this channel unchanged if failure
          error: true,
        };
      }
    })
  );

  // Load current Firestore doc
  const { ref, data } = await loadCurrentDoc(db);
  let existingItems = data.items;

  // Important:
  // If one channel's request fails, do not wipe its current streams.
  // So we only process channels whose fetch succeeded.
  const successfulResults = discoveredPerChannel.filter((x) => Array.isArray(x.items));
  const processedChannelNames = successfulResults.map((x) => x.channelName);
  const freshItems = successfulResults.flatMap((x) => x.items);

  const finalItems = mergeLiveItems(
    existingItems,
    processedChannelNames,
    freshItems,
    runMode.ts
  );

  // Optional sort:
  // 1) main channel first
  // 2) then others
  // 3) within same channel latest fetched first (same run anyway)
  const mainChannelName = mainChannel.title;
  finalItems.sort((a, b) => {
    if (a.channelName === mainChannelName && b.channelName !== mainChannelName) return -1;
    if (a.channelName !== mainChannelName && b.channelName === mainChannelName) return 1;
    return (b.fetchedAt || 0) - (a.fetchedAt || 0);
  });

  await ref.set(
    {
      updatedAt: runMode.ts,
      items: finalItems,
    },
    { merge: true }
  );

  console.log(`[ALL_STREAMS] Firestore updated: ${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`);
  console.log(`[ALL_STREAMS] Total live items : ${finalItems.length}`);
  console.log("[ALL_STREAMS] Done");
}

// -----------------------------
// EXECUTE
// -----------------------------
run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("[ALL_STREAMS] Fatal error:", error);
    process.exit(1);
  });