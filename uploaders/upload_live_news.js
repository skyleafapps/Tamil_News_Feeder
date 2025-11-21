import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';

// 🔹 Load Firebase credentials
let raw = process.env.FIREBASE_KEY;
if (!raw) {
  console.error('❌ Missing FIREBASE_KEY in .env');
  process.exit(1);
}
if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
const serviceAccount = JSON.parse(raw);

// 🔹 Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const FILE_PATH = '../json/livenews.json'; // your JSON file

async function uploadLiveTV() {
  const tvList = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));

  // Clean & normalize
  const cleanList = tvList.map((ch) => {
    const obj = {
      title: ch.title || ch.name || 'Untitled Channel',
      image: ch.img || ch.image || '',
    };
    if (ch.id && ch.id.trim() !== '') obj.id = ch.id;
    if (ch.url && ch.url.trim() !== '') obj.url = ch.url;
    return obj;
  });

  // 🔹 Read existing version or default to 0
  const docRef = db.collection('channels').doc('list');
  const snapshot = await docRef.get();

  let currentVersion = 0;
  if (snapshot.exists && snapshot.data().version) {
    currentVersion = snapshot.data().version;
  }

  const newVersion = currentVersion + 1;

  // 🔹 Upload with version
  await docRef.set({
    version: newVersion,
    items: cleanList,
  });

  console.log(`🚀 Live News Updated`);
  console.log(`➡️ Old Version: ${currentVersion}`);
  console.log(`➡️ New Version: ${newVersion}`);
  console.log(`📡 Uploaded ${cleanList.length} channels`);
}

uploadLiveTV().catch(console.error);
