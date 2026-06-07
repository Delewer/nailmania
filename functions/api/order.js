// Cloudflare Pages Function — POST /api/order
// Forwards a placed order to Telegram. The bot token lives in env secrets
// (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) — never in the client bundle or the repo.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function format(o) {
  const items = (o.items || []).map((it) => `• ${esc(it.name)} × ${it.q} — ${it.price * it.q} lei`).join("\n");
  const c = o.customer || {};
  const addr = [c.city, c.address].filter(Boolean).join(", ");
  return [
    `🛍 <b>Новый заказ ${esc(o.no)}</b>`,
    `👤 ${esc(c.name)} — ${esc(c.phone)}`,
    c.email ? `✉️ ${esc(c.email)}` : "",
    `🚚 ${esc(o.deliveryLabel)}${addr ? " — " + esc(addr) : ""}`,
    `💳 ${esc(o.paymentLabel)}`,
    "",
    items,
    "",
    o.discount > 0 ? `Скидка: −${o.discount} lei` : "",
    `<b>Итого: ${o.total} lei</b>`,
    c.comment ? `📝 ${esc(c.comment)}` : "",
  ].filter(Boolean).join("\n");
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost({ request, env }) {
  try {
    const order = await request.json();
    const token = env.TELEGRAM_BOT_TOKEN;
    const chat = env.TELEGRAM_CHAT_ID;
    if (!token || !chat) return json({ ok: false, error: "not configured" }, 500);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: format(order), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    return json({ ok: res.ok }, res.ok ? 200 : 502);
  } catch {
    return json({ ok: false }, 500);
  }
}
