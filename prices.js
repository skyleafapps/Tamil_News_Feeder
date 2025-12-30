// prices.js (Node 18+ / ESM)
import * as cheerio from "cheerio";

// ─────────────────────────────────────────────
// URLs
// ─────────────────────────────────────────────
const GOLD_URLS = [
  "https://www.tanishq.co.in/shop/gold-rate?lang=en",
  "https://www.tanishq.co.in/gold-rate.html?lang=en_IN",
];

const SILVER_URL =
  "https://www.thehindubusinessline.com/silver-rate-today/Chennai/";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const toINR = (s) => {
  const n = String(s).replace(/[^\d]/g, "");
  return n ? Number(n) : null;
};

const toSignedInt = (s) => {
  const cleaned = String(s).replace(/[^\d\-]/g, "");
  return cleaned ? Number(cleaned) : null;
};

function percentFrom(rate, base) {
  if (rate == null || base == null || base === 0) return null;
  return Number(((rate / base) * 100).toFixed(2));
}

async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-IN,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
      ...extraHeaders,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    err.bodySnippet = body.slice(0, 200);
    throw err;
  }
  return await res.text();
}

// ─────────────────────────────────────────────
// GOLD (Tanishq)
// ─────────────────────────────────────────────
function extractGoldRow($, tr) {
  const $tr = $(tr);
  const gramsText = $tr.find("td").eq(0).text().replace(/\s+/g, " ").trim(); // "10 G"
  const grams = Number(gramsText.replace(/[^\d]/g, ""));

  const $today = $tr.find("td").eq(1);

  const todayPrice = toINR(
    $today.clone().find(".pricechange-value").remove().end().text()
  );

  const todayChangeRate = toSignedInt(
    $today.find(".difference-rate").first().text()
  );

  const todayChangePct = Number(
    String($today.find(".difference-percentage").first().text())
      .replace(/[()%\s]/g, "")
      .trim()
  );
  const pct = Number.isFinite(todayChangePct) ? todayChangePct : null;

  return {
    grams,
    today: {
      price: todayPrice,
      change: { rate: todayChangeRate, percent: pct },
    },
  };
}

async function fetchGold() {
  let html = null;
  let lastErr = null;

  for (const u of GOLD_URLS) {
    try {
      html = await fetchHtml(u, { referer: "https://www.tanishq.co.in/" });
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!html) throw lastErr;

  const $ = cheerio.load(html);

  const rows = $("table.goldrate-table-22kt tbody tr");
  const wanted = new Set([1, 10]); // ✅ GOLD: 1g + 10g
  const rates = {};

  rows.each((_, tr) => {
    const row = extractGoldRow($, tr);
    if (wanted.has(row.grams)) rates[String(row.grams)] = row;
  });

  return {
    karat: 22,
    currency: "INR",
    today: {
      "1g": rates["1"]?.today ?? null,
      "10g": rates["10"]?.today ?? null,
    },
  };
}

// ─────────────────────────────────────────────
// SILVER (HinduBusinessLine Chennai)
// ─────────────────────────────────────────────
function parseSilverUnitKey(unitTextRaw) {
  const t = String(unitTextRaw).toLowerCase().replace(/\s+/g, " ").trim();
  if (t.includes("1 gram") || t === "1g" || t === "1 gram") return "1g";
  if (t.includes("1 kg") || t.includes("1kg")) return "1kg";
  return null;
}

async function fetchSilver() {
  const html = await fetchHtml(SILVER_URL, {
    referer: "https://www.thehindubusinessline.com/",
  });

  const $ = cheerio.load(html);

  // Your snippet:
  const table = $("div.table-companies table.table-balance-sheet").first();
  const rows = table.find("tbody tr");

  const out = {
    currency: "INR",
    today: {
      "1g": null,
      "1kg": null,
    },
  };

  rows.each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 4) return;

    const unitText = tds.eq(0).text();
    const key = parseSilverUnitKey(unitText);
    if (!key) return;

    const todayPrice = toINR(tds.eq(1).text());
    const yesterdayPrice = toINR(tds.eq(2).text());

    // Prefer computed change for reliability:
    const rate =
      todayPrice != null && yesterdayPrice != null
        ? todayPrice - yesterdayPrice
        : toSignedInt(tds.eq(3).text());

    const pct = percentFrom(rate, yesterdayPrice);

    out.today[key] = {
      price: todayPrice,
      change: { rate: rate, percent: pct },
    };
  });

  return out;
}

// ─────────────────────────────────────────────
// MAIN (common fetchedAt)
// ─────────────────────────────────────────────
async function main() {
  const fetchedAt = new Date().toISOString();

  const [gold, silver] = await Promise.all([fetchGold(), fetchSilver()]);

  const out = {
    fetchedAt, // ✅ common date
    currency: "INR",
    gold,
    silver,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exitCode = 1;
});
