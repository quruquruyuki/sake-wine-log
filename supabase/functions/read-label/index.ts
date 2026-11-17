// ラベル写真（またはお店のメニュー写真）から銘柄情報を読み取る Edge Function
// 必要なシークレット: ANTHROPIC_API_KEY（Supabaseダッシュボードで設定）
//
// 結果は「決まった入れ物（ツール）」にAIが記入する形で受け取るので、書き方の崩れで失敗しない。
// 安いモデル（label_model）で読めなかったときだけ、賢いモデル（label_retry_model）でもう一度読む。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODEL = "claude-haiku-5-5"; // 共通設定（sake-wine-log/label_model）が読めないときの予備
const DEFAULT_RETRY_MODEL = "claude-sonnet-5-5"; // 共通設定（sake-wine-log/label_retry_model）が読めないときの予備

// ── 全アプリ共通の設定（Supabase の app_settings テーブル）──
// AIモデルや料金単価はここから読む。1分間は使い回す。読めないときは従来の値（Secret・既定値）を使う
const SETTINGS_TTL = 60_000;
let settingsCache: { at: number; map: Record<string, unknown> } | null = null;
async function appSettings(app: string): Promise<Record<string, unknown>> {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL) return settingsCache.map;
  const map: Record<string, unknown> = {};
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const q = `select=app,key,value&app=in.${encodeURIComponent(`("global","${app}")`)}`;
    const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/app_settings?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.ok) for (const row of await r.json()) map[row.app === "global" ? `global.${row.key}` : row.key] = row.value;
    else console.error("app_settings", r.status, await r.text());
  } catch (e) { console.error("app_settings", e); }
  settingsCache = { at: Date.now(), map };
  return map;
}
async function setting(app: string, key: string, fallback: string): Promise<string> {
  const v = (await appSettings(app))[key];
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

const str = { type: ["string", "null"] };
const num = { type: ["number", "null"] };
const scale = { type: ["integer", "null"], minimum: 1, maximum: 5 };

// ラベルの読み取り結果を入れる「入れ物」
const LABEL_TOOL = {
  name: "save_label",
  description: "ラベルから読み取ったお酒の情報を記録する",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "写真にワイン・日本酒・焼酎・ビールのラベルや瓶が写っていれば true" },
      kind: { type: ["string", "null"], enum: ["wine", "sake", "shochu", "beer", null] },
      name: { ...str, description: "銘柄名（ラベル表記どおり。読みが分かれば「梅錦（うめにしき）」のように併記）" },
      producer: { ...str, description: "生産者・ワイナリー・蔵元・醸造所" },
      country: { ...str, description: "国（日本語）" },
      region: { ...str, description: "地域。日本酒・焼酎は都道府県" },
      wine_color: { type: ["string", "null"], enum: ["red", "white", "rose", "sparkling", null] },
      grape: { ...str, description: "ぶどう品種（ワインのみ）" },
      vintage: { type: ["integer", "null"], description: "ヴィンテージの年" },
      sake_grade: { ...str, description: "純米吟醸・純米大吟醸などの特定名称（日本酒のみ。「原酒」「生酒」などは含めない）" },
      polish_ratio: { ...num, description: "精米歩合の数字（%なし）" },
      rice: { ...str, description: "酒米（日本酒のみ）" },
      ingredient: { type: ["string", "null"], enum: ["芋", "麦", "米", "黒糖", "そば", "泡盛", "その他", null], description: "焼酎の主原料" },
      koji: { ...str, description: "黒麹・白麹・黄麹など（焼酎のみ）" },
      distillation: { type: ["string", "null"], enum: ["常圧", "減圧", null] },
      beer_style: { ...str, description: "ピルスナー・IPAなどのスタイル（ビールのみ）" },
      abv: { ...num, description: "アルコール度数の数字。「16度以上17度未満」のように範囲なら下限（16）" },
      sweetness: { ...scale, description: "1=辛口〜5=甘口。銘柄の一般的な傾向。分からなければ null" },
      body: { ...scale, description: "ワイン 軽い〜重い、日本酒 淡麗〜濃醇、焼酎 すっきり〜濃厚、ビール 軽い〜コク。分からなければ null" },
      bitterness: { ...scale, description: "ビールのみ。1=苦味弱い〜5=強い" },
      note: { ...str, description: "読み取りで自信がない点があれば短く" },
    },
    required: ["found"],
  },
};

// メニューの読み取り結果を入れる「入れ物」
const MENU_TOOL = {
  name: "save_menu",
  description: "メニューから読み取ったお酒の一覧を記録する",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "お酒のメニューが写っていれば true" },
      shop: { ...str, description: "店名（メニューに書かれていれば）" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "銘柄名（メニュー表記どおり）" },
            kind: { type: ["string", "null"], enum: ["wine", "sake", "shochu", "beer", null] },
            sake_grade: str, producer: str, region: str,
            price: { ...num, description: "値段（円）。複数サイズがあれば一番小さいもの" },
            size: { ...str, description: "グラス・1合・90mlなど、その値段の量" },
            note: { ...str, description: "メニューに添えられた説明（短く）" },
          },
          required: ["name"],
        },
      },
    },
    required: ["found", "items"],
  },
};

const LABEL_PROMPT = `写真のお酒のラベルを読んで、save_label に記録してください。
- 写真が複数あるときは、すべて同じ1本のお酒の表ラベル・裏ラベルなどです。全部の写真の情報をまとめて1つにします。
- 瓶の側面や裏の小さな文字（原材料名・精米歩合・アルコール分・製造者・日本酒度など）も、読めるものは必ず読み取ります。
- 毛筆や崩し字の銘柄名は、ふりがなやローマ字表記（例：UMENISHIKI）も手がかりにします。
- 読めない・分からない項目は null にします。推測で埋めてよいのは sweetness・body・bitterness だけです。`;

const MENU_PROMPT = `これは居酒屋・レストランなどのお酒のメニューの写真です。
載っているワイン・日本酒・焼酎・ビールを、書かれている順にすべて save_menu に記録してください。
読めない項目は null にし、推測で埋めないでください。`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function ask(apiKey: string, model: string, images: string[], mediaType: string, mode: string) {
  const tool = mode === "menu" ? MENU_TOOL : LABEL_TOOL;
  const intro = images.length > 1 && mode !== "menu" ? `【同じお酒の写真が${images.length}枚あります】\n` : "";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: mode === "menu" ? 3000 : 1000,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{
        role: "user",
        content: [
          ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: mediaType, data } })),
          { type: "text", text: intro + (mode === "menu" ? MENU_PROMPT : LABEL_PROMPT) },
        ],
      }],
    }),
  });
  if (!res.ok) {
    console.error("anthropic error", model, res.status, await res.text());
    return { input: null, error: res.status };
  }
  const data = await res.json();
  const use = (data.content ?? []).find((c: any) => c.type === "tool_use");
  if (!use) console.error("no tool_use", model, JSON.stringify(data).slice(0, 1500));
  return { input: use?.input ?? null, usage: data.usage };
}

// 読み取れたと言えるか（ラベルなら銘柄名、メニューなら1件以上）
const good = (mode: string, r: any) =>
  !!r && r.found !== false && (mode === "menu" ? Array.isArray(r.items) && r.items.length > 0 : !!r.name);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY が未設定です" }, 500);

  let images: string[], mediaType: string, mode = "label";
  try {
    const body = await req.json();
    if (body.mode === "menu") mode = "menu";
    images = Array.isArray(body.images) ? body.images : [body.image];
    mediaType = body.mediaType ?? "image/jpeg";
  } catch {
    return json({ error: "リクエストが読めません" }, 400);
  }
  images = images.filter((x) => typeof x === "string" && x.length >= 100).slice(0, 4);
  if (!images.length) return json({ error: "画像がありません" }, 400);
  if (images.some((x) => x.length > 6_000_000)) return json({ error: "画像が大きすぎます" }, 413);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return json({ error: "画像形式が対応外です" }, 400);

  // まず安いモデルで読む
  const fast = await setting("sake-wine-log", "label_model", DEFAULT_MODEL);
  let r = await ask(apiKey, fast, images, mediaType, mode);
  let used = fast;
  // 読めなかったときだけ、賢いモデルでもう一度
  if (!good(mode, r.input)) {
    const smart = await setting("sake-wine-log", "label_retry_model", DEFAULT_RETRY_MODEL);
    if (smart !== fast) {
      const r2 = await ask(apiKey, smart, images, mediaType, mode);
      if (r2.input && (good(mode, r2.input) || !r.input)) { r = r2; used = smart; }
    }
  }
  if (!r.input) return json({ error: r.error ? `AIの呼び出しに失敗しました（${r.error}）` : "読み取れませんでした" }, 502);

  const result = r.input;
  if (!good(mode, result)) result.error = mode === "menu" ? "メニューが見つかりませんでした" : "ラベルを読み取れませんでした";
  delete result.found;
  return json({ result, model: used, usage: r.usage });
});
