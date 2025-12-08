import fetch from "node-fetch";

// Hidden GoodReturns API (NO Cloudflare)
const GOLD_API = "https://www.goodreturns.in/common/ajax/gold-rate?city=Chennai";

function directionFromChange(change) {
  if (!change) return { direction: "neutral", color: "grey" };
  if (change.startsWith("+")) return { direction: "up", color: "green" };
  if (change.startsWith("-")) return { direction: "down", color: "red" };
  return { direction: "neutral", color: "grey" };
}

async function fetchGoldRates() {
  console.log("⏳ Fetching Gold Rates (Chennai)…");

  try {
    const res = await fetch(GOLD_API, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
      },
    });

    const data = await res.json();

    // They return commas in price like 12,916 — remove them
    const format = (v) => v.replace(/,/g, "").trim();

    const gold = {
      "24k": {
        price: format(data.rate_24k),
        change: data.change_24k.trim(),
        ...directionFromChange(data.change_24k.trim()),
      },
      "22k": {
        price: format(data.rate_22k),
        change: data.change_22k.trim(),
        ...directionFromChange(data.change_22k.trim()),
      },
    };

    console.log("✅ GOLD API SUCCESS\n");
    console.log(JSON.stringify({ gold }, null, 2));
  } catch (err) {
    console.log("❌ GOLD API ERROR:", err.message);
  }
}

fetchGoldRates();
