// prices.js  (Node 18+)
import * as cheerio from "cheerio";

const URLS = [
  "https://www.tanishq.co.in/shop/gold-rate?lang=en",      // try this first
  "https://www.tanishq.co.in/gold-rate.html?lang=en_IN"    // fallback
];

const toINR = (s) => {
  const n = String(s).replace(/[^\d]/g, "");
  return n ? Number(n) : null;
};

const toSignedInt = (s) => {
  const cleaned = String(s).replace(/[^\d\-]/g, "");
  return cleaned ? Number(cleaned) : null;
};

const toPercent = (s) => {
  const cleaned = String(s).replace(/[()%\s]/g, "");
  return cleaned ? Number(cleaned) : null;
};

function extractRow($, tr) {
  const $tr = $(tr);
  const gramsText = $tr.find("td").eq(0).text().replace(/\s+/g, " ").trim(); // "1 G"
  const grams = Number(gramsText.replace(/[^\d]/g, ""));

  const $today = $tr.find("td").eq(1);

  const todayPrice = toINR(
    $today.clone().find(".pricechange-value").remove().end().text()
  );

  const todayChangeRate = toSignedInt(
    $today.find(".difference-rate").first().text()
  );
  const todayChangePct = toPercent(
    $today.find(".difference-percentage").first().text()
  );

  return {
    grams,
    today: {
      price: todayPrice,
      change: { rate: todayChangeRate, percent: todayChangePct },
    },
  };
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-IN,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer: "https://www.tanishq.co.in/",
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

async function main() {
  let html = null;
  let usedUrl = null;
  let lastErr = null;

  for (const u of URLS) {
    try {
      html = await fetchHtml(u);
      usedUrl = u;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!html) {
    console.error("Blocked (403) on both URLs.");
    console.error(
      "Tip: run this from a normal home network IP (not VPS/serverless), or reduce frequency."
    );
    throw lastErr;
  }

  const $ = cheerio.load(html);

  // Your table:
  const rows = $("table.goldrate-table-22kt tbody tr");
  const wanted = new Set([1, 8]);
  const rates = {};

  rows.each((_, tr) => {
    const row = extractRow($, tr);
    if (wanted.has(row.grams)) {
      rates[String(row.grams)] = row;
    }
  });

  const out = {
    // source: usedUrl,   // ❌ removed as requested
    fetchedAt: new Date().toISOString(),
    karat: 22,
    currency: "INR",
    today: {
      "1g": rates["1"]?.today ?? null,
      "8g": rates["8"]?.today ?? null,
    },
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exitCode = 1;
});
