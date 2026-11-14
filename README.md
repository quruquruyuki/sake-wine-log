# 酒ログ（sake-wine-log）

ワイン・日本酒・焼酎・ビールの記録アプリ。ラベルを撮るとAI（Claude Haiku 5.5）が銘柄・産地などを読み取り、「ネットで調べる」ボタンでWeb検索して詳しい情報と出典を足せる。感想や買った店は自分で入力する。

- 画面：GitHub Pages（このリポジトリの `index.html` / `app.js`）
- データ：Supabase（テーブル `drinks`、写真は Storage の `labels` バケット。本人の記録だけ読み書きできる設定）
- ラベル読み取り：Edge Function `read-label`、ネット検索：Edge Function `research-drink`（`supabase/functions/`）

## 初回だけ必要な設定

1. Anthropic のAPIキーを作る（console.anthropic.com）
2. Supabase ダッシュボード → Edge Functions → Secrets で `ANTHROPIC_API_KEY` を登録
3. Supabase ダッシュボード → Authentication → URL Configuration の Site URL / Redirect URLs に GitHub Pages のURLを追加

`config.js` には公開用の publishable キーだけを置く。secret キーや APIキーは絶対に入れない。
