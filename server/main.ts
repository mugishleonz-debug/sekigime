/* 席決めの儀 — 極小サーバー (Deno Deploy)
   保存するのは「解禁フラグ」と「フライング記録」だけ。
   ADMIN_PIN 環境変数が幹事用PIN(未設定なら "8888")。

   ストレージ: Deno KV があれば使う(永続)。無い環境(新Deno Deployなど)
   ではメモリに自動フォールバック。メモリ時はインスタンス再起動で
   解禁フラグと記録が消えるが、解禁は幹事がもう一度押せばよく、
   フライング記録は各ゲスト端末のローカル記録が正本なので致命傷にならない。 */

type Attempt = { name: string; ts: number };

interface Store {
  getUnlocked(): Promise<boolean>;
  setUnlocked(v: boolean): Promise<void>;
  addAttempt(a: Attempt): Promise<void>;
  listAttempts(): Promise<Attempt[]>;
  clearAttempts(): Promise<void>;
}

async function makeStore(): Promise<Store> {
  try {
    const kv = await Deno.openKv();
    return {
      async getUnlocked() { return !!(await kv.get(["state", "unlocked"])).value; },
      async setUnlocked(v) { await kv.set(["state", "unlocked"], v); },
      async addAttempt(a) { await kv.set(["attempt", a.ts, crypto.randomUUID()], a); },
      async listAttempts() {
        const out: Attempt[] = [];
        for await (const e of kv.list({ prefix: ["attempt"] })) out.push(e.value as Attempt);
        return out;
      },
      async clearAttempts() {
        for await (const e of kv.list({ prefix: ["attempt"] })) await kv.delete(e.key);
      },
    };
  } catch {
    console.warn("Deno KV が使えないためメモリ保存にフォールバックします");
    let unlocked = false;
    let attempts: Attempt[] = [];
    return {
      getUnlocked: () => Promise.resolve(unlocked),
      setUnlocked: (v) => { unlocked = v; return Promise.resolve(); },
      addAttempt: (a) => { attempts.push(a); return Promise.resolve(); },
      listAttempts: () => Promise.resolve([...attempts]),
      clearAttempts: () => { attempts = []; return Promise.resolve(); },
    };
  }
}

const store = await makeStore();
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
      return json({ unlocked: await store.getUnlocked() });
    }

    // ゲスト用: フライングの自白(アプリが自動送信)
    if (path === "/attempt" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const name = String(body.name ?? "名無し").slice(0, 30);
      await store.addAttempt({ name, ts: Date.now() });
      return json({ ok: true });
    }

    // ---- ここから幹事用(PIN必須) ----

    if (path === "/unlock" && req.method === "POST") {
      const { pin } = await req.json().catch(() => ({}));
      if (pin !== PIN) return json({ error: "PINが違います" }, 403);
      await store.setUnlocked(true);
      return json({ ok: true });
    }

    if (path === "/attempts") {
      if (new URL(req.url).searchParams.get("pin") !== PIN) {
        return json({ error: "PINが違います" }, 403);
      }
      return json({
        unlocked: await store.getUnlocked(),
        attempts: await store.listAttempts(),
      });
    }

    // リハーサル用: 封印し直し+記録全消去
    if (path === "/reset" && req.method === "POST") {
      const { pin } = await req.json().catch(() => ({}));
      if (pin !== PIN) return json({ error: "PINが違います" }, 403);
      await store.setUnlocked(false);
      await store.clearAttempts();
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};
