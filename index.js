import 'dotenv/config';
import Parser from 'rss-parser';
import admin from 'firebase-admin';
import crypto from 'crypto';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ---- Firebase init ----
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ---- Config ----
const YT_API_KEY = process.env.YT_API_KEY;
const CHANNEL_IDS = (process.env.CHANNEL_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const TOPIC = 'breaking_top_video';

// ---- RSS Feeds ----
const feedSources = {
  'https://www.puthiyathalaimurai.com/feed': 'Puthiya Thalaimurai',
  'https://zeenews.india.com/tamil/tamil-nadu.xml': 'Zee Tamil',
  'https://www.vikatan.com/api/v1/collections/kollywood-entertainment.rss?&time-period=last-24-hours':
    'Vikatan Cinema',
  'https://www.vikatan.com/api/v1/collections/automobile.rss?&time-period=last-24-hours':
    'Vikatan Automobile',

};

const feedUrls = Object.keys(feedSources);

// ---- Helpers ----
async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function getArticleImage(url) {
  try {
    const res = await fetchWithTimeout(
      url,
      { headers: { 'User-Agent': 'Mozilla/5.0' } },
      8000
    );
    const html = await res.text();
    const $ = cheerio.load(html);
    return (
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      ''
    );
  } catch {
    return '';
  }
}

// ---- RSS Fetcher (debug kept as requested) ----
async function fetchArticlesFromFeeds(feedUrls) {
  console.log('------------------------------------------------------------');
  console.log('📡 Fetching RSS Feeds (taking top 30 per feed URL)...');
  console.log('------------------------------------------------------------');

  const parser = new Parser({
    customFields: { item: ['enclosure', 'media:content', 'content:encoded'] },
    requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } },
  });

  const feeds = await Promise.all(
    feedUrls.map(async (url) => {
      try {
        const f = await parser.parseURL(url);
        console.log(
          `✔ RSS Loaded: ${feedSources[url]} (${url}) — ${
            f.items?.length || 0
          } items`
        );
        return { f, url, ok: true };
      } catch (err) {
        console.log(
          `❌ RSS Failed: ${feedSources[url]} (${url}) — ${
            err.message || 'fetch error'
          }`
        );
        return { f: { items: [] }, url, ok: false };
      }
    })
  );

  const perFeedUsedCounts = {};
  const items = feeds.flatMap(({ f, url }) => {
    const all = (f.items || []).slice();
    all.sort(
      (a, b) =>
        new Date(b.pubDate || b.isoDate || Date.now()) -
        new Date(a.pubDate || a.isoDate || Date.now())
    );
    const used = all.slice(0, 30);
    perFeedUsedCounts[url] = {
      original: (f.items || []).length,
      used: used.length,
      sourceName: feedSources[url] || 'Unknown',
    };
    return used.map((item) => ({ ...item, _feedUrl: url }));
  });

  const mapped = await Promise.all(
    items.map(async (item) => {
      try {
        const pubDate = item.pubDate
          ? new Date(item.pubDate)
          : item.isoDate
          ? new Date(item.isoDate)
          : new Date();

        let imageUrl =
          item.enclosure?.url ||
          item['media:content']?.url ||
          (item.link ? await getArticleImage(item.link) : '');

        return {
          title: item.title || '',
          description: item.contentSnippet || item.content || '',
          url: item.link || item.id || '',
          image: imageUrl || '',
          type: 'article',
          source: feedSources[item._feedUrl] || 'Unknown',
          timestamp: pubDate,
        };
      } catch {
        return null;
      }
    })
  );

  const validItems = mapped.filter(Boolean);

  console.log('\n📝 ITEM COUNT PER FEED URL (original -> used):');
  console.log('------------------------------------------------------------');
  Object.entries(perFeedUsedCounts).forEach(([url, info]) => {
    console.log(
      `${(info.sourceName + ' ').padEnd(20)} ${url} => ${
        info.original
      } -> ${info.used}`
    );
  });
  console.log('------------------------------------------------------------');
  console.log(
    `📦 Total RSS Articles Used (sum of per-feed top30): ${validItems.length}\n`
  );

  return validItems;
}

// --------------------------------------------------
// 🔥 CLEAN YOUTUBE FETCH (minimal debug only)
// --------------------------------------------------
async function getLatestVideos(channelId) {
  console.log(`📺 Fetching YouTube for channel: ${channelId}`);

  const activitiesUrl = `https://www.googleapis.com/youtube/v3/activities?part=snippet,contentDetails&channelId=${channelId}&maxResults=3&key=${YT_API_KEY}`;

  try {
    const res = await fetchWithTimeout(activitiesUrl, {}, 8000);
    const data = await res.json();

    const videoIds = (data.items || [])
      .map((a) => a.contentDetails?.upload?.videoId)
      .filter(Boolean);

    console.log(`➡️ Found ${videoIds.length} video IDs`);

    if (!videoIds.length) return [];

    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?key=${YT_API_KEY}&id=${videoIds.join(
      ','
    )}&part=snippet,statistics`;

    const videosRes = await fetchWithTimeout(videosUrl, {}, 8000);
    const videosData = await videosRes.json();

    const result = (videosData.items || []).map((v) => ({
      videoId: v.id,
      title: v.snippet.title,
      description: v.snippet.description,
      image:
        v.snippet.thumbnails?.high?.url ||
        v.snippet.thumbnails?.medium?.url ||
        v.snippet.thumbnails?.default?.url ||
        '',
      url: `https://www.youtube.com/watch?v=${v.id}`,
      type: 'video',
      source: v.snippet.channelTitle || 'YouTube',
      timestamp: new Date(v.snippet.publishedAt),
      views: parseInt(v.statistics?.viewCount || '0', 10),
    }));

    console.log(`✔️ Channel videos parsed: ${result.length}`);
    return result;
  } catch (err) {
    console.log(`❌ YouTube error: ${err.message}`);
    return [];
  }
}

async function fetchVideosForChannels(channelIds) {
  let videos = [];
  for (const ch of channelIds) {
    const latest = await getLatestVideos(ch);
    videos = videos.concat(latest);
  }
  console.log(`🎥 TOTAL Videos from ALL channels: ${videos.length}\n`);

  return videos
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);
}

// ---- Notification sender ----
async function sendTopVideoIfNeeded(videos) {
  console.log('\n🔔 Checking notification logic...');
  console.log(`🎥 Videos available: ${videos.length}`);

  if (!videos.length) {
    console.log('❌ No videos → Notification skipped');
    return;
  }

  const top = videos.sort((a, b) => b.views - a.views)[0];
  console.log(`🔥 Selected top video: ${top.videoId} (${top.views} views)`);

  const lastRef = db.collection('notifications').doc('last_notified');
  const lastDoc = await lastRef.get();
  const lastVideoId = lastDoc.exists ? lastDoc.data().videoId : null;

  if (lastVideoId === top.videoId) {
    console.log('⚠️ Already notified for this video → skipping');
    return;
  }

  const message = {
    topic: TOPIC,
    data: {
      type: 'breaking',
      videoId: top.videoId,
      title: top.title,
      image: top.image,
      url: top.url,
      source: top.source,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    notification: {
      title: top.title,
      body: `From ${top.source}`,
      image: top.image,
    },
  };

  await admin.messaging().send(message);
  console.log('📤 Notification SENT');

  await lastRef.set({
    videoId: top.videoId,
    title: top.title,
    notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log('✔️ Notification record updated\n');
}

// ---- Main Update ----
async function updateBreakingFeed() {
  console.log('Fetching articles...');
  const newArticles = await fetchArticlesFromFeeds(feedUrls);

  console.log('Fetching videos...');
  const newVideos = await fetchVideosForChannels(CHANNEL_IDS);

  console.log('------------------------------------------------------------');
  console.log(`🆕 Articles: ${newArticles.length}`);
  console.log(`🆕 Videos:   ${newVideos.length}`);
  console.log('------------------------------------------------------------');

  let newItems = [...newArticles, ...newVideos];

  newItems = newItems.map((item) => ({
    ...item,
    timestamp:
      item.timestamp instanceof Date ? item.timestamp : new Date(item.timestamp),
  }));

  newItems.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const oldDoc = await db.collection('breaking_news').doc('list').get();
  let oldItems = [];
  if (oldDoc.exists) {
    oldItems = (oldDoc.data().items || []).map((item) => ({
      ...item,
      timestamp:
        item.timestamp instanceof Date
          ? item.timestamp
          : item.timestamp?.toDate
          ? item.timestamp.toDate()
          : new Date(item.timestamp),
    }));
  }

  console.log(`📚 Old items: ${oldItems.length}`);

  let combined = [...newItems, ...oldItems];
  console.log(`🔄 After merge: ${combined.length}`);

  const seen = new Set();
  combined = combined.filter((item) => {
    const key = item.url || item.videoId;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`♻️ After dedupe: ${combined.length}`);

  combined.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  combined = combined.slice(0, 200);

  console.log(`📦 Final stored count: ${combined.length}`);

  await db.collection('breaking_news').doc('list').set({ items: combined });

  console.log('✅ Firestore Updated');

  await sendTopVideoIfNeeded(newVideos);
}

updateBreakingFeed()
  .then(() => process.exit())
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
