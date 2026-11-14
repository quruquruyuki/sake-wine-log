// ラベル写真から銘柄情報を読み取る Edge Function
// 必要なシークレット: ANTHROPIC_API_KEY（Supabaseダッシュボードで設定）
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "claude-haiku-5-5";

const PROMPT = `あなたはワイン・日本酒・焼酎・ビールのラベルを読むアシスタントです。
写真のラベルから読み取れる情報を、次のJSONだけで返してください（前後に文章を付けない）。
読めない・分からない項目は null にしてください。推測で埋めるのは sweetness・body・bitterness だけにし、それ以外はラベルに書かれていることか、銘柄から確実に分かることだけにします。

{
  "kind": "wine" | "sake" | "shochu" | "beer",
  "name": "銘柄名（ラベル表記どおり。カタカナ読みが分かれば併記してよい）",
  "producer": "生産者・ワイナリー・蔵元・醸造所",
  "country": "国（日本語）",
  "region": "地域（日本酒・焼酎は都道府県）",
  "wine_color": "red" | "white" | "rose" | "sparkling" | null,
  "grape": "ぶどう品種（ワインのみ）",
  "vintage": 数字 | null,
  "sake_grade": "純米大吟醸などの特定名称（日本酒のみ）",
  "polish_ratio": 精米歩合の数字（%なし） | null,
  "rice": "酒米（日本酒のみ）",
  "ingredient": "芋" | "麦" | "米" | "黒糖" | "そば" | "泡盛" | "その他" | null（焼酎のみ。主原料）,
  "koji": "黒麹・白麹・黄麹など（焼酎のみ）",
  "distillation": "常圧" | "減圧" | null（焼酎のみ）,
  "beer_style": "ピルスナー・IPAなどのスタイル（ビールのみ）",
  "abv": アルコール度数の数字（%なし） | null,
  "sweetness": 1〜5（1=辛口, 5=甘口。銘柄の一般的な傾向。分からなければ null）,
  "body": 1〜5（ワイン 1=軽い〜5=重い、日本酒 1=淡麗〜5=濃醇、焼酎 1=すっきり〜5=濃厚、ビール 1=軽い〜5=コクがある。分からなければ null）,
  "bitterness": 1〜5（ビールのみ。1=苦味弱い〜5=強い。スタイルの一般的な傾向。分からなければ null）,
  "note": "読み取りで自信がない点があれば短く。なければ null"
}

写真がワイン・日本酒・焼酎・ビールのラベルでない場合は {"error": "ラベルが見つかりませんでした"} を返してください。`;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ" }, 405);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY が未設定です" }, 500);

  let image: string, mediaType: string;
  try {
    const body = await req.json();
    image = body.image;
    mediaType = body.mediaType ?? "image/jpeg";
  } catch {
    return json({ error: "リクエストが読めません" }, 400);
  }
  if (typeof image !== "string" || image.length < 100) return json({ error: "画像がありません" }, 400);
  if (image.length > 5_000_000) return json({ error: "画像が大きすぎます" }, 413);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) return json({ error: "画像形式が対応外です" }, 400);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    console.error("anthropic error", res.status, detail);
    return json({ error: `AIの呼び出しに失敗しました（${res.status}）` }, 502);
  }

  const data = await res.json();
  const text: string = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "読み取り結果を解釈できませんでした" }, 502);
  try {
    const parsed = JSON.parse(m[0]);
    return json({ result: parsed, usage: data.usage });
  } catch {
    return json({ error: "読み取り結果を解釈できませんでした" }, 502);
  }
});
