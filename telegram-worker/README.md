# CryptoSignal AI — Telegram alert bridge

This Worker keeps the Telegram bot token off the public website and GitHub client code.

## Cloudflare setup

1. In Cloudflare, open **Workers & Pages → Create → Worker** and deploy a Worker named `cryptosignal-telegram`.
2. Replace its starter code with `src/index.js` from this repository (or connect this repository using the Git integration).
3. Create a **KV namespace** named `CRYPTO_TELEGRAM_CHATS`.
4. In the Worker settings, add a KV binding:
   - Variable name: `TELEGRAM_CHATS`
   - KV namespace: `CRYPTO_TELEGRAM_CHATS`
5. Add these Worker secrets (never put them in GitHub or the website):
   - `TELEGRAM_BOT_TOKEN`: the token from BotFather
   - `ALERT_SECRET`: a long random secret you create
   - `WEBHOOK_SECRET`: another long random secret (letters, numbers, underscore, and hyphen only)
6. Deploy the Worker and copy its `workers.dev` URL.

## Connect the Telegram bot

Send a POST request to `https://YOUR-WORKER-URL/setup-webhook` with header `x-admin-secret: YOUR_ALERT_SECRET`. This sets the Telegram webhook. Then open your bot in Telegram and send `/start`. The Worker saves the chat ID in KV.

## Send a test alert

Send a POST request to `https://YOUR-WORKER-URL/alert` with header `x-alert-secret: YOUR_ALERT_SECRET` and JSON body:

```json
{
  "symbol": "BTCUSDT",
  "side": "BUY",
  "entry": "example entry",
  "stop": "example stop",
  "tp1": "example target"
}
```

The Worker sends the alert to every Telegram chat that has sent `/start`.

## Endpoints

- `GET /health` — health check
- `POST /setup-webhook` — configure Telegram webhook; requires `x-admin-secret`
- `POST /telegram/webhook` — Telegram updates; validates Telegram's webhook secret
- `POST /alert` — send a BUY/SELL alert; requires `x-alert-secret`

This is the secure Telegram delivery layer. The website-to-Worker signal trigger still needs to be wired into the scanner after the Worker is deployed and tested.
