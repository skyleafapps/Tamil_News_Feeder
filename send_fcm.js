import 'dotenv/config';
import admin from 'firebase-admin';

// 🔹 Load service account from FIREBASE_KEY env (JSON string or Base64)
let serviceAccount;
try {
  let raw = process.env.FIREBASE_KEY;

  if (!raw) {
    console.error('❌ Missing FIREBASE_KEY in .env');
    process.exit(1);
  }

  // Auto-detect Base64 or raw JSON
  if (!raw.trim().startsWith('{')) {
    raw = Buffer.from(raw, 'base64').toString('utf8');
  }

  serviceAccount = JSON.parse(raw);
} catch (e) {
  console.error('❌ Failed to parse FIREBASE_KEY:', e.message);
  process.exit(1);
}

// 🔹 Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const TOPIC = process.env.FCM_TOPIC || 'breaking_top_video';

async function sendFCM(videoId, title, source, imageUrl, type = 'breaking') {
  if (!videoId) {
    console.error('❌ Missing videoId argument.');
    process.exit(1);
  }

  const message = {
    topic: TOPIC,
    notification: {
      title: title || 'Breaking News',
      body: source ? `From ${source}` : 'Tap to watch',
      image: imageUrl || '',
    },
    data: {
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      type,
      videoId,
      title: title || 'Breaking News',
      image: imageUrl || '',
      source: source || 'YouTube',
      url: `https://www.youtube.com/watch?v=${videoId}`,
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'breaking_channel',
        clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          category: 'TOP_VIDEO',
        },
      },
    },
  };

  console.log('🚀 Sending FCM message...');
  console.log(JSON.stringify(message, null, 2));

  try {
    await admin.messaging().send(message);
    console.log(`✅ Notification sent successfully for videoId: ${videoId}`);
  } catch (err) {
    console.error('❌ Error sending FCM:', err.message || err);
  }
}

// CLI usage
const args = process.argv.slice(2);
const [videoId, title, source, imageUrl] = args;

if (!videoId) {
  console.log(`
Usage:
  node send_fcm.js <videoId> "<title>" "<source>" "<imageUrl>"

Example:
  node send_fcm.js dQw4w9WgXcQ "Live News Update | Republic TV" "Republic TV" "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
`);
  process.exit(0);
}

sendFCM(videoId, title, source, imageUrl);
