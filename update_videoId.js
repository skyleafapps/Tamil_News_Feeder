// update_videoId.js (Node 18+)
// Run: node update_videoId.js
// It will: load .env -> update channelids.json -> patch livenews.json -> run uploader to push Firestore

import fs from "fs/promises";
import { config as dotenvConfig } from "dotenv";
import { spawn } from "child_process";

// 0) Load .env from project root
dotenvConfig();

const YT_API_KEY = process.env.YT_API_KEY;
if (!YT_API_KEY) {
  console.error("❌ Missing YT_API_KEY. Put it in .env like: YT_API_KEY=xxxx");
  process.exit(1);
}

// ✅ Since script is in root folder:
const CHANNELS_PATH = "./json/channelids.json"; // [{title,youtubeChannelId,id}] OR {lastRunIST, items:[...]}
const LIVES_PATH = "./json/livenews.json";      // mixed list (m3u8 + youtube)
const OUT_CHANNELS_PATH = "./json/channelids.json";
const OUT_LIVES_PATH = "./json/livenews.json";

// Your existing uploader script
const UPLOADER_SCRIPT = "upload_live_news.js";

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
  const yyyy = get("year");
  const mm = get("month");
  const dd = get("day");
  const hh = get("hour");
  const mi = get("minute");
  const ss = get("second");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} IST`;
}

// ---------- YouTube helpers ----------
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

// ---------- Run another node file (uploader) ----------
function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      // ✅ Run uploader from its own folder so its relative paths work
      cwd: "./uploaders",
      stdio: "inherit",     // show logs in console
      shell: false,
      env: process.env,     // pass env (so uploader can read .env too if needed)
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Uploader exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

// ---------- Main ----------
async function main() {
  const channelsRaw = JSON.parse(await fs.readFile(CHANNELS_PATH, "utf-8"));
  const channels = Array.isArray(channelsRaw) ? channelsRaw : (channelsRaw.items || []);
  const liveNews = JSON.parse(await fs.readFile(LIVES_PATH, "utf-8"));

  const runTimeIST = nowIST();

  // Map by title for fast patching livenews.json
  const mapByTitle = new Map();
  for (const c of channels) {
    if (c?.title) mapByTitle.set(String(c.title).trim(), c);
  }

  let updatedCount = 0;

  // 1) Update channelids.json ids (only if not live)
  for (const ch of channels) {
    const title = String(ch.title || "").trim();
    const channelId = ch.youtubeChannelId;
    const oldVideoId = ch.id;

    if (!title || !channelId) continue;

    // if current id exists and still live -> skip
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

    // not live / no id -> search current live
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

  // 2) Patch livenews.json by title (only youtube items, skip url/m3u8)
  let patched = 0;
  for (const item of liveNews) {
    if (!item?.title) continue;
    if (item.url) continue; // m3u8 -> skip

    const key = String(item.title).trim();
    const ch = mapByTitle.get(key);
    if (!ch) continue;

    if (ch.id && item.id !== ch.id) {
      item.id = ch.id;
      patched++;
    }
  }

  // 3) Save channelids.json with a global lastRunIST wrapper
  const channelsOut = {
    lastRunIST: runTimeIST,
    items: channels,
  };

  await fs.writeFile(OUT_CHANNELS_PATH, JSON.stringify(channelsOut, null, 2), "utf-8");
  await fs.writeFile(OUT_LIVES_PATH, JSON.stringify(liveNews, null, 2), "utf-8");

  console.log("\n✅ UPDATED JSON FILES");
  console.log(`channelids.json updated: ${updatedCount}`);
  console.log(`livenews.json patched:   ${patched}`);
  console.log(`lastRunIST:              ${runTimeIST}`);

  // 4) Run your uploader (push to Firestore) ONLY if something changed
  if (updatedCount > 0 || patched > 0) {
    console.log("\n🚀 Running uploader to push to Firestore...");
    await runNodeScript(UPLOADER_SCRIPT);
    console.log("✅ Firestore upload completed.");
  } else {
    console.log("\n⏭️ No changes detected. Skipping Firestore upload.");
  }
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
