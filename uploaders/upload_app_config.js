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
const FILE_PATH = '../json/config.json'; // 👈 path to your JSON file

async function uploadAppConfig() {
  console.log('🚀 Uploading app_config data from config.json...');

  const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));

  if (!data.app_config) {
    console.error('❌ Invalid config.json — expected { "app_config": { ... } }');
    process.exit(1);
  }

  // Loop and upload each document under app_config
  const batch = db.batch();
  const appConfigRef = db.collection('app_config');

  for (const [docId, content] of Object.entries(data.app_config)) {
    batch.set(appConfigRef.doc(docId), content);
    console.log(`📦 Queued document: ${docId}`);
  }

  await batch.commit();
  console.log('✅ Successfully uploaded app_config data.');
}

uploadAppConfig().catch((err) => {
  console.error('❌ Upload failed:', err);
  process.exit(1);
});
