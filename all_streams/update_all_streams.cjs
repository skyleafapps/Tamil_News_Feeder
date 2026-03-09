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
 *         actualStartTime: "2026-03-09T07:10:00Z",
 *         publishedAt: "2026-03-09T07:00:00Z",
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
const YOUTUBE_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";

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
  try {
    const parsed = JSON.parse(input);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (_) {
    // continue
  }

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
  // GitHub Actions can start late.
  // Treat 00..19 as top-of-hour window.
  const minute = now.getUTCMinutes();
  const isTopOfHourWindow = minute < 25;

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

function uniqueByVideoId(items) {
  const map = new Map();
  for (const item of items) {
    if (!item.videoId) continue;
    map.set(item.videoId, item);
  }
  return Array.from(map.values());
}

function toTime(value) {
  if (!value) return 0;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function compareLiveRecency(a, b) {
  const aActual = toTime(a.actualStartTime);
  const bActual = toTime(b.actualStartTime);

  if (bActual !== aActual) {
    return bActual - aActual;
  }

  const aPublished = toTime(a.publishedAt);
  const bPublished = toTime(b.publishedAt);

  if (bPublished !== aPublished) {
    return bPublished - aPublished;
  }

  return (b.fetchedAt || 0) - (a.fetchedAt || 0);
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
  const searchParams = new URLSearchParams({
    part: "snippet",
    channelId: channel.youtubeChannelId,
    eventType: "live",
    type: "video",
    order: "date",
    maxResults: "50",
    key: YT_API_KEY,
  });

  const searchUrl = `${YOUTUBE_SEARCH_URL}?${searchParams.toString()}`;

  const searchResponse = await fetch(searchUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!searchResponse.ok) {
    const text = await searchResponse.text();
    throw new Error(
      `YouTube search failed for ${channel.title} | status=${searchResponse.status} | body=${text}`
    );
  }

  const searchData = await searchResponse.json();
  const searchItems = Array.isArray(searchData.items) ? searchData.items : [];

  const basicItems = searchItems
    .map((item) => {
      const videoId = item?.id?.videoId || "";
      const title = item?.snippet?.title || "";
      const thumbnailUrl = pickBestThumbnail(item?.snippet?.thumbnails);
      const publishedAt = item?.snippet?.publishedAt || null;

      if (!videoId || !title) return null;

      return {
        videoId,
        title,
        channelName: channel.title,
        thumbnailUrl,
        publishedAt,
      };
    })
    .filter(Boolean);

  if (basicItems.length === 0) {
    return [];
  }

  const ids = basicItems.map((x) => x.videoId).join(",");
  const videosParams = new URLSearchParams({
    part: "snippet,liveStreamingDetails",
    id: ids,
    key: YT_API_KEY,
  });

  const videosUrl = `${YOUTUBE_VIDEOS_URL}?${videosParams.toString()}`;

  const videosResponse = await fetch(videosUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!videosResponse.ok) {
    const text = await videosResponse.text();
    throw new Error(
      `YouTube videos lookup failed for ${channel.title} | status=${videosResponse.status} | body=${text}`
    );
  }

  const videosData = await videosResponse.json();
  const videoItems = Array.isArray(videosData.items) ? videosData.items : [];

  const detailsMap = new Map();

  for (const item of videoItems) {
    const id = item?.id || "";
    if (!id) continue;

    detailsMap.set(id, {
      actualStartTime: item?.liveStreamingDetails?.actualStartTime || null,
      publishedAt: item?.snippet?.publishedAt || null,
    });
  }

  return basicItems.map((item) => {
    const details = detailsMap.get(item.videoId) || {};

    return {
      videoId: item.videoId,
      title: item.title,
      channelName: item.channelName,
      thumbnailUrl: item.thumbnailUrl,
      actualStartTime: details.actualStartTime || null,
      publishedAt: details.publishedAt || item.publishedAt || null,
    };
  });
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
  const processedSet = new Set(processedChannelNames);

  const remainingOldItems = existingItems.filter(
    (item) => !processedSet.has(item.channelName)
  );

  const normalizedFresh = freshItems.map((item) => ({
    videoId: item.videoId,
    title: item.title,
    channelName: item.channelName,
    thumbnailUrl: item.thumbnailUrl,
    actualStartTime: item.actualStartTime || null,
    publishedAt: item.publishedAt || null,
    fetchedAt: nowTs,
  }));

  const merged = [...remainingOldItems, ...normalizedFresh];
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
          items: null,
          error: true,
        };
      }
    })
  );

  const { ref, data } = await loadCurrentDoc(db);
  const existingItems = data.items;

  const successfulResults = discoveredPerChannel.filter((x) => Array.isArray(x.items));
  const processedChannelNames = successfulResults.map((x) => x.channelName);
  const freshItems = successfulResults.flatMap((x) => x.items);

  let finalItems = mergeLiveItems(
    existingItems,
    processedChannelNames,
    freshItems,
    runMode.ts
  );

  if (runMode.isTopOfHourWindow) {
    // Top-hour:
    // sort everything globally by latest actualStartTime
    finalItems.sort(compareLiveRecency);
  } else {
    // Main-only run:
    // sort only main channel items by latest actualStartTime
    // keep other channel items unchanged after that
    const mainItems = finalItems
      .filter((item) => item.channelName === mainChannel.title)
      .sort(compareLiveRecency);

    const otherItems = finalItems.filter(
      (item) => item.channelName !== mainChannel.title
    );

    finalItems = [...mainItems, ...otherItems];
  }

  await ref.set(
    {
      updatedAt: runMode.ts,
      items: finalItems,
    },
    { merge: true }
  );

  console.log(
    `[ALL_STREAMS] Firestore updated: ${FIRESTORE_COLLECTION}/${FIRESTORE_DOC_ID}`
  );
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