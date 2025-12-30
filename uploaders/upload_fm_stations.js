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

// 🔹 Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const FILE_PATH = '../json/fm.json'; // your FM list file

async function uploadFmStations() {
  const fmStations = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));

  const docRef = db.collection('fm').doc('list');

  // 🔥 Get existing version
  const snap = await docRef.get();
  let version = 1;

  if (snap.exists && snap.data()?.version !== undefined) {
    version = snap.data().version + 1; // increment version
  }

  // 🔥 Upload updated stations + version
  await docRef.set({
    version,
    items: fmStations.map((f) => ({
      title: f.name || 'Untitled Station',
      url: f.streamUrl || '',
      img: f.logo || '',
    })),
  });

  console.log(
    `✅ Uploaded ${fmStations.length} FM stations to fmstations/list (version ${version})`
  );
}

uploadFmStations().catch(console.error);
