/* 席決めの儀 — 極小サーバー (Deno Deploy)
   保存するのは「解禁フラグ」と「フライング記録」だけ。
   ADMIN_PIN 環境変数が幹事用PIN(未設定なら "8888")。 */

const kv = await Deno.openKv();
const PIN = Deno.env.get("ADMIN_PIN") ?? "8888";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;

    // ゲスト用: 解禁されたか?
    if (path === "/state") {
      const u = await kv.get(["state", "unlocked"]);
      return json({ unlocked: !!u.value });
    }

    // ゲスト用: フライングの自白(アプリが自動送信)
    if (path === "/attempt" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name ?? "名無し").slice(0, 30);
      const ts = Date.now();
      await kv.set(["attempt", ts, crypto.randomUUID()], { name, ts });
      return json({ ok: true });
    }

    // ---- ここから幹事用(PIN必須) ----

    if (path === "/unlock" && req.method === "POST") {
      const { pin } = await req.json().catch(() => ({}));
      if (pin !== PIN) return json({ error: "PINが違います" }, 403);
      await kv.set(["state", "unlocked"], true);
      return json({ ok: true });
    }

    if (path === "/attempts") {
      if (new URL(req.url).searchParams.get("pin") !== PIN) {
        return json({ error: "PINが違います" }, 403);
      }
      const attempts = [];
      for await (const e of kv.list({ prefix: ["attempt"] })) {
        attempts.push(e.value);
      }
      const u = await kv.get(["state", "unlocked"]);
      return json({ unlocked: !!u.value, attempts });
    }

    // リハーサル用: 封印し直し+記録全消去
    if (path === "/reset" && req.method === "POST") {
      const { pin } = await req.json().catch(() => ({}));
      if (pin !== PIN) return json({ error: "PINが違います" }, 403);
      await kv.set(["state", "unlocked"], false);
      for await (const e of kv.list({ prefix: ["attempt"] })) {
        await kv.delete(e.key);
      }
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
