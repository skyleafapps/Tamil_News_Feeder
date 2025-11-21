import 'dotenv/config';
import Parser from 'rss-parser';
import admin from 'firebase-admin';
import crypto from 'crypto';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ---- Firebase init (load from .env) ----
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

const TOPIC = 'breaking_top_video'; // FCM topic name

// Map feed URLs → sources
const feedSources = {
 'https://www.puthiyathalaimurai.com/feed': 'Puthiya Thalaimurai',
  'https://beta.dinamani.com/api/v1/collections/latest-news.rss': 'Dinamani',
  'https://zeenews.india.com/tamil/tamil-nadu.xml': 'Zee Tamil',

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
    console.log(`🌐 Fetching image for article: ${url}`);
    const res = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    const $ = cheerio.load(html);
    return $('meta[property="og:image"]').attr('content') || '';
  } catch (err) {
    console.error(`⚠️ Failed to fetch article image: ${url}`, err.message || err);
    return '';
  }
}

// ---- RSS fetcher ----
async function fetchArticlesFromFeeds(feedUrls) {
  const parser = new Parser({
    customFields: { item: ['enclosure', 'media:content', 'content:encoded'] },
    requestOptions: { headers: { 'User-Agent': 'Mozilla/5.0' } },
  });

  const feeds = await Promise.all(
    feedUrls.map(async (url) => {
      console.log(`🔎 Fetching RSS feed: ${url}`);
      try {
        const f = await parser.parseURL(url);
        console.log(`✅ Success: ${url} -> ${f.items?.length || 0} items`);
        return { f, url };
      } catch (err) {
        console.error(`❌ Failed to fetch ${url}:`, err.message || err);
        return { f: { items: [] }, url };
      }
    })
  );

  const items = feeds.flatMap(({ f, url }) =>
    (f.items || []).map((item) => ({ ...item, _feedUrl: url }))
  );

  const mapped = await Promise.all(
    items.map(async (item) => {
      try {
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        const enclosureUrl = item.enclosure?.url || '';
        const mediaContent = item['media:content']?.url || '';
        let imageUrl = enclosureUrl || mediaContent;
        if (!imageUrl && item.link) {
          imageUrl = await getArticleImage(item.link);
        }

        return {
          title: item.title || '',
          description: item.contentSnippet || '',
          url: item.link || '',
          image: imageUrl || '',
          type: 'article',
          source: feedSources[item._feedUrl] || 'Unknown',
          timestamp: pubDate,
        };
      } catch (err) {
        console.error(`⚠️ Error processing article from ${item._feedUrl}:`, err.message || err);
        return null;
      }
    })
  );

  const validItems = mapped.filter(Boolean);
  console.log(`📊 Total articles processed: ${validItems.length}`);

  // Keep only latest 20
  return validItems
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);
}

// ---- YouTube fetcher ----
async function getLatestVideos(channelId) {
  const activitiesUrl = `https://www.googleapis.com/youtube/v3/activities?part=snippet,contentDetails&channelId=${channelId}&maxResults=3&key=${YT_API_KEY}`;
  console.log(`🔎 Fetching latest activities from: ${activitiesUrl}`);

  try {
    const res = await fetchWithTimeout(activitiesUrl);
    const data = await res.json();

    if (!data.items || !data.items.length) {
      console.log(`⚠️ No activity found for channel ${channelId}`);
      return [];
    }

    const videoIds = data.items
      .map((a) => a.contentDetails?.upload?.videoId)
      .filter(Boolean);

    if (!videoIds.length) {
      console.log(`⚠️ No upload videos found in activities for ${channelId}`);
      return [];
    }

    const videosUrl = `https://www.googleapis.com/youtube/v3/videos?key=${YT_API_KEY}&id=${videoIds.join(
      ','
    )}&part=snippet,statistics`;
    const videosRes = await fetchWithTimeout(videosUrl);
    const videosData = await videosRes.json();

    if (!videosData.items || !videosData.items.length) {
      console.log(`⚠️ No details found for videos: ${videoIds}`);
      return [];
    }

    return videosData.items.map((v) => ({
      videoId: v.id,
      title: v.snippet.title,
      description: v.snippet.description,
      image:
        v.snippet.thumbnails?.high?.url ||
        v.snippet.thumbnails?.medium?.url ||
        v.snippet.thumbnails?.default?.url,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      type: 'video',
      source: v.snippet.channelTitle || 'YouTube',
      timestamp: new Date(v.snippet.publishedAt),
      views: parseInt(v.statistics?.viewCount || '0', 10),
    }));
  } catch (err) {
    console.error(`❌ Error fetching videos for channel ${channelId}:`, err.message || err);
    return [];
  }
}

async function fetchVideosForChannels(channelIds) {
  let videos = [];
  for (const ch of channelIds) {
    const latest = await getLatestVideos(ch);
    videos = videos.concat(latest);
  }

  console.log('🎥 Videos fetched:');
  videos.forEach((v) => console.log(`- "${v.title}" [${v.videoId}] Views: ${v.views}`));

  // Sort and keep latest 20
  return videos
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 20);
}

// ---- Notification sender ----
async function sendTopVideoIfNeeded(videos) {
  if (!videos || videos.length === 0) return;

  const top = videos.sort((a, b) => (b.views || 0) - (a.views || 0))[0];
  if (!top) return;

  const lastRef = db.collection('notifications').doc('last_notified');
  const lastDoc = await lastRef.get();
  const lastVideoId = lastDoc.exists ? lastDoc.data()?.videoId : null;
  if (lastVideoId && lastVideoId === top.videoId) {
    console.log(`⚠️ Already notified for ${top.videoId}, skipping`);
    return;
  }

  const message = {
    topic: TOPIC,
    data: {
      type: 'breaking',
      videoId: top.videoId || '',
      title: top.title || '',
      image: top.image || '',
      url: top.url || '',
      source: top.source || '',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    },
    notification: {
      title: top.title || 'Breaking News',
      body: top.source ? `From ${top.source}` : 'Tap to watch',
      image: top.image || '',
    },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'breaking_channel' } },
    apns: { payload: { aps: { sound: 'default', category: 'TOP_VIDEO' } } },
  };

  console.log('🚀 Sending FCM message:');
  console.log(JSON.stringify(message, null, 2));

  await admin.messaging().send(message);
  console.log(`📢 Sent notification for top video: ${top.title}`);

  await lastRef.set({
    videoId: top.videoId,
    title: top.title,
    notifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ---- Main Update ----
async function updateBreakingFeed() {
  console.log('Fetching articles...');
  const articles = await fetchArticlesFromFeeds(feedUrls);
  console.log(`📰 Articles fetched: ${articles.length}`);

  console.log('Fetching videos...');
  const videos = await fetchVideosForChannels(CHANNEL_IDS);
  console.log(`🎬 Videos fetched total: ${videos.length}`);

  // Merge and sort
  const combined = [...articles, ...videos]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 40); // keep total max 40 (20 each type combined)

  // 🔹 Transform to simple array (no hash IDs)
  const items = combined.map((item) => {
    const base = {
      title: item.title,
      description: item.description || '',
      url: item.url,
      image: item.image,
      type: item.type,
      source: item.source || 'Unknown',
      timestamp: item.timestamp instanceof Date ? item.timestamp : new Date(item.timestamp),
    };
    if (item.type === 'video') {
      base.videoId = item.videoId;
      base.views = item.views || 0;
    }
    return base;
  });

  // 🔹 Store in single Firestore doc: breaking_news/list
  await db.collection('breaking_news').doc('list').set({ items });

  console.log(`✅ Uploaded ${items.length} items to breaking_news/list`);
  await sendTopVideoIfNeeded(videos);
}

updateBreakingFeed().then(() => process.exit());
