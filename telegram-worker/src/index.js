const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8" }
});

async function telegram(env, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.description || "Telegram API request failed");
  return result;
}

async function sendText(env, chatId, text) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "CryptoSignal AI Telegram bridge" });
    }

    if (request.method === "POST" && url.pathname === "/setup-webhook") {
      if (request.headers.get("x-admin-secret") !== env.ALERT_SECRET) return json({ error: "Unauthorized" }, 401);
      if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) return json({ error: "Missing Telegram secrets" }, 500);
      const webhookUrl = `${url.origin}/telegram/webhook`;
      const result = await telegram(env, "setWebhook", {
        url: webhookUrl,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message"]
      });
      return json({ ok: true, webhook: webhookUrl, telegram: result.description || "Webhook configured" });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
      const update = await request.json();
      const message = update.message;
      if (!message?.chat?.id || typeof message.text !== "string") return json({ ok: true });
      const chatId = String(message.chat.id);
      const text = message.text.trim();

      if (text === "/start" || text.startsWith("/start ")) {
        await env.TELEGRAM_CHATS.put(chatId, JSON.stringify({
          chatId,
          username: message.from?.username || null,
          firstName: message.from?.first_name || null,
          connectedAt: new Date().toISOString()
        }));
        await sendText(env, chatId,
          "CryptoSignal AI is connected! You will receive trading signal alerts here when your scanner sends them.\n\nCommands:\n/status - check connection\n/stop - stop alerts");
      } else if (text === "/status") {
        const saved = await env.TELEGRAM_CHATS.get(chatId);
        await sendText(env, chatId, saved ? "Your Telegram chat is connected to CryptoSignal AI." : "This chat is not registered yet. Send /start to connect.");
      } else if (text === "/stop") {
        await env.TELEGRAM_CHATS.delete(chatId);
        await sendText(env, chatId, "Telegram alerts stopped for this chat. Send /start to reconnect.");
      }
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/alert") {
      if (request.headers.get("x-alert-secret") !== env.ALERT_SECRET) return json({ error: "Unauthorized" }, 401);
      const body = await request.json();
      const symbol = String(body.symbol || "Unknown asset").slice(0, 30);
      const side = String(body.side || "SIGNAL").toUpperCase();
      if (!["BUY", "SELL"].includes(side)) return json({ error: "side must be BUY or SELL" }, 400);
      const lines = [
        `CryptoSignal AI · ${side}`,
        `Asset: ${symbol}`,
        body.entry != null ? `Entry: ${body.entry}` : null,
        body.stop != null ? `Stop loss: ${body.stop}` : null,
        body.tp1 != null ? `Take profit 1: ${body.tp1}` : null,
        body.tp2 != null ? `Take profit 2: ${body.tp2}` : null,
        body.time ? `Time: ${String(body.time).slice(0, 50)}` : null,
        "",
        "Experimental signal only — not financial advice."
      ].filter(line => line !== null);
      const chats = await env.TELEGRAM_CHATS.list();
      let sent = 0;
      for (const item of chats.keys) {
        try {
          await sendText(env, item.name, lines.join("\n"));
          sent++;
        } catch (error) {
          // Continue sending to the other registered chats.
        }
      }
      return json({ ok: true, sent, registered: chats.keys.length });
    }

    return json({ error: "Not found" }, 404);
  }
};
