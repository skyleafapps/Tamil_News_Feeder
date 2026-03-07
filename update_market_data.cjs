#!/usr/bin/env node

/**
 * update_market_data.cjs
 *
 * Uses Playwright browser automation to avoid 403 blocks.
 * Fetches:
 * - Gold (Chennai, 22K only)
 * - Silver (Chennai, 1g + 1kg)
 * - Petrol (Chennai only)
 * - Diesel (Chennai only)
 * - Sensex
 * - Nifty
 *
 * Writes one Firestore doc:
 * market_data/summary
 *
 * ENV:
 *   FIREBASE_KEY='{"type":"service_account",...}'
 *
 * Install:
 *   npm install playwright cheerio dotenv firebase-admin
 *   npx playwright install chromium
 *
 * Run:
 *   node update_market_data.cjs
 */

require("dotenv").config();

const cheerio = require("cheerio");
const admin = require("firebase-admin");
const { chromium } = require("playwright");

// --------------------------------------------------
// CONFIG
// --------------------------------------------------

const URLS = {
  gold: "https://www.goodreturns.in/gold-rates/chennai.html",
  silver: "https://www.goodreturns.in/silver-rates/chennai.html",
  petrol: "https://www.goodreturns.in/petrol-price.html",
  diesel: "https://www.goodreturns.in/diesel-price.html",
  bse: "https://www.goodreturns.in/bse/",
  nse: "https://www.goodreturns.in/nse/",
};

const IMAGE_URLS = {
  gold: "https://img.yicaiglobal.com/src/image/2025/09/97951849004741.jpg",
  silver:
    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTq_WAoejl28t83qhuPr6HzcBuCuoQ3NgeZeA&s",
  petrolDiesel:
    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcTekE_MRukk1RoMTAGGdjZzk2jNqipL_yO2uw&s",
  nifty:
    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSZI_tFZGWH0Kqrl0C6ULaQrI_VmBwlI94IRw&s",
  sensex:
    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQjy3nEoun1sL3mYpz5xb06LtMwD_tOYzIQ2Q&s",
};

const FIRESTORE_COLLECTION = "market_data";
const FIRESTORE_DOC = "summary";

// --------------------------------------------------
// FIREBASE INIT
// --------------------------------------------------

function getFirebaseServiceAccount() {
  const raw = process.env.FIREBASE_KEY;
  if (!raw) {
    throw new Error("Missing FIREBASE_KEY in .env");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "FIREBASE_KEY is not valid JSON. Put full service account JSON as a single-line string in .env"
    );
  }

  if (parsed.private_key) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
  }

  return parsed;
}

function initFirebase() {
  if (admin.apps.length > 0) return admin.app();

  const serviceAccount = getFirebaseServiceAccount();

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

// --------------------------------------------------
// FIRESTORE HELPERS
// --------------------------------------------------

async function loadExistingFirestoreData() {
  initFirebase();
  const db = admin.firestore();
  const snap = await db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).get();

  if (!snap.exists || !snap.data()) {
    return null;
  }

  return snap.data();
}

// --------------------------------------------------
// BROWSER FETCH
// --------------------------------------------------

async function fetchHtmlWithBrowser(page, url) {
  console.log(`[INFO] Opening: ${url}`);

  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const status = response ? response.status() : "no-response";
  console.log(`[INFO] Status ${status} for ${url}`);

  if (!response || !response.ok()) {
    throw new Error(`HTTP ${status} for ${url}`);
  }

  await page.waitForTimeout(2500);

  const html = await page.content();

  if (!html || html.length < 1000) {
    throw new Error(`Empty or too-small HTML for ${url}`);
  }

  return html;
}

async function createBrowserPage(browser) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    locale: "en-IN",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "en-IN,en;q=0.9",
      Referer: "https://www.goodreturns.in/",
    },
  });

  const page = await context.newPage();
  return { context, page };
}

async function fetchHtmlForUrl(browser, url) {
  const pageSet = await createBrowserPage(browser);
  try {
    return await fetchHtmlWithBrowser(pageSet.page, url);
  } finally {
    await pageSet.context.close();
  }
}

// --------------------------------------------------
// HTML / TEXT HELPERS
// --------------------------------------------------

function htmlToText(html) {
  const $ = cheerio.load(html);
  const text = $("body").text();
  return normalizeWhitespace(text);
}

function normalizeWhitespace(str) {
  return String(str || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseNumber(input) {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[^0-9.\-+]/g, "");
  if (!cleaned || cleaned === "+" || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseSignedNumber(input) {
  if (input === null || input === undefined) return null;
  const cleaned = String(input).replace(/[^0-9.\-+]/g, "");
  if (!cleaned || cleaned === "+" || cleaned === "-" || cleaned === ".") {
    return null;
  }
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function getChangeType(change) {
  if (typeof change !== "number" || Number.isNaN(change)) return "flat";
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

function nowIso() {
  return new Date().toISOString();
}

function nowEpoch() {
  return Date.now();
}

function tryPatterns(text, patterns, label) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match;
  }
  throw new Error(`Could not parse ${label}`);
}

function toNegativeIfUnsigned(rawMatchValue, numericValue) {
  if (numericValue === null) return null;
  const raw = String(rawMatchValue || "");
  if (!raw.includes("+") && !raw.includes("-")) {
    return -Math.abs(numericValue);
  }
  return numericValue;
}

// --------------------------------------------------
// PARSERS
// --------------------------------------------------

function parseGold22(html) {
  const text = htmlToText(html);

  const match = tryPatterns(
    text,
    [
      /22K\s*Gold\s*\/g\s*₹\s*([\d,]+(?:\.\d+)?)\s*-\s*₹\s*([\d,]+(?:\.\d+)?)/i,
      /22\s*K\s*Gold\s*\/g\s*₹\s*([\d,]+(?:\.\d+)?)\s*([+\-]\s*₹?\s*[\d,]+(?:\.\d+)?)/i,
      /22\s*Carat\s*Gold.*?₹\s*([\d,]+(?:\.\d+)?).*?([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i,
      /Today\s*22\s*Carat\s*Gold\s*Price\s*Per\s*Gram\s*in\s*Chennai.*?1\s*₹\s*([\d,]+(?:\.\d+)?).*?([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i,
      /22\s*Carat\s*Gold\s*Rate\s*In\s*Chennai.*?₹\s*([\d,]+(?:\.\d+)?).*?([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i,
    ],
    "gold 22K Chennai"
  );

  const value = parseNumber(match[1]);
  let change = parseSignedNumber(match[2]);
  change = toNegativeIfUnsigned(match[2], change);

  if (value === null || change === null) {
    throw new Error("Parsed gold values are invalid");
  }

  return {
    label: "Gold",
    city: "Chennai",
    type: "22K",
    value,
    unit: "₹/g",
    change,
    changeType: getChangeType(change),
    iconUrl: IMAGE_URLS.gold,
    sourceUrl: URLS.gold,
  };
}

function parseSilver(html) {
  const text = htmlToText(html);

  const match1g = tryPatterns(
    text,
    [
      /Silver\s*\/g\s*₹\s*([\d,]+(?:\.\d+)?)\s*-\s*₹\s*([\d,]+(?:\.\d+)?)/i,
      /1\s+₹\s*([\d,]+(?:\.\d+)?)\s+₹\s*[\d,]+(?:\.\d+)?\s*-\s*₹\s*([\d,]+(?:\.\d+)?)/i,
      /The price of silver in Chennai today is ₹\s*([\d,]+(?:\.\d+)?)\s*per gram/i,
      /1\s*Gram\s*Silver\s*Rate\s*In\s*Chennai.*?₹\s*([\d,]+(?:\.\d+)?).*?([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i,
    ],
    "silver 1g Chennai"
  );

  const match1kg = tryPatterns(
    text,
    [
      /Silver\s*\/kg\s*₹\s*([\d,]+(?:\.\d+)?)\s*-\s*₹\s*([\d,]+(?:\.\d+)?)/i,
      /1000\s+₹\s*([\d,]+(?:\.\d+)?)\s+₹\s*[\d,]+(?:\.\d+)?\s*-\s*₹\s*([\d,]+(?:\.\d+)?)/i,
      /and ₹\s*([\d,]+(?:\.\d+)?)\s*per kilogram/i,
      /1\s*Kg\s*Silver\s*Rate\s*In\s*Chennai.*?₹\s*([\d,]+(?:\.\d+)?).*?([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i,
    ],
    "silver 1kg Chennai"
  );

  const value1g = parseNumber(match1g[1]);
  const value1kg = parseNumber(match1kg[1]);

  let change1g = null;
  let change1kg = null;

  if (match1g[2]) {
    change1g = parseNumber(match1g[2]);
    change1g = -Math.abs(change1g);
  }

  if (match1kg[2]) {
    change1kg = parseNumber(match1kg[2]);
    change1kg = -Math.abs(change1kg);
  }

  if (value1g === null || value1kg === null) {
    throw new Error("Parsed silver values are invalid");
  }

  if (change1g === null) {
    const row1g = text.match(
      /1\s+₹\s*[\d,]+(?:\.\d+)?\s+₹\s*[\d,]+(?:\.\d+)?\s*([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i
    );
    if (row1g && row1g[1]) {
      const n = parseSignedNumber(row1g[1]);
      change1g = n !== null ? toNegativeIfUnsigned(row1g[1], n) : null;
    }
  }

  if (change1kg === null) {
    const row1kg = text.match(
      /1000\s+₹\s*[\d,]+(?:\.\d+)?\s+₹\s*[\d,]+(?:\.\d+)?\s*([+\-]?\s*₹?\s*[\d,]+(?:\.\d+)?)/i
    );
    if (row1kg && row1kg[1]) {
      const n = parseSignedNumber(row1kg[1]);
      change1kg = n !== null ? toNegativeIfUnsigned(row1kg[1], n) : null;
    }
  }

  if (change1g === null || change1kg === null) {
    throw new Error("Parsed silver change values are invalid");
  }

  return {
    label: "Silver",
    city: "Chennai",
    value1g,
    unit1g: "₹/g",
    change1g,
    value1kg,
    unit1kg: "₹/kg",
    change1kg,
    changeType: getChangeType(change1g),
    iconUrl: IMAGE_URLS.silver,
    sourceUrl: URLS.silver,
  };
}

function parseFuelByCity(html, label, cityName, sourceUrl) {
  const text = htmlToText(html);

  const match = tryPatterns(
    text,
    [
      new RegExp(
        `${cityName}\\s*₹?\\s*([\\d,.]+(?:\\.\\d+)?)\\s*([+\\-]\\s*[\\d,.]+(?:\\.\\d+)?)`,
        "i"
      ),
      new RegExp(
        `${cityName}.*?₹\\s*([\\d,.]+(?:\\.\\d+)?).*?([+\\-]\\s*[\\d,.]+(?:\\.\\d+)?)`,
        "i"
      ),
      new RegExp(
        `${cityName}[^\\d]+([\\d,.]+(?:\\.\\d+)?)[^+\\-]*([+\\-]\\s*[\\d,.]+(?:\\.\\d+)?)`,
        "i"
      ),
    ],
    `${label} ${cityName}`
  );

  const value = parseNumber(match[1]);
  const change = parseSignedNumber(match[2]);

  if (value === null || change === null) {
    throw new Error(`Parsed ${label} values are invalid`);
  }

  return {
    label,
    city: cityName,
    value,
    unit: "₹/L",
    change,
    changeType: getChangeType(change),
    iconUrl: IMAGE_URLS.petrolDiesel,
    sourceUrl,
  };
}

function parseIndex(html, indexLabel, sourceUrl) {
  const text = htmlToText(html);

  const match = tryPatterns(
    text,
    [
      new RegExp(
        `${indexLabel}.*?Last Updated:.*?Live\\s*([\\d,]+(?:\\.\\d+)?)\\s*([+\\-][\\d,]+(?:\\.\\d+)?)\\s*\\(([+\\-]\\d+(?:\\.\\d+)?)%\\)`,
        "i"
      ),
      new RegExp(
        `#\\s*.*?${indexLabel}.*?Last Updated:.*?Live\\s*([\\d,]+(?:\\.\\d+)?)\\s*([+\\-][\\d,]+(?:\\.\\d+)?)\\s*\\(([+\\-]\\d+(?:\\.\\d+)?)%\\)`,
        "i"
      ),
      new RegExp(
        `${indexLabel}.*?([\\d,]+(?:\\.\\d+)?)\\s*([+\\-][\\d,]+(?:\\.\\d+)?)\\s*\\(([+\\-]\\d+(?:\\.\\d+)?)%\\)`,
        "i"
      ),
      new RegExp(
        `Live\\s*([\\d,]+(?:\\.\\d+)?)\\s*([+\\-][\\d,]+(?:\\.\\d+)?)\\s*\\(([+\\-]\\d+(?:\\.\\d+)?)%\\)`,
        "i"
      ),
    ],
    indexLabel
  );

  const value = parseNumber(match[1]);
  const change = parseSignedNumber(match[2]);
  const changePercent = parseSignedNumber(match[3]);

  if (value === null || change === null || changePercent === null) {
    throw new Error(`Parsed ${indexLabel} values are invalid`);
  }

  return {
    label: indexLabel,
    value,
    change,
    changePercent,
    changeType: getChangeType(change),
    iconUrl:
      indexLabel.toLowerCase() === "sensex"
        ? IMAGE_URLS.sensex
        : IMAGE_URLS.nifty,
    sourceUrl,
  };
}

// --------------------------------------------------
// SAFE SCRAPE HELPERS
// --------------------------------------------------

function getExistingItem(existingData, key) {
  return existingData?.items?.[key] || null;
}

async function safeFetchAndParse({
  browser,
  key,
  url,
  parseFn,
  existingData,
  errors,
}) {
  try {
    const html = await fetchHtmlForUrl(browser, url);
    const parsed = parseFn(html);
    console.log(`[OK] Parsed ${key}`);
    return parsed;
  } catch (error) {
    const fallback = getExistingItem(existingData, key);
    const message = `${key}: ${error?.message || error}`;
    errors.push(message);

    if (fallback) {
      console.warn(`[WARN] ${message} -> using previous Firestore value`);
      return fallback;
    }

    console.warn(`[WARN] ${message} -> no previous Firestore fallback available`);
    return null;
  }
}

// --------------------------------------------------
// MAIN SCRAPE
// --------------------------------------------------

async function scrapeAll(existingData) {
  console.log("[INFO] Launching browser...");

  const browser = await chromium.launch({
    headless: true,
  });

  const errors = [];

  try {
    const gold = await safeFetchAndParse({
      browser,
      key: "gold",
      url: URLS.gold,
      parseFn: parseGold22,
      existingData,
      errors,
    });

    const silver = await safeFetchAndParse({
      browser,
      key: "silver",
      url: URLS.silver,
      parseFn: parseSilver,
      existingData,
      errors,
    });

    const petrol = await safeFetchAndParse({
      browser,
      key: "petrol",
      url: URLS.petrol,
      parseFn: (html) => parseFuelByCity(html, "Petrol", "Chennai", URLS.petrol),
      existingData,
      errors,
    });

    const diesel = await safeFetchAndParse({
      browser,
      key: "diesel",
      url: URLS.diesel,
      parseFn: (html) => parseFuelByCity(html, "Diesel", "Chennai", URLS.diesel),
      existingData,
      errors,
    });

    const sensex = await safeFetchAndParse({
      browser,
      key: "sensex",
      url: URLS.bse,
      parseFn: (html) => parseIndex(html, "Sensex", URLS.bse),
      existingData,
      errors,
    });

    const nifty = await safeFetchAndParse({
      browser,
      key: "nifty",
      url: URLS.nse,
      parseFn: (html) => parseIndex(html, "Nifty", URLS.nse),
      existingData,
      errors,
    });

    const items = {
      gold,
      silver,
      petrol,
      diesel,
      sensex,
      nifty,
    };

    const usableItemCount = Object.values(items).filter(Boolean).length;

    if (usableItemCount === 0) {
      throw new Error("All item scrapes failed and no fallback data was available");
    }

    return {
      source: "goodreturns",
      city: "Chennai",
      status: errors.length === 0 ? "success" : "partial_success",
      updatedAt: nowIso(),
      updatedAtEpoch: nowEpoch(),
      items,
      errors,
    };
  } finally {
    await browser.close();
  }
}

// --------------------------------------------------
// FIRESTORE WRITE
// --------------------------------------------------

async function saveToFirestore(data) {
  initFirebase();
  const db = admin.firestore();

  await db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).set(data, {
    merge: true,
  });

  console.log(
    `[OK] Firestore updated: ${FIRESTORE_COLLECTION}/${FIRESTORE_DOC}`
  );
}

// --------------------------------------------------
// RUNNER
// --------------------------------------------------

async function main() {
  console.log("[INFO] Market data update started");

  try {
    const existingData = await loadExistingFirestoreData();
    if (existingData) {
      console.log("[INFO] Loaded previous Firestore document for fallback");
    } else {
      console.log("[INFO] No previous Firestore document found");
    }

    const payload = await scrapeAll(existingData);

    console.log("[INFO] Final payload:");
    console.log(JSON.stringify(payload, null, 2));

    await saveToFirestore(payload);

    console.log("[SUCCESS] Market data update completed");
    process.exit(0);
  } catch (error) {
    console.error("[ERROR] Market data update failed");
    console.error(error?.message || error);
    if (error?.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();