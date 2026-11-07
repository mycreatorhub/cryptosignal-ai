import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";

const MINI_APP_HTML = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const DB_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

const ALERT_SCAN_INTERVAL_MS = Math.max(60000, Number(process.env.ALERT_SCAN_INTERVAL_MS || 300000));
const alertChats = new Set();
let alertSubscriptionsLoaded = !DB_ENABLED;
const lastAlertByPair = new Map();
const signalHistory = [];
const MAX_SIGNAL_HISTORY = 500;
const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 86400;
let alertScanRunning = false;

const COINS = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  BNBUSDT: "BNB-USD",
  SOLUSDT: "SOL-USD",
  XRPUSDT: "XRP-USD",
  ADAUSDT: "ADA-USD",
  DOGEUSDT: "DOGE-USD",
  LTCUSDT: "LTC-USD",
  LINKUSDT: "LINK-USD",
  AVAXUSDT: "AVAX-USD",
  ZECUSDT: "ZEC-USD",
  NEARUSDT: "NEAR-USD",
  XLMUSDT: "XLM-USD",
  UNIUSDT: "UNI-USD",
  SUIUSDT: "SUI-USD"
};



function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || typeof initData !== "string" || !initData || initData.length > 10000) return null;
  try {
    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash") || "";
    if (!/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => key + "=" + value)
      .join("\n");
    const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    const received = Buffer.from(receivedHash, "hex");
    const calculated = Buffer.from(calculatedHash, "hex");
    if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) return null;
    const authDate = Number(params.get("auth_date"));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate > now + 300 || now - authDate > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) return null;
    const chatType = params.get("chat_type");
    if (chatType && chatType !== "private") return null;
    const user = JSON.parse(params.get("user") || "null");
    if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) return null;
    return { id: Number(user.id) };
  } catch {
    return null;
  }
}

async function readJsonBody(req, maxBytes = 20000) {
  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Invalid JSON body.")); }
    });
    req.on("error", reject);
  });
}

async function supabaseRequest(path, options = {}) {
  if (!DB_ENABLED) throw new Error("Supabase storage is not configured.");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Supabase API error ${response.status}: ${detail.slice(0, 300)}`);
  }
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

async function loadAlertSubscriptions() {
  if (!DB_ENABLED) {
    alertSubscriptionsLoaded = true;
    return;
  }
  const rows = await supabaseRequest("alert_subscriptions?enabled=eq.true&select=telegram_user_id");
  alertChats.clear();
  for (const row of rows || []) {
    const chatId = Number(row.telegram_user_id);
    if (Number.isSafeInteger(chatId) && chatId > 0) alertChats.add(chatId);
  }
  alertSubscriptionsLoaded = true;
}

async function setAlertSubscription(chatId, enabled) {
  if (DB_ENABLED) {
    if (!alertSubscriptionsLoaded) await loadAlertSubscriptions();
    await supabaseRequest("alert_subscriptions?on_conflict=telegram_user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        telegram_user_id: chatId,
        enabled: Boolean(enabled),
        updated_at: new Date().toISOString()
      })
    });
  }
  if (enabled) alertChats.add(chatId);
  else alertChats.delete(chatId);
}

function closedOnly(candles) {
  return candles.filter(c => c.closeTime < Date.now());
}

function ema(values, period) {
  const result = [];
  const multiplier = 2 / (period + 1);
  let previous = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) result.push(null);
    else if (i === period - 1) result.push(previous);
    else {
      previous = (values[i] - previous) * multiplier + previous;
      result.push(previous);
    }
  }
  return result;
}

async function getCandles(symbol, interval) {
  const base = symbol.toUpperCase().replace(/USDT$/, "");
  const product = `${base}-USD`;
  const granularity = { "1m": 60, "5m": 300, "15m": 900 }[interval];
  if (!granularity) throw new Error("Unsupported candle interval.");

  const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=${granularity}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "CryptoSignalTelegramBot/1.0" }
  });
  if (!response.ok) throw new Error(`Coinbase candle API error: ${response.status}`);

  const data = await response.json();
  if (!Array.isArray(data)) throw new Error(`Coinbase returned invalid candle data for ${product}.`);

  return data.map(x => ({
    t: Number(x[0]) * 1000,
    l: Number(x[1]),
    h: Number(x[2]),
    o: Number(x[3]),
    c: Number(x[4]),
    v: Number(x[5]),
    closeTime: (Number(x[0]) + granularity) * 1000
  })).filter(x => x.closeTime < Date.now()).sort((a, b) => a.t - b.t);
}

function analyzeSMC(five, m15) {
  const c = closedOnly(five), m = closedOnly(m15);
  if (c.length < 80 || m.length < 55) throw new Error("Waiting for enough finalized 5m and 15m candles.");

  const closes = m.map(x => x.c), e20 = ema(closes, 20), e50 = ema(closes, 50), mi = closes.length - 1;
  const bias = e20[mi] > e50[mi] && closes[mi] > e20[mi] ? "Bullish" :
    e20[mi] < e50[mi] && closes[mi] < e20[mi] ? "Bearish" : "Neutral";
  const n = c.length, last = n - 1, px = c[last].c;
  const tr = c.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c)) : x.h - x.l);
  const av = tr.slice(-14).reduce((s, x) => s + x, 0) / 14;
  const bodies = c.slice(-20, -1).map(x => Math.abs(x.c - x.o));
  const avgBody = bodies.reduce((s, x) => s + x, 0) / (bodies.length || 1);
  const pivots = [];

  for (let i = 2; i < n - 2; i++) {
    const left = c.slice(i - 2, i), right = c.slice(i + 1, i + 3);
    if (left.every(x => c[i].h > x.h) && right.every(x => c[i].h > x.h))
      pivots.push({ type: "H", price: c[i].h, index: i, confirmed: i + 2 });
    if (left.every(x => c[i].l < x.l) && right.every(x => c[i].l < x.l))
      pivots.push({ type: "L", price: c[i].l, index: i, confirmed: i + 2 });
  }

  let setup = null;
  for (let i = Math.max(25, n - 55); i < n - 5; i++) {
    const priorHigh = pivots.filter(p => p.type === "H" && p.confirmed < i).at(-1);
    const priorLow = pivots.filter(p => p.type === "L" && p.confirmed < i).at(-1);
    if (!priorHigh || !priorLow) continue;

    let side = null, sweepExtreme = null, liquidityLevel = null;
    if (c[i].h > priorHigh.price && c[i].c < priorHigh.price) {
      side = "SELL"; sweepExtreme = c[i].h; liquidityLevel = priorHigh.price;
    }
    if (c[i].l < priorLow.price && c[i].c > priorLow.price) {
      side = "BUY"; sweepExtreme = c[i].l; liquidityLevel = priorLow.price;
    }
    if (!side) continue;

    let mssIndex = -1, mssLevel = null;
    for (let j = i + 1; j < Math.min(n - 2, i + 13); j++) {
      const structure = side === "BUY"
        ? pivots.filter(p => p.type === "H" && p.confirmed < j && p.index > i - 12).at(-1)
        : pivots.filter(p => p.type === "L" && p.confirmed < j && p.index > i - 12).at(-1);
      if (!structure) continue;
      if (side === "BUY" && c[j].c > structure.price) { mssIndex = j; mssLevel = structure.price; break; }
      if (side === "SELL" && c[j].c < structure.price) { mssIndex = j; mssLevel = structure.price; break; }
    }
    if (mssIndex < 0) { setup = { side, stage: "Waiting for MSS", sweepExtreme, liquidityLevel }; continue; }

    let fvg = null;
    for (let k = mssIndex + 1; k < n; k++) {
      const displacement = Math.abs(c[k].c - c[k].o) >= Math.max(avgBody * 1.25, av * 0.35);
      if (!displacement) continue;
      if (side === "BUY" && c[k].c > c[k].o && c[k - 2].h < c[k].l) {
        fvg = { low: c[k - 2].h, high: c[k].l, index: k }; break;
      }
      if (side === "SELL" && c[k].c < c[k].o && c[k - 2].l > c[k].h) {
        fvg = { low: c[k].h, high: c[k - 2].l, index: k }; break;
      }
    }
    if (!fvg) { setup = { side, stage: "Waiting for displacement / FVG", sweepExtreme, liquidityLevel, mssIndex, mssLevel }; continue; }

    let retestIndex = -1, rejectionConfirmed = false, fvgInvalidated = false;
    for (let r = fvg.index + 1; r < n; r++) {
      const touched = c[r].l <= fvg.high && c[r].h >= fvg.low;
      if (side === "BUY" && c[r].c < fvg.low) { fvgInvalidated = true; break; }
      if (side === "SELL" && c[r].c > fvg.high) { fvgInvalidated = true; break; }
      if (!touched) continue;
      retestIndex = r;
      rejectionConfirmed = side === "BUY"
        ? c[r].c > fvg.high && c[r].c > c[r].o
        : c[r].c < fvg.low && c[r].c < c[r].o;
      if (rejectionConfirmed) break;
    }
    if (fvgInvalidated) {
      setup = { side, stage: "FVG invalidated — waiting for a new setup", sweepExtreme, liquidityLevel, mssIndex, mssLevel, fvg };
      continue;
    }
    setup = {
      side,
      stage: rejectionConfirmed && retestIndex === n - 1 ? "FVG rejection confirmed" :
        retestIndex === n - 1 ? "FVG retest touched — waiting for rejection" :
        retestIndex >= 0 ? "FVG retest passed — waiting for a new setup" : "Waiting for FVG retest",
      sweepExtreme, liquidityLevel, mssIndex, mssLevel, fvg, retestIndex, rejectionConfirmed
    };
  }

  const stage = setup ? setup.stage : "Waiting for liquidity sweep";
  const side = setup ? setup.side : null;
  const ready = !!setup && setup.stage === "FVG rejection confirmed" && setup.rejectionConfirmed === true;
  const contextAligned = (side === "BUY" && bias === "Bullish") || (side === "SELL" && bias === "Bearish");
  const state = ready && contextAligned ? side : "WAIT";
  const entry = ready ? px : setup?.fvg ? (setup.fvg.low + setup.fvg.high) / 2 : null;
  let stop = null, tp1 = null, tp2 = null, rr1 = null, rr2 = null;

  if (ready && Number.isFinite(entry)) {
    const buffer = av * 0.12;
    stop = side === "BUY" ? setup.sweepExtreme - buffer : setup.sweepExtreme + buffer;
    const risk = Math.abs(entry - stop);
    if (risk > 0) {
      const opposing = side === "BUY"
        ? pivots.filter(p => p.type === "H" && p.price > entry).map(p => p.price).sort((a, b) => a - b)[0]
        : pivots.filter(p => p.type === "L" && p.price < entry).map(p => p.price).sort((a, b) => b - a)[0];
      const minTarget = side === "BUY" ? entry + 1.5 * risk : entry - 1.5 * risk;
      tp1 = Number.isFinite(opposing) && (side === "BUY" ? opposing >= minTarget : opposing <= minTarget) ? opposing : minTarget;
      tp2 = side === "BUY" ? entry + 2.5 * risk : entry - 2.5 * risk;
      rr1 = 1.5; rr2 = 2.5;
    }
  }

  const strength = ready ? 100 : setup?.fvg ? 80 : setup?.mssIndex !== undefined ? 60 : setup ? 35 : 0;
  return {
    price: px, bias, state, side, stage, strength,
    entry, stop, tp1, tp2, rr1, rr2, atr: av, atrPct: av / px * 100,
    liquidityLevel: setup?.liquidityLevel ?? null,
    sweepExtreme: setup?.sweepExtreme ?? null,
    mssLevel: setup?.mssLevel ?? null,
    fvgLow: setup?.fvg?.low ?? null,
    fvgHigh: setup?.fvg?.high ?? null,
    candles: c.length
  };
}

function findLiquidityZones(candles) {
  const c = Array.isArray(candles) ? candles : [];
  if (c.length < 10) return [];
  const ranges = c.slice(-15).map((x, i, a) => {
    const prev = a[i - 1];
    return prev ? Math.max(x.h - x.l, Math.abs(x.h - prev.c), Math.abs(x.l - prev.c)) : x.h - x.l;
  });
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const halfWidth = Math.max(atr * 0.12, Math.abs(c.at(-1).c) * 0.00015);
  const highs = [], lows = [];
  for (let i = 2; i < c.length - 2; i++) {
    const left = c.slice(i - 2, i), right = c.slice(i + 1, i + 3);
    if (left.every(x => c[i].h > x.h) && right.every(x => c[i].h > x.h))
      highs.push({ side: "BSL", level: c[i].h, low: c[i].h - halfWidth, high: c[i].h + halfWidth, time: c[i].t });
    if (left.every(x => c[i].l < x.l) && right.every(x => c[i].l < x.l))
      lows.push({ side: "SSL", level: c[i].l, low: c[i].l - halfWidth, high: c[i].l + halfWidth, time: c[i].t });
  }
  return [...highs.slice(-2), ...lows.slice(-2)];
}

function money(n) { return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 8 }) : "—"; }

async function coinbasePrice(symbol) {
  const product = COINS[symbol];
  if (!product) throw new Error("Price is not available for this symbol in the current Coinbase mapping.");
  const response = await fetch(`https://api.coinbase.com/v2/prices/${product}/spot`);
  if (!response.ok) throw new Error(`Price API error: ${response.status}`);
  const data = await response.json();
  const price = Number(data.data?.amount);
  if (!Number.isFinite(price)) throw new Error("Price response was invalid.");
  return price;
}

const MAIN_MENU = {
  inline_keyboard: [
    [{ text: "📱 Open CryptoSignal AI", web_app: { url: "https://cryptosignal-ai.onrender.com/app" } }],
    [{ text: "🎯 Get Trading Signal", callback_data: "signal:BTCUSDT" }],
    [{ text: "💰 Live BTC Price", callback_data: "price:BTCUSDT" }, { text: "📊 Supported Pairs", callback_data: "pairs" }],
    [{ text: "🔔 Alerts ON", callback_data: "alerts:on" }, { text: "🔕 Alerts OFF", callback_data: "alerts:off" }],
    [{ text: "📈 Performance", callback_data: "performance" }],
    [{ text: "🟢 Bot Status", callback_data: "status" }, { text: "❓ Help", callback_data: "help" }]
  ]
};

async function sendMessage(chatId, text, replyMarkup = MAIN_MENU) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
}

async function answerCallbackQuery(callbackId) {
  if (!BOT_TOKEN || !callbackId) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId })
  });
}

async function setBotCommands() {
  if (!BOT_TOKEN) return;
  const commands = [
    { command: "start", description: "Open the CryptoSignal AI dashboard" },
    { command: "signal", description: "Get an SMC trading signal" },
    { command: "price", description: "Check a live crypto price" },
    { command: "alerts", description: "Turn automatic alerts on or off" },
    { command: "pairs", description: "Show supported trading pairs" },
    { command: "status", description: "Check bot and alert status" },
    { command: "performance", description: "View tracked signal outcomes" },
    { command: "dbcheck", description: "Test Supabase database read and write" },
    { command: "help", description: "Show available commands" }
  ];
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands })
  });
  if (!response.ok) throw new Error(`Telegram setMyCommands failed: ${response.status}`);
}

function formatSignal(pair, a, live) {
  return `◈ CryptoSignal AI · AUTOMATIC ALERT
${pair} · 5m entry / 15m context

SIGNAL: ${a.state}
15m bias: ${a.bias}
Setup: ${a.stage}
Strength: ${a.strength}/100 (not win probability)

Price: ${money(live)}
Entry: ${money(a.entry)}
Stop: ${money(a.stop)}
TP1: ${money(a.tp1)} (${a.rr1 ?? "—"}R)
TP2: ${money(a.tp2)} (${a.rr2 ?? "—"}R)

Liquidity: ${money(a.liquidityLevel)}
FVG: ${money(a.fvgLow)} – ${money(a.fvgHigh)}

Experimental analysis only. Not financial advice.`;
}

async function recordSignal(pair, a) {
  if (a.state !== "BUY" && a.state !== "SELL") return;
  const key = [pair, a.state, a.entry, a.stop, a.tp1, a.fvgLow, a.fvgHigh].join("|");
  if (DB_ENABLED) {
    try {
      await supabaseRequest("signal_history?on_conflict=signal_key", {
        method: "POST",
        headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({
          signal_key: key, pair, side: a.state, entry: a.entry,
          stop: a.stop, tp1: a.tp1, outcome: "OPEN"
        })
      });
      return;
    } catch (error) {
      console.error("Persistent signal save failed:", error.message);
    }
  }
  if (signalHistory.some(x => x.key === key)) return;
  signalHistory.push({
    key, pair, side: a.state, entry: a.entry, stop: a.stop, tp1: a.tp1,
    createdAt: Date.now(), outcome: "OPEN"
  });
  while (signalHistory.length > MAX_SIGNAL_HISTORY) signalHistory.shift();
}

async function updateSignalOutcomes(pair, candles) {
  const closed = closedOnly(candles);
  if (DB_ENABLED) {
    try {
      const open = await supabaseRequest(
        `signal_history?pair=eq.${encodeURIComponent(pair)}&outcome=eq.OPEN&select=id,side,stop,tp1,created_at`
      );
      for (const signal of open || []) {
        for (const candle of closed) {
          if (candle.closeTime <= Date.parse(signal.created_at)) continue;
          const hitStop = signal.side === "BUY" ? candle.l <= Number(signal.stop) : candle.h >= Number(signal.stop);
          const hitTarget = signal.side === "BUY" ? candle.h >= Number(signal.tp1) : candle.l <= Number(signal.tp1);
          let outcome = null;
          if (hitStop && hitTarget) outcome = "AMBIGUOUS";
          else if (hitStop) outcome = "LOSS";
          else if (hitTarget) outcome = "WIN";
          if (outcome) {
            await supabaseRequest(`signal_history?id=eq.${signal.id}`, {
              method: "PATCH",
              body: JSON.stringify({ outcome, closed_at: new Date(candle.closeTime).toISOString() })
            });
            break;
          }
        }
      }
      return;
    } catch (error) {
      console.error("Persistent outcome update failed:", error.message);
    }
  }
  for (const signal of signalHistory) {
    if (signal.pair !== pair || signal.outcome !== "OPEN") continue;
    for (const candle of closed) {
      if (candle.closeTime <= signal.createdAt) continue;
      const hitStop = signal.side === "BUY" ? candle.l <= signal.stop : candle.h >= signal.stop;
      const hitTarget = signal.side === "BUY" ? candle.h >= signal.tp1 : candle.l <= signal.tp1;
      if (hitStop && hitTarget) {
        signal.outcome = "AMBIGUOUS";
        signal.closedAt = candle.closeTime;
        break;
      }
      if (hitStop) {
        signal.outcome = "LOSS";
        signal.closedAt = candle.closeTime;
        break;
      }
      if (hitTarget) {
        signal.outcome = "WIN";
        signal.closedAt = candle.closeTime;
        break;
      }
    }
  }
}

async function checkDatabase() {
  if (!DB_ENABLED) {
    return "⚠️ Supabase is not configured. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render.";
  }

  const key = `DBCHECK-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let insertedId = null;
  let insertPassed = false;
  let readPassed = false;
  let cleanupPassed = false;

  try {
    const inserted = await supabaseRequest("signal_history", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        signal_key: key, pair: "DBTEST", side: "BUY",
        entry: 1, stop: 0.9, tp1: 1.1, outcome: "OPEN"
      })
    });
    insertedId = inserted?.[0]?.id || null;
    insertPassed = Boolean(insertedId);
    if (!insertPassed) throw new Error("Insert returned no record ID.");

    const found = await supabaseRequest(
      `signal_history?signal_key=eq.${encodeURIComponent(key)}&select=id,pair&limit=1`
    );
    readPassed = Array.isArray(found) && found.length === 1 &&
      found[0].id === insertedId && found[0].pair === "DBTEST";
    if (!readPassed) throw new Error("Inserted test row could not be read back.");
  } catch (error) {
    console.error("Supabase database check failed:", error.message);
  } finally {
    if (insertedId) {
      try {
        await supabaseRequest(`signal_history?id=eq.${encodeURIComponent(insertedId)}`, {
          method: "DELETE"
        });
        cleanupPassed = true;
      } catch (error) {
        console.error("Supabase test-row cleanup failed:", error.message);
      }
    }
  }

  if (insertPassed && readPassed && cleanupPassed) {
    return "✅ SUPABASE DATABASE CHECK PASSED\n\nInsert: OK\nRead-back: OK\nCleanup: OK\n\nA temporary DBTEST row was created, verified, and deleted. No trading signal or performance count was changed.";
  }
  return `⚠️ SUPABASE DATABASE CHECK INCOMPLETE\n\nInsert: ${insertPassed ? "OK" : "FAILED"}\nRead-back: ${readPassed ? "OK" : "FAILED"}\nCleanup: ${insertedId ? (cleanupPassed ? "OK" : "FAILED — check Supabase for a leftover DBTEST row") : "Not needed"}\n\nCheck the Render logs for the Supabase API error. No real trading signal was created.`;
}

async function formatPerformance() {
  let rows = signalHistory;
  let persistent = false;
  if (DB_ENABLED) {
    try {
      rows = await supabaseRequest("signal_history?select=outcome&order=created_at.desc&limit=500");
      persistent = true;
    } catch (error) {
      console.error("Persistent performance read failed:", error.message);
    }
  }
  const wins = rows.filter(x => x.outcome === "WIN").length;
  const losses = rows.filter(x => x.outcome === "LOSS").length;
  const open = rows.filter(x => x.outcome === "OPEN").length;
  const ambiguous = rows.filter(x => x.outcome === "AMBIGUOUS").length;
  const decided = wins + losses;
  const winRate = decided ? (wins / decided * 100).toFixed(1) : "—";
  return `📈 CRYPTOSIGNAL AI · PERFORMANCE

Tracked signals: ${rows.length}
🟢 TP1 reached: ${wins}
🔴 Stop Loss reached: ${losses}
⏳ Still active: ${open}
⚪ Ambiguous candles: ${ambiguous}

Win rate: ${winRate}${decided ? "%" : ""}
Based on ${decided} resolved signals.

${persistent ? "💾 Persistent Supabase history enabled (latest 500 records)." : "⚠️ In-memory tracking only: history resets when the service restarts. Configure Supabase environment variables for permanent history."}
A candle touching both TP1 and SL is excluded from win-rate calculations. Experimental tracking, not audited trading results.`;
}

async function scanForAlerts() {
  if (alertScanRunning || !alertSubscriptionsLoaded || alertChats.size === 0) return;
  alertScanRunning = true;
  try {
    for (const pair of Object.keys(COINS)) {
      try {
        const [five, fifteen] = await Promise.all([getCandles(pair, "5m"), getCandles(pair, "15m")]);
        const a = analyzeSMC(five, fifteen);
        await updateSignalOutcomes(pair, five);
        if (a.state !== "BUY" && a.state !== "SELL") {
          lastAlertByPair.delete(pair);
          continue;
        }
        const key = [a.state, a.entry, a.stop, a.tp1, a.tp2, a.fvgLow, a.fvgHigh].join("|");
        await recordSignal(pair, a);
        if (lastAlertByPair.get(pair) === key) continue;
        const live = await coinbasePrice(pair).catch(() => a.price);
        const message = formatSignal(pair, a, live);
        for (const chatId of alertChats) {
          try { await sendMessage(chatId, message); }
          catch (error) { console.error("Alert delivery failed:", error.message); }
        }
        lastAlertByPair.set(pair, key);
      } catch (error) {
        console.error(`Alert scan failed for ${pair}:`, error.message);
      }
    }
  } finally {
    alertScanRunning = false;
  }
}

async function handleUpdate(update) {
  const callback = update.callback_query;
  if (callback) await answerCallbackQuery(callback.id);
  const message = update.message || callback?.message;
  const chatId = message?.chat?.id;
  let text = message?.text?.trim();
  if (callback?.data) {
    const action = callback.data;
    if (action.startsWith("signal:")) text = `/signal ${action.split(":")[1]}`;
    else if (action.startsWith("price:")) text = `/price ${action.split(":")[1]}`;
    else if (action.startsWith("alerts:")) text = `/alerts ${action.split(":")[1]}`;
    else if (action === "pairs") text = "/pairs";
    else if (action === "status") text = "/status";
    else if (action === "performance") text = "/performance";
    else if (action === "help") text = "/help";
  }
  if (!chatId || !text) return;

  let reply;
  if (text === "/alerts" || text.startsWith("/alerts ")) {
    const action = (text.split(/\s+/)[1] || "").toLowerCase();
    if (action === "on") {
      try {
        await setAlertSubscription(chatId, true);
        reply = `🔔 Automatic alerts enabled. I'll scan the supported Coinbase pairs about every ${Math.round(ALERT_SCAN_INTERVAL_MS / 60000)} minute(s) and send only new BUY/SELL setups. Your subscription is saved when Supabase is configured.\n\nSend /alerts off to stop.`;
      } catch (error) {
        reply = `⚠️ I couldn't save your alert subscription. Please try again.\n${error.message}`;
      }
    } else if (action === "off") {
      try {
        await setAlertSubscription(chatId, false);
        reply = "🔕 Automatic alerts disabled for this chat.";
      } catch (error) {
        reply = `⚠️ I couldn't update your alert subscription. Please try again.\n${error.message}`;
      }
    } else {
      reply = "Usage:\n/alerts on — enable automatic BUY/SELL alerts\n/alerts off — disable alerts";
    }
  } else if (text === "/start") {
    reply = "◈ CryptoSignal AI\n\nWelcome to your smart crypto trading assistant.\n\nChoose an action below to check prices, analyze a market, or manage automatic alerts.\n\n⏱ 5m entry · 15m context\n🧠 SMC-based experimental analysis\n\nSignals are not financial advice.";
  } else if (text === "/pairs") {
    reply = "📊 SUPPORTED COINBASE PAIRS\n\n" + Object.keys(COINS).join("\n") + "\n\nUse /price BTCUSDT or /signal BTCUSDT to get started.";
  } else if (text === "/status") {
    reply = "🟢 CRYPTOSIGNAL AI STATUS\n\nBot process: Running\nAutomatic alerts for this chat: " + (alertChats.has(chatId) ? "ON 🔔" : "OFF 🔕") + "\nScan interval: " + Math.round(ALERT_SCAN_INTERVAL_MS / 60000) + " minute(s)\nSupported pairs: " + Object.keys(COINS).length + "\n\nNote: status reflects this running process; hosting sleep/restarts can pause alerts.";
  } else if (text === "/dbcheck") {
    reply = await checkDatabase();
  } else if (text === "/performance") {
    reply = await formatPerformance();
  } else if (text === "/help") {
    reply = "Commands:\n/start — open dashboard\n/price BTCUSDT — latest Coinbase spot price\n/signal BTCUSDT — 5m SMC setup with 15m context\n/alerts on — enable automatic BUY/SELL alerts\n/alerts off — disable alerts\n/pairs — show supported pairs\n/status — check bot and alert status\n/performance — view tracked signal outcomes\n/help — show commands\n\nSignals are experimental and are not financial advice.";
  } else if (text.startsWith("/price")) {
    const pair = (text.split(/\s+/)[1] || "BTCUSDT").toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(pair)) reply = "Invalid pair. Example: /price BTCUSDT";
    else {
      try { reply = `💰 ${pair}\nCoinbase spot: $${money(await coinbasePrice(pair))}`; }
      catch (error) { reply = `⚠️ Price lookup failed for ${pair}\n${error.message}`; }
    }
  } else if (text.startsWith("/signal")) {
    const pair = (text.split(/\s+/)[1] || "BTCUSDT").toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(pair)) reply = "Invalid pair. Example: /signal BTCUSDT";
    else {
      try {
        const [five, fifteen] = await Promise.all([getCandles(pair, "5m"), getCandles(pair, "15m")]);
        const a = analyzeSMC(five, fifteen);
        await updateSignalOutcomes(pair, five);
        await recordSignal(pair, a);
        const live = await coinbasePrice(pair).catch(() => a.price);
        reply = `◈ CryptoSignal AI · SMC\n${pair} · 5m entry / 15m context\n\nSIGNAL: ${a.state}\n15m bias: ${a.bias}\nSetup: ${a.stage}\nStrength: ${a.strength}/100 (rule stages, not win probability)\n\nPrice: $${money(live)}\nEntry: $${money(a.entry)}\nStop: $${money(a.stop)}\nTP1: $${money(a.tp1)} (${a.rr1 ?? "—"}R)\nTP2: $${money(a.tp2)} (${a.rr2 ?? "—"}R)\n\nLiquidity: $${money(a.liquidityLevel)}\nSweep extreme: $${money(a.sweepExtreme)}\nMSS: $${money(a.mssLevel)}\nFVG: $${money(a.fvgLow)} – $${money(a.fvgHigh)}\n5m ATR: $${money(a.atr)}\n\nExperimental analysis only. Not financial advice.`;
      } catch (error) {
        reply = `⚠️ Analysis failed for ${pair}\n${error.message}`;
      }
    }
  } else {
    reply = "Unknown command. Send /help to see available commands.";
  }

  await sendMessage(chatId, reply, MAIN_MENU);
}

const server = createServer(async (req, res) => {
  const requestPath = new URL(req.url, "http://localhost").pathname;
  if (req.method === "GET" && requestPath === "/app") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(MINI_APP_HTML);
  }


  if (req.method === "POST" && requestPath === "/api/alerts") {
    try {
      const body = await readJsonBody(req);
      const telegramUser = verifyTelegramInitData(body.initData);
      if (!telegramUser) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Telegram authentication failed. Close and reopen this Mini App from your bot in Telegram." }));
      }
      const action = body.action;
      if (!["status", "on", "off"].includes(action)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Invalid alert action." }));
      }
      if (DB_ENABLED && !alertSubscriptionsLoaded) await loadAlertSubscriptions();
      if (action === "on") await setAlertSubscription(telegramUser.id, true);
      if (action === "off") await setAlertSubscription(telegramUser.id, false);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        ok: true,
        enabled: alertChats.has(telegramUser.id),
        persistent: DB_ENABLED
      }));
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: error.message || "Could not process alert settings." }));
    }
  }

  if (req.method === "GET" && requestPath === "/api/candles") {
    try {
      const params = new URL(req.url, "http://localhost").searchParams;
      const pair = (params.get("pair") || "BTCUSDT").toUpperCase();
      const interval = (params.get("interval") || "5m").toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(COINS, pair)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Unsupported pair." }));
      }
      if (!["1m", "5m", "15m"].includes(interval)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ error: "Unsupported interval. Use 1m, 5m or 15m." }));
      }
      const [candles, price] = await Promise.all([getCandles(pair, interval), coinbasePrice(pair)]);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        pair, interval, price, candles: candles.slice(-90),
        liquidityZones: findLiquidityZones(candles.slice(-90)),
        updatedAt: new Date().toISOString(), dataSource: "Coinbase Exchange"
      }));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: error.message || "Candle data unavailable." }));
    }
  }

  if (req.method === "GET" && requestPath === "/api/market") {
    try {
      const params = new URL(req.url, "http://localhost").searchParams;
      const pair = (params.get("pair") || "BTCUSDT").toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(COINS, pair)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "Unsupported pair." }));
      }
      const [five, fifteen, live] = await Promise.all([
        getCandles(pair, "5m"),
        getCandles(pair, "15m"),
        coinbasePrice(pair)
      ]);
      const analysis = analyzeSMC(five, fifteen);
      await updateSignalOutcomes(pair, five);
      await recordSignal(pair, analysis);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({
        pair, price: live, analysis,
        updatedAt: new Date().toISOString(),
        dataSource: "Coinbase"
      }));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: error.message || "Market data unavailable." }));
    }
  }

  if (req.method === "GET" && requestPath === "/api/markets") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    const entries = await Promise.all(Object.keys(COINS).map(async pair => {
      try { return { pair, price: await coinbasePrice(pair) }; }
      catch (error) { return { pair, error: error.message }; }
    }));
    return res.end(JSON.stringify({ markets: entries, updatedAt: new Date().toISOString() }));
  }

  if (req.method === "GET" && requestPath === "/api/performance") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    try {
      let rows = signalHistory;
      let persistent = false;
      if (DB_ENABLED) {
        rows = await supabaseRequest("signal_history?select=pair,side,entry,stop,tp1,outcome,created_at,closed_at&order=created_at.desc&limit=500");
        persistent = true;
      }
      const wins = rows.filter(x => x.outcome === "WIN").length;
      const losses = rows.filter(x => x.outcome === "LOSS").length;
      const open = rows.filter(x => x.outcome === "OPEN").length;
      const ambiguous = rows.filter(x => x.outcome === "AMBIGUOUS").length;
      const decided = wins + losses;
      const directionStats = ["BUY", "SELL"].map(side => {
        const sideRows = rows.filter(row => row.side === side);
        const sideWins = sideRows.filter(row => row.outcome === "WIN").length;
        const sideLosses = sideRows.filter(row => row.outcome === "LOSS").length;
        const resolved = sideWins + sideLosses;
        return { side, wins: sideWins, losses: sideLosses, resolved,
          winRate: resolved ? Number((sideWins / resolved * 100).toFixed(1)) : null };
      });
      const durations = rows.filter(row => (row.outcome === "WIN" || row.outcome === "LOSS") && row.created_at && row.closed_at)
        .map(row => Date.parse(row.closed_at) - Date.parse(row.created_at))
        .filter(ms => Number.isFinite(ms) && ms >= 0);
      const averageDurationMs = durations.length ? Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length) : null;
      const resolvedRecent = rows.filter(row => row.outcome === "WIN" || row.outcome === "LOSS")
        .sort((a, b) => Date.parse(b.closed_at || b.created_at) - Date.parse(a.closed_at || a.created_at));
      let currentStreak = { outcome: null, count: 0 };
      if (resolvedRecent.length) {
        currentStreak.outcome = resolvedRecent[0].outcome;
        for (const row of resolvedRecent) {
          if (row.outcome !== currentStreak.outcome) break;
          currentStreak.count++;
        }
      }
      const pairStats = Object.values(rows.reduce((groups, row) => {
        const pair = row.pair || "UNKNOWN";
        if (!groups[pair]) groups[pair] = { pair, wins: 0, losses: 0, open: 0, ambiguous: 0 };
        if (row.outcome === "WIN") groups[pair].wins++;
        else if (row.outcome === "LOSS") groups[pair].losses++;
        else if (row.outcome === "OPEN") groups[pair].open++;
        else if (row.outcome === "AMBIGUOUS") groups[pair].ambiguous++;
        return groups;
      }, {})).map(item => {
        const resolved = item.wins + item.losses;
        return { ...item, resolved, winRate: resolved ? Number((item.wins / resolved * 100).toFixed(1)) : null };
      }).sort((a, b) => b.resolved - a.resolved || b.wins - a.wins || a.pair.localeCompare(b.pair));
      const bestPair = pairStats.find(item => item.resolved > 0) || null;
      return res.end(JSON.stringify({
        tracked: rows.length, wins, losses, open, ambiguous,
        winRate: decided ? Number((wins / decided * 100).toFixed(1)) : null,
        directionStats, averageDurationMs, durationSamples: durations.length,
        currentStreak, bestPair, pairStats, persistent, records: rows.slice(0, 25)
      }));
    } catch (error) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: error.message || "Performance data unavailable." }));
    }
  }

  if (req.method === "GET" && (requestPath === "/" || requestPath === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      service: "CryptoSignal Telegram Bot",
      telegramTokenConfigured: Boolean(BOT_TOKEN),
      webhookSecretConfigured: Boolean(WEBHOOK_SECRET),
      supabaseConfigured: DB_ENABLED
    }));
  }

  if (req.method === "POST" && req.url === "/telegram-webhook") {
    if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) {
      res.writeHead(401); return res.end("Unauthorized");
    }
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const update = JSON.parse(raw || "{}");
        await handleUpdate(update);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      } catch (error) {
        console.error("Webhook error:", error);
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Webhook processing failed");
      }
    });
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`CryptoSignal Telegram Bot listening on port ${PORT}`);
  setBotCommands().catch(error => console.error("Telegram command menu setup failed:", error.message));
  try {
    await loadAlertSubscriptions();
    console.log(`Loaded ${alertChats.size} enabled alert subscription(s) from ${DB_ENABLED ? "Supabase" : "memory"}.`);
  } catch (error) {
    console.error("Alert subscription restore failed; alert scanning will remain paused until storage is available:", error.message);
  }
  setInterval(() => { scanForAlerts().catch(error => console.error("Alert scan error:", error)); }, ALERT_SCAN_INTERVAL_MS);
});
