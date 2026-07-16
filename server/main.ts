/* 席決めの儀 — 極小サーバー (Deno Deploy)
   保存するのは「解禁フラグ」と「フライング記録」だけ。
   ADMIN_PIN 環境変数が幹事用PIN(未設定なら "8888")。

   ストレージ: Deno KV があれば使う(永続)。無い環境(新Deno Deployなど)
   ではメモリに自動フォールバック。メモリ時はインスタンス再起動で
   解禁フラグと記録が消えるが、解禁は幹事がもう一度押せばよく、
   フライング記録は各ゲスト端末のローカル記録が正本なので致命傷にならない。 */

type Attempt = { name: string; ts: number };

interface Store {
  kind: "kv" | "memory";
  getUnlocked(): Promise<boolean>;
  setUnlocked(v: boolean): Promise<void>;
  addAttempt(a: Attempt): Promise<void>;
  listAttempts(): Promise<Attempt[]>;
  clearAttempts(): Promise<void>;
  getBoard(): Promise<unknown>;
  setBoard(v: unknown): Promise<void>;
}

async function makeStore(): Promise<Store> {
  try {
    const kv = await Deno.openKv();
    return {
      kind: "kv",
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
      async getBoard() { return (await kv.get(["board"])).value ?? null; },
      async setBoard(v) { await kv.set(["board"], v); },
    };
  } catch {
    console.warn("Deno KV が使えないためメモリ保存にフォールバックします");
    let unlocked = false;
    let attempts: Attempt[] = [];
    let board: unknown = null;
    return {
      kind: "memory",
      getUnlocked: () => Promise.resolve(unlocked),
      setUnlocked: (v) => { unlocked = v; return Promise.resolve(); },
      addAttempt: (a) => { attempts.push(a); return Promise.resolve(); },
      listAttempts: () => Promise.resolve([...attempts]),
      clearAttempts: () => { attempts = []; return Promise.resolve(); },
      getBoard: () => Promise.resolve(board),
      setBoard: (v) => { board = v; return Promise.resolve(); },
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

/* ---- 静的ページ配信 ----
   実名入りのページ一式は Git に入れず、デプロイ元の server/static/ から
   ここで配る(URLを知っている人だけが見られる。noindexで検索にも載せない)。 */
const STATIC_ROUTES: Record<string, string> = {
  "/": "index.html", "/index.html": "index.html",
  "/ipad": "ipad.html", "/ipad.html": "ipad.html",
  "/waku": "waku.html", "/waku.html": "waku.html",
  "/guide": "guide.html", "/guide.html": "guide.html",
};
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  png: "image/png",
};
/* Service Worker: 一度開いたページを端末に保存し、サーバー停止・圏外でも
   開き直せるようにする(ネット優先・失敗時キャッシュ)。当日の保険。 */
const SW_JS = `
const CACHE = "sekigime-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const p = new URL(e.request.url).pathname;
  if (!["/", "/index.html", "/ipad", "/ipad.html", "/waku", "/guide"].includes(p)) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
`;

async function serveStatic(path: string): Promise<Response | null> {
  if (path === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
  }
  if (path === "/sw.js") {
    return new Response(SW_JS, { headers: { "content-type": "text/javascript", "cache-control": "no-cache" } });
  }
  let file = STATIC_ROUTES[path];
  if (!file && path.startsWith("/img/") && /^[\w.-]+$/.test(path.slice(5))) {
    file = path.slice(1);
  }
  if (!file) return null;
  try {
    const data = await Deno.readFile(new URL("./static/" + file, import.meta.url));
    const ext = file.split(".").pop() ?? "";
    return new Response(data, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "x-robots-tag": "noindex, nofollow",
        "cache-control": ext === "png" ? "public, max-age=600" : "public, max-age=60",
      },
    });
  } catch {
    return null;
  }
}

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const path = new URL(req.url).pathname;

    if (req.method === "GET") {
      const st = await serveStatic(path);
      if (st) return st;
    }

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

    // スマホ閲覧用: いまの確定状況(iPadが/syncで丸ごと上書きする掲示板)
    if (path === "/board") {
      return json({ data: await store.getBoard() });
    }

    // ---- ここから幹事用(PIN必須) ----

    // iPad用: 確定状況の丸ごと同期(iPadのlocalStorageが正、サーバーは写し)
    if (path === "/sync" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.pin !== PIN) return json({ error: "PINが違います" }, 403);
      if (JSON.stringify(body.data ?? null).length > 50000) {
        return json({ error: "データが大きすぎます" }, 413);
      }
      await store.setBoard(body.data ?? null);
      return json({ ok: true });
    }

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
        storage: store.kind,
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
