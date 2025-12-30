// extract_channel_ids_title.js (Node 18+)
// Run: YT_API_KEY=xxxxx node extract_channel_ids_title.js

import fs from "fs/promises";
import 'dotenv/config';


const YT_API_KEY = process.env.YT_API_KEY;
if (!YT_API_KEY) {
  console.error("❌ Missing YT_API_KEY environment variable");
  process.exit(1);
}

const INPUT_PATH = "../json/livenews.json";
const OUTPUT_PATH = "../json/channelids.json";

async function ytGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`YouTube API ${res.status}: ${text}`);
  }
  return res.json();
}

async function getChannelIdFromVideoId(videoId) {
  const url =
    "https://www.googleapis.com/youtube/v3/videos" +
    `?part=snippet&id=${encodeURIComponent(videoId)}` +
    `&key=${encodeURIComponent(YT_API_KEY)}`;

  const data = await ytGet(url);
  return data.items?.[0]?.snippet?.channelId || null;
}

const raw = await fs.readFile(INPUT_PATH, "utf-8");
const list = JSON.parse(raw);

const out = [];

for (const item of list) {
  // ✅ Skip m3u8 or any item with url (you said: "if it has url dont fetch that")
  if (item.url) continue;

  // ✅ Only items that contain YouTube video id
  if (!item.id) continue;

  try {
    const channelId = await getChannelIdFromVideoId(item.id);
    if (!channelId) {
      console.log(`⚠️ No channelId for "${item.title}" (videoId=${item.id})`);
      continue;
    }

    out.push({
      title: item.title || "",
      youtubeChannelId: channelId,
    });

    console.log(`✅ ${item.title} -> ${channelId}`);
  } catch (e) {
    console.log(`❌ Failed "${item.title}": ${e.message}`);
  }
}

await fs.writeFile(OUTPUT_PATH, JSON.stringify(out, null, 2), "utf-8");
console.log(`\n✅ Saved: ${OUTPUT_PATH}`);
