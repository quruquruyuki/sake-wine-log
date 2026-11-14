// 銘柄名などからネット検索して詳しい情報を集める Edge Function（「ネットで調べる」ボタン用）
// 必要なシークレット: ANTHROPIC_API_KEY
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MODEL = "claude-haiku-5-5";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function buildPrompt(d: Record<string, unknown>) {
  const known = Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => `${k}: ${v}`).join("\n");
  return `次のお酒について、ウェブ検索で調べてください。蔵元・ワイナリー・醸造所の公式サイトや酒販店の商品ページを優先してください。

【分かっている情報】
${known}

調べた結果を、次のJSONだけで返してください（前後に文章を付けない）。
- 検索で確認できなかった項目は null にする。推測では埋めない。
- 別の商品（同じ蔵の別の銘柄など）と取り違えないよう注意し、自信がなければ null にする。
- description は自分の言葉で80〜150字程度にまとめる（サイトの文章をそのまま写さない）。
- sources には実際に参考にしたページのURLとタイトルを最大3件入れる。

{
  "kind": "wine" | "sake" | "shochu" | "beer",
  "name": "正式な銘柄名",
  "producer": "生産者・ワイナリー・蔵元・醸造所",
  "country": "国（日本語）",
  "region": "地域（日本酒・焼酎は都道府県）",
  "wine_color": "red" | "white" | "rose" | "sparkling" | null,
  "grape": "ぶどう品種",
  "vintage": 数字 | null,
  "sake_grade": "特定名称",
  "polish_ratio": 数字 | null,
  "rice": "酒米",
  "ingredient": "芋" | "麦" | "米" | "黒糖" | "そば" | "泡盛" | "その他" | null（焼酎のみ）,
  "koji": "麹の種類（焼酎のみ）",
  "distillation": "常圧" | "減圧" | null（焼酎のみ）,
  "beer_style": "ビールのスタイル",
  "abv": アルコール度数の数字 | null,
  "sweetness": 1〜5（1=辛口, 5=甘口。公表の日本酒度・味の説明などが根拠にあるときだけ）,
  "body": 1〜5（ワイン 1=軽い〜5=重い、日本酒 1=淡麗〜5=濃醇、焼酎 1=すっきり〜5=濃厚、ビール 1=軽い〜5=コク。根拠があるときだけ）,
  "bitterness": 1〜5（ビールのみ。IBUや説明が根拠にあるときだけ）,
  "description": "味わいや特徴の要約",
  "sources": [{"url": "...", "title": "..."}],
  "note": "注意点があれば短く。なければ null"
}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POSTのみ" }, 405);
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY が未設定です" }, 500);

  let drink: Record<string, unknown>;
  try { drink = (await req.json()).drink ?? {}; } catch { return json({ error: "リクエストが読めません" }, 400); }
  const allowed = ["kind", "name", "producer", "country", "region", "wine_color", "grape", "vintage", "sake_grade", "polish_ratio", "rice", "ingredient", "koji", "distillation", "beer_style", "abv"];
  drink = Object.fromEntries(Object.entries(drink).filter(([k, v]) => allowed.includes(k) && String(v ?? "").length < 200));
  if (!drink.name || String(drink.name).trim().length === 0) return json({ error: "銘柄名がありません" }, 400);

  const messages: any[] = [{ role: "user", content: buildPrompt(drink) }];
  const seenUrls = new Set<string>();
  let data: any = null;
  let searches = 0;

  // pause_turn のときは続きを依頼（最大3回）
  for (let i = 0; i < 3; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3, user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" } }],
      }),
    });
    if (!res.ok) {
      console.error("anthropic error", res.status, await res.text());
      return json({ error: `AIの呼び出しに失敗しました（${res.status}）` }, 502);
    }
    data = await res.json();
    searches += data.usage?.server_tool_use?.web_search_requests ?? 0;
    for (const block of data.content ?? []) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.url) seenUrls.add(r.url);
      }
    }
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }

  const text: string = (data?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "調べた結果を解釈できませんでした" }, 502);
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return json({ error: "調べた結果を解釈できませんでした" }, 502); }

  // 実際の検索結果に出てきたURLだけを出典として残す
  const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
  parsed.sources = sources
    .filter((s: any) => s && typeof s.url === "string" && seenUrls.has(s.url))
    .slice(0, 3)
    .map((s: any) => ({ url: s.url, title: String(s.title ?? s.url).slice(0, 120) }));

  return json({ result: parsed, searches });
});
