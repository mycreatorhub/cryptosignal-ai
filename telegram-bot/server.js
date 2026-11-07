import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const COINS = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  BNBUSDT: "BNB-USD",
  SOLUSDT: "SOL-USD",
  XRPUSDT: "XRP-USD",
  ADAUSDT: "ADA-USD",
  DOGEUSDT: "DOGE-USD",
  TRXUSDT: "TRX-USD",
  LINKUSDT: "LINK-USD",
  AVAXUSDT: "AVAX-USD"
};

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
  const granularity = { "5m": 300, "15m": 900 }[interval];
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

    let retestIndex = -1;
    for (let r = fvg.index + 1; r < n; r++) {
      if (c[r].l <= fvg.high && c[r].h >= fvg.low) { retestIndex = r; break; }
    }
    setup = {
      side,
      stage: retestIndex === n - 1 ? "FVG retest active" :
        retestIndex >= 0 ? "FVG retest passed — waiting for a new setup" : "Waiting for FVG retest",
      sweepExtreme, liquidityLevel, mssIndex, mssLevel, fvg, retestIndex
    };
  }

  const stage = setup ? setup.stage : "Waiting for liquidity sweep";
  const side = setup ? setup.side : null;
  const ready = !!setup && setup.stage === "FVG retest active";
  const contextAligned = (side === "BUY" && bias === "Bullish") || (side === "SELL" && bias === "Bearish");
  const state = ready && contextAligned ? side : "WAIT";
  const entry = setup?.fvg ? (setup.fvg.low + setup.fvg.high) / 2 : null;
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

async function sendMessage(chatId, text) {
  if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
}

async function handleUpdate(update) {
  const message = update.message;
  const chatId = message?.chat?.id;
  const text = message?.text?.trim();
  if (!chatId || !text) return;

  let reply;
  if (text === "/start") {
    reply = "◈ CryptoSignal AI Bot\n\nWelcome! I can check public market prices and SMC scalp setups.\n\nCommands:\n/price BTCUSDT\n/signal BTCUSDT\n/help";
  } else if (text === "/help") {
    reply = "Commands:\n/price BTCUSDT — latest Coinbase spot price\n/signal BTCUSDT — 5m SMC setup with 15m context\n\nSignals are experimental and are not financial advice.";
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
        const live = await coinbasePrice(pair).catch(() => a.price);
        reply = `◈ CryptoSignal AI · SMC\n${pair} · 5m entry / 15m context\n\nSIGNAL: ${a.state}\n15m bias: ${a.bias}\nSetup: ${a.stage}\nStrength: ${a.strength}/100 (rule stages, not win probability)\n\nPrice: $${money(live)}\nEntry: $${money(a.entry)}\nStop: $${money(a.stop)}\nTP1: $${money(a.tp1)} (${a.rr1 ?? "—"}R)\nTP2: $${money(a.tp2)} (${a.rr2 ?? "—"}R)\n\nLiquidity: $${money(a.liquidityLevel)}\nSweep extreme: $${money(a.sweepExtreme)}\nMSS: $${money(a.mssLevel)}\nFVG: $${money(a.fvgLow)} – $${money(a.fvgHigh)}\n5m ATR: $${money(a.atr)}\n\nExperimental analysis only. Not financial advice.`;
      } catch (error) {
        reply = `⚠️ Analysis failed for ${pair}\n${error.message}`;
      }
    }
  } else {
    reply = "Unknown command. Send /help to see available commands.";
  }

  await sendMessage(chatId, reply);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      ok: true,
      service: "CryptoSignal Telegram Bot",
      telegramTokenConfigured: Boolean(BOT_TOKEN),
      webhookSecretConfigured: Boolean(WEBHOOK_SECRET)
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CryptoSignal Telegram Bot listening on port ${PORT}`);
});
