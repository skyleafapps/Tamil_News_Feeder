import 'dotenv/config';
import admin from 'firebase-admin';
import fs from 'fs';

// Load Firebase service account from FIREBASE_KEY
let raw = process.env.FIREBASE_KEY;
if (!raw) {
  console.error('❌ Missing FIREBASE_KEY');
  process.exit(1);
}
if (!raw.trim().startsWith('{')) {
  raw = Buffer.from(raw, 'base64').toString('utf8');
}
const serviceAccount = JSON.parse(raw);

// Initialize Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const FILE_PATH = '../json/newspaper.json';

// 🔥 Auto–increment version
async function getNextVersion() {
  const versionDoc = db.collection('newspapers').doc('version');
  const snap = await versionDoc.get();

  let newVersion = 1;

  if (snap.exists && snap.data()?.version) {
    newVersion = snap.data().version + 1;
  }

  await versionDoc.set({ version: newVersion });
  return newVersion;
}

async function uploadArrayDoc() {
  const newspapers = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));

  // 🔥 Get next version number
  const version = await getNextVersion();

  // 🔥 Upload newspapers to newspapers/list
  await db.collection('newspapers').doc('list').set({
    version, // ← added here
    items: newspapers.map((n, i) => ({
      title: n.title || n.name || 'Untitled',
      url: n.url || '',
      image: n.image || '',
      order: i,
      lang: 'ml',
    })),
  });

  console.log(`✅ Uploaded ${newspapers.length} newspapers with version ${version}`);
}

uploadArrayDoc().catch(console.error);
