# CryptoSignal Telegram Bot

A Node.js Telegram webhook bot for CryptoSignal AI. This bot is kept in its own folder so it does not change the existing CryptoSignal website.

## Commands

- `/start`
- `/help`
- `/price BTCUSDT` — Coinbase spot price
- `/signal BTCUSDT` — 5-minute SMC setup with 15-minute EMA20/EMA50 context

## Market data

- Spot prices use Coinbase's public spot-price endpoint.
- Candles use Coinbase Exchange public candles (300-second and 900-second intervals).
- Binance candle endpoints are intentionally not used because the previous Cloudflare deployment received HTTP 403.
- Coinbase USD markets are required. Some symbols may not be listed; unsupported markets return a readable error.

## Run locally

Requires Node.js 20 or newer.

1. Install dependencies (none are required).
2. Set `TELEGRAM_BOT_TOKEN` in your environment.
3. Optionally set `TELEGRAM_WEBHOOK_SECRET` to a long random string.
4. Run `npm start`.

The health page is `GET /`. The Telegram webhook endpoint is `POST /telegram-webhook`.

## Deploy from GitHub

Connect this repository to a Node.js hosting service that supports a web service and environment variables.

- Root directory: `telegram-bot`
- Build command: leave blank (no dependencies)
- Start command: `npm start`
- Environment variable: `TELEGRAM_BOT_TOKEN` (set privately in the host dashboard)
- Optional environment variable: `TELEGRAM_WEBHOOK_SECRET` (set privately in the host dashboard)

After deployment, copy the public service URL. Do not add a trailing slash.

Configure Telegram's webhook by opening this URL in a browser, replacing the placeholders with your bot token and service URL:

```
https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://YOUR-SERVICE-URL/telegram-webhook
```

If you configured `TELEGRAM_WEBHOOK_SECRET`, use a POST request to Telegram's setWebhook API with JSON containing both `url` and `secret_token`. Never put your bot token in a public GitHub file or share it in chat.

## Strategy notes

The SMC scanner follows the website's current 5m/15m rules:

1. Closed 5m candles and 15m EMA20/EMA50 directional bias.
2. Confirmed swing pivots using two candles on each side.
3. Liquidity sweep through a prior pivot and close back inside.
4. Market Structure Shift within the next twelve candles.
5. Displacement candle and fair value gap.
6. FVG retest; BUY/SELL only when the retest is the latest closed 5m candle and 15m bias agrees.
7. Entry at FVG midpoint; stop beyond sweep extreme with 0.12 ATR buffer; TP1 at least 1.5R and TP2 at 2.5R.

Strength is a rule-stage score, not a probability of winning. Signals are experimental and are not financial advice.
