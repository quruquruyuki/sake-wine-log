import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CFG = window.SW_CONFIG;
const sb = createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = id => document.getElementById(id);
const BUCKET = "labels";

let user = null;
let drinks = [];
let photoUrls = {};          // 保存先パス -> 表示用URL
let filterKind = "all";
let editing = null;          // 編集中のレコード（新規は null）
let current = null;          // 詳細表示中のレコード
let photoBlob = null;        // 新しく撮った写真（縮小済み）
let aiRaw = null;
let webRaw = null;           // ネット検索の結果
let state = {};              // チップ・スケール・評価の値

const COLOR = { red: "赤", white: "白", rose: "ロゼ", sparkling: "泡" };
const KIND = { wine: "ワイン", sake: "日本酒", shochu: "焼酎", beer: "ビール" };
const GLYPH = { wine: "葡", sake: "酒", shochu: "焼", beer: "麦" };
const LABELS = {
  wine:   { producer: "生産者・ワイナリー", region: "地域", body: ["軽い", "重い"] },
  sake:   { producer: "蔵元", region: "都道府県", body: ["淡麗", "濃醇"] },
  shochu: { producer: "蔵元", region: "都道府県", body: ["すっきり", "濃厚"] },
  beer:   { producer: "醸造所", region: "地域", body: ["軽い", "コク"] },
};
const CHIP_KEYS = ["wine_color", "serve_temp", "ingredient", "distillation"];
const SCALE_KEYS = ["sweetness", "body", "bitterness"];

/* ---------- util ---------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2200); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : ""; }
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function fmtDate(s) { if (!s) return ""; const [y, m, d] = s.split("-"); return `${y}.${m}.${d}`; }
function numOrNull(v) { const n = parseFloat(String(v ?? "").replace(/[^\d.]/g, "")); return Number.isFinite(n) && n < 100 ? n : null; }
function intOrNull(v) { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return Number.isFinite(n) ? n : null; }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }
function strOrNull(v) { const s = String(v ?? "").trim(); return s ? s : null; }

// 写真を長辺 max px のJPEGに縮小（保存用 1024px、一覧用サムネイル 360px）
async function shrink(file, max = 1024, quality = 0.8) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  let w, h, draw;
  if (bmp) { w = bmp.width; h = bmp.height; draw = ctx => ctx.drawImage(bmp, 0, 0, cw, ch); }
  else {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = img.naturalWidth; h = img.naturalHeight; draw = ctx => ctx.drawImage(img, 0, 0, cw, ch);
  }
  const s = Math.min(1, max / Math.max(w, h));
  var cw = Math.round(w * s), ch = Math.round(h * s);
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  draw(c.getContext("2d"));
  return await new Promise(r => c.toBlob(r, "image/jpeg", quality));
}
function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
}

/* ---------- photo URLs ---------- */
// 表示用URLは7日有効。端末に覚えておき、同じURLを使い回すことでブラウザのキャッシュが効く（通信量の節約）
const URL_KEY = "swl-urls";
const URL_TTL = 60 * 60 * 24 * 7;
function urlCache() { try { return JSON.parse(localStorage.getItem(URL_KEY) || "{}"); } catch { return {}; } }
function saveUrlCache(c) { try { localStorage.setItem(URL_KEY, JSON.stringify(c)); } catch {} }
async function ensureUrls(paths) {
  const now = Date.now(), cache = urlCache(), need = [];
  for (const p of new Set(paths.filter(Boolean))) {
    if (photoUrls[p]) continue;
    const c = cache[p];
    if (c && c.e > now + 864e5) photoUrls[p] = c.u; else need.push(p);
  }
  if (need.length) {
    const { data } = await sb.storage.from(BUCKET).createSignedUrls(need, URL_TTL);
    (data || []).forEach(u => { if (u.signedUrl) { photoUrls[u.path] = u.signedUrl; cache[u.path] = { u: u.signedUrl, e: now + URL_TTL * 1000 }; } });
    for (const k of Object.keys(cache)) if (cache[k].e < now) delete cache[k];
    saveUrlCache(cache);
  }
}
const thumbOf = d => d.thumb_path || d.photo_path;

async function uploadPhoto(blob) {
  const id = uid();
  const path = `${user.id}/${id}.jpg`, thumb = `${user.id}/${id}_t.jpg`;
  const tblob = await shrink(blob, 360, 0.72);
  const opt = { contentType: "image/jpeg", cacheControl: "604800" };
  const [a, b] = await Promise.all([sb.storage.from(BUCKET).upload(path, blob, opt), sb.storage.from(BUCKET).upload(thumb, tblob, opt)]);
  if (a.error) throw a.error;
  if (b.error) throw b.error;
  photoUrls[path] = URL.createObjectURL(blob); photoUrls[thumb] = URL.createObjectURL(tblob);
  return { photo_path: path, thumb_path: thumb };
}
function removePhotos(d) { const ps = [d.photo_path, d.thumb_path].filter(Boolean); if (ps.length) sb.storage.from(BUCKET).remove(ps); }

// サムネイルがない古い記録に、あとからサムネイルを作る
let backfilling = false;
async function backfillThumbs() {
  if (backfilling) return; backfilling = true;
  try {
    for (const d of drinks.filter(x => x.photo_path && !x.thumb_path)) {
      await ensureUrls([d.photo_path]);
      const blob = await fetch(photoUrls[d.photo_path]).then(r => r.ok ? r.blob() : null).catch(() => null);
      if (!blob) continue;
      const tblob = await shrink(blob, 360, 0.72);
      const thumb = d.photo_path.replace(/\.jpg$/, "") + "_t.jpg";
      const { error } = await sb.storage.from(BUCKET).upload(thumb, tblob, { contentType: "image/jpeg", cacheControl: "604800", upsert: true });
      if (error) continue;
      const { error: e2 } = await sb.from("drinks").update({ thumb_path: thumb }).eq("id", d.id);
      if (!e2) { d.thumb_path = thumb; photoUrls[thumb] = URL.createObjectURL(tblob); }
    }
    renderList();
  } finally { backfilling = false; }
}

/* ---------- data ---------- */
async function load() {
  const { data, error } = await sb.from("drinks").select("*").order("drank_on", { ascending: false }).order("created_at", { ascending: false });
  if (error) { toast("読み込みに失敗しました"); console.error(error); return; }
  drinks = data;
  await ensureUrls(drinks.map(thumbOf));
  renderList();
  fillShops();
  backfillThumbs();
}

function fillShops() {
  const shops = [...new Set(drinks.map(d => d.shop).filter(Boolean))];
  $("shops").innerHTML = shops.map(s => `<option value="${esc(s)}">`).join("");
}

/* ---------- list ---------- */
function subline(d, withPlace) {
  const parts = {
    wine: [COLOR[d.wine_color], withPlace && d.country, d.vintage],
    sake: [d.sake_grade, withPlace && d.region],
    shochu: [d.ingredient && d.ingredient + (d.ingredient === "泡盛" ? "" : "焼酎"), withPlace && d.region],
    beer: [d.beer_style, withPlace && d.country],
  }[d.kind] || [];
  return parts.filter(Boolean).join(" · ");
}
function renderList() {
  const q = $("q").value.trim().toLowerCase();
  let rows = drinks.filter(d => filterKind === "all" || d.kind === filterKind);
  if (q) rows = rows.filter(d => [d.name, d.producer, d.country, d.region, d.shop, d.place, d.grape, d.sake_grade, d.rice, d.ingredient, d.koji, d.beer_style, d.memo, d.description].join(" ").toLowerCase().includes(q));
  const sort = $("sort").value;
  if (sort === "rating") rows = [...rows].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  if (sort === "again") rows = rows.filter(d => d.buy_again);

  $("count").textContent = drinks.length ? `${rows.length} 本` : "";
  $("empty").classList.toggle("hidden", drinks.length > 0);
  $("grid").innerHTML = rows.map(d => {
    const url = thumbOf(d) && photoUrls[thumbOf(d)];
    const sub = subline(d, true);
    return `<button class="item" data-id="${d.id}" type="button">
      <div class="thumb" style="${url ? `background-image:url('${url}')` : ""}">
        ${url ? "" : `<div class="ph">${GLYPH[d.kind] || "酒"}</div>`}
        <span class="tag ${d.kind}">${KIND[d.kind]}</span>
        ${d.buy_again ? `<span class="again">また買う</span>` : ""}
      </div>
      <h3>${esc(d.name)}</h3>
      <p>${esc(sub) || "&nbsp;"}</p>
      <p><span class="stars">${stars(d.rating)}</span> ${fmtDate(d.drank_on)}</p>
    </button>`;
  }).join("");
}
$("grid").onclick = e => { const b = e.target.closest(".item"); if (b) openDetail(drinks.find(d => d.id === b.dataset.id)); };
$("kindFilter").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  filterKind = b.dataset.k;
  [...$("kindFilter").children].forEach(x => x.classList.toggle("on", x === b));
  renderList();
};
$("sort").onchange = renderList;
$("q").oninput = renderList;

/* ---------- form widgets ---------- */
function buildScale(key) {
  const el = document.querySelector(`[data-scale="${key}"] .dots`);
  el.innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n}"></button>`).join("");
  el.onclick = e => { const b = e.target.closest("button"); if (!b) return; const n = +b.dataset.n; state[key] = state[key] === n ? null : n; paintScale(key); };
}
function paintScale(key) { document.querySelectorAll(`[data-scale="${key}"] .dots button`).forEach(b => b.classList.toggle("on", +b.dataset.n === state[key])); }
function buildRate() {
  $("rate").innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}">★</button>`).join("");
  $("rate").onclick = e => { const b = e.target.closest("button"); if (!b) return; const n = +b.dataset.n; state.rating = state.rating === n ? null : n; paintRate(); };
}
function paintRate() { [...$("rate").children].forEach(b => b.classList.toggle("on", +b.dataset.n <= (state.rating || 0))); }
document.querySelectorAll("[data-chips]").forEach(box => {
  box.onclick = e => { const b = e.target.closest("button"); if (!b) return; const k = box.dataset.chips; state[k] = state[k] === b.dataset.v ? null : b.dataset.v; paintChips(k); };
});
function paintChips(k) { document.querySelectorAll(`[data-chips="${k}"] button`).forEach(b => b.classList.toggle("on", b.dataset.v === state[k])); }
document.querySelectorAll(".kindsw button").forEach(b => b.onclick = () => setKind(b.dataset.kind));
function setKind(k) {
  state.kind = k;
  document.querySelectorAll(".kindsw button").forEach(b => b.classList.toggle("on", b.dataset.kind === k));
  ["wine", "sake", "shochu", "beer"].forEach(x => document.querySelectorAll(".only-" + x).forEach(el => el.classList.toggle("hidden", k !== x)));
  const L = LABELS[k];
  $("lbProducer").textContent = L.producer;
  $("lbRegion").textContent = L.region;
  $("bodyL").textContent = L.body[0]; $("bodyR").textContent = L.body[1];
  document.querySelector('[data-scale="sweetness"]').classList.toggle("hidden", k === "beer");
  document.querySelector('[data-scale="bitterness"]').classList.toggle("hidden", k !== "beer");
}
SCALE_KEYS.forEach(buildScale); buildRate();

const F = () => $("form").elements;
const TEXT_FIELDS = ["name", "producer", "country", "region", "grape", "vintage", "sake_grade", "polish_ratio", "rice", "koji", "beer_style", "description", "memo", "price", "shop", "place", "drank_on"];
const WEB_FIELDS = ["name", "producer", "country", "region", "grape", "vintage", "sake_grade", "polish_ratio", "rice", "koji", "beer_style", "description"];
const abvInput = () => (state.kind === "beer" ? F().abv_beer : F().abv);

function fillForm(d, fromAi = false) {
  const f = F();
  TEXT_FIELDS.forEach(k => {
    if (fromAi && !(k in d)) return;
    const v = d[k];
    if (fromAi && (v === null || v === undefined || v === "")) return;
    f[k].value = v ?? "";
    f[k].classList.toggle("ai", fromAi);
  });
  if (!fromAi) { f.buy_again.checked = !!d.buy_again; state.sources = d.sources || null; webRaw = null; renderSources(); }
  $("descWrap").classList.toggle("hidden", !f.description.value);
  [...CHIP_KEYS, ...SCALE_KEYS, "rating"].forEach(k => { if (!fromAi || d[k] != null) state[k] = d[k] ?? null; });
  if (KIND[d.kind]) setKind(d.kind);
  if (d.abv != null && d.abv !== "") { const el = abvInput(); el.value = d.abv; el.classList.toggle("ai", fromAi); }
  CHIP_KEYS.forEach(paintChips); SCALE_KEYS.forEach(paintScale); paintRate();
}
document.querySelectorAll("#form input, #form textarea").forEach(el => el.addEventListener("input", () => el.classList.remove("ai")));

/* ---------- add / edit ---------- */
function resetEdit() {
  photoBlob = null; aiRaw = null; state = {};
  $("form").reset();
  document.querySelectorAll("#form .ai").forEach(el => el.classList.remove("ai"));
  $("photo").value = "";
  $("preview").removeAttribute("src");
  ["photoWrap", "reading", "aiNote", "form", "saveBar", "aiMark", "reRead", "webReading", "webNote", "descWrap", "srcList"].forEach(id => $(id).classList.add("hidden"));
  $("aiNote").classList.remove("err"); $("webNote").classList.remove("err");
  webRaw = null; $("webBtn").disabled = false;
  webCandidates = []; renderCandidates();
  CHIP_KEYS.forEach(paintChips); SCALE_KEYS.forEach(paintScale); paintRate();
  $("shotBox").classList.remove("hidden"); $("manual").classList.remove("hidden");
}
function showForm() {
  $("form").classList.remove("hidden"); $("saveBar").classList.remove("hidden"); $("manual").classList.add("hidden");
  if (!state.kind) setKind("wine");
}
function openAdd() {
  editing = null; resetEdit();
  $("editTitle").textContent = "記録する";
  F().drank_on.value = today();
  $("edit").classList.remove("hidden"); $("edit").scrollTop = 0;
}
async function openEdit(d) {
  editing = d; resetEdit();
  if (d.photo_path) await ensureUrls([d.photo_path]);
  $("editTitle").textContent = "編集";
  fillForm(d);
  const url = d.photo_path && photoUrls[d.photo_path];
  $("shotBox").classList.add("hidden");
  $("photoWrap").classList.remove("hidden");
  if (url) $("preview").src = url; else { $("photoWrap").classList.add("hidden"); $("shotBox").classList.remove("hidden"); }
  showForm();
  $("detail").classList.add("hidden");
  $("edit").classList.remove("hidden"); $("edit").scrollTop = 0;
}
$("fab").onclick = openAdd;
$("editClose").onclick = () => { $("edit").classList.add("hidden"); if (editing) openDetail(editing); };
$("manual").onclick = showForm;
$("rePhoto").onclick = () => $("photo").click();
$("reRead").onclick = () => readLabel();

$("photo").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try { photoBlob = await shrink(file, 1024, 0.8); } catch { toast("写真を読み込めませんでした"); return; }
  $("preview").src = URL.createObjectURL(photoBlob);
  $("shotBox").classList.add("hidden"); $("photoWrap").classList.remove("hidden");
  if (editing) { showForm(); $("reRead").classList.remove("hidden"); return; } // 編集中は写真の差し替えだけ
  showForm();
  readLabel();
};

async function readLabel() {
  if (!photoBlob) return;
  $("reading").classList.remove("hidden"); $("aiNote").classList.add("hidden"); $("aiNote").classList.remove("err");
  $("reRead").classList.add("hidden");
  try {
    const image = await blobToBase64(photoBlob);
    const { data, error } = await sb.functions.invoke("read-label", { body: { image, mediaType: "image/jpeg" } });
    if (error) {
      let msg = "読み取りに失敗しました。手で入力してください。";
      try { const j = await error.context.json(); if (j.error) msg = j.error + "。手で入力してください。"; } catch {}
      throw new Error(msg);
    }
    const r = data.result || {};
    if (r.error) throw new Error(r.error + "。手で入力してください。");
    aiRaw = r;
    const mapped = { ...r };
    if (!KIND[mapped.kind]) delete mapped.kind;
    mapped.vintage = intOrNull(r.vintage); mapped.polish_ratio = intOrNull(r.polish_ratio);
    SCALE_KEYS.forEach(k => { const n = intOrNull(r[k]); mapped[k] = n >= 1 && n <= 5 ? n : null; });
    if (!COLOR[mapped.wine_color]) mapped.wine_color = null;
    mapped.abv = numOrNull(r.abv);
    fillForm(mapped, true);
    $("aiMark").classList.remove("hidden");
    const notes = ["黄色の項目はAIが入力しました。違っていたら直してください。"];
    if (mapped.sweetness || mapped.body || mapped.bitterness) notes.push("味わいは銘柄の一般的な傾向です。自分の感じ方で直してください。");
    if (r.note) notes.push("AIのメモ：" + r.note);
    $("aiNote").innerHTML = notes.map(esc).join("<br>");
    $("aiNote").classList.remove("hidden");
  } catch (err) {
    $("aiNote").textContent = err.message || "読み取りに失敗しました。手で入力してください。";
    $("aiNote").classList.add("err"); $("aiNote").classList.remove("hidden");
  } finally {
    $("reading").classList.add("hidden");
    $("reRead").classList.remove("hidden");
  }
}

function renderSources() {
  const list = state.sources || [];
  $("srcList").classList.toggle("hidden", !list.length);
  $("srcList").innerHTML = list.length ? `<b>参考にしたページ</b>` + list.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join("") : "";
}

// ネットで調べた結果（または選んだ候補）を欄に入れる。自分で入力した欄（黄色でない欄）は上書きしない
function applyWeb(r, { force = false } = {}) {
  const f = F();
  let filled = 0;
  WEB_FIELDS.forEach(k => {
    let v = r[k];
    if (k === "vintage" || k === "polish_ratio") v = intOrNull(v);
    if (v === null || v === undefined || v === "") return;
    const el = f[k];
    if (el.value.trim() && !el.classList.contains("ai")) return;
    if (String(el.value) !== String(v)) filled++;
    el.value = v; el.classList.add("ai");
  });
  if (state.kind === "wine" && COLOR[r.wine_color] && (!state.wine_color || force)) { state.wine_color = r.wine_color; paintChips("wine_color"); filled++; }
  ["ingredient", "distillation"].forEach(k => { if (r[k] && (!state[k] || force) && document.querySelector(`[data-chips="${k}"] [data-v="${r[k]}"]`)) { state[k] = r[k]; paintChips(k); filled++; } });
  { const a = numOrNull(r.abv), el = abvInput(); if (a != null && (!el.value.trim() || el.classList.contains("ai"))) { el.value = a; el.classList.add("ai"); filled++; } }
  SCALE_KEYS.forEach(k => { const n = intOrNull(r[k]); if (n >= 1 && n <= 5) { state[k] = n; paintScale(k); } });
  $("descWrap").classList.toggle("hidden", !f.description.value);
  return filled;
}

let webCandidates = [];
function renderCandidates(picked = -1) {
  const box = $("candList");
  box.classList.toggle("hidden", !webCandidates.length);
  if (!webCandidates.length) { box.innerHTML = ""; return; }
  const kindNow = state.kind;
  box.innerHTML = `<b>どの商品ですか？タップすると精米歩合などを入れます</b>` + webCandidates.map((c, i) => {
    const spec = kindNow === "sake" ? [c.sake_grade, c.polish_ratio && `精米${c.polish_ratio}%`, c.rice, c.abv && `${c.abv}度`]
      : kindNow === "wine" ? [c.grape, c.vintage, c.abv && `${c.abv}%`]
      : kindNow === "shochu" ? [c.ingredient, c.koji, c.abv && `${c.abv}度`]
      : [c.beer_style, c.abv && `${c.abv}%`];
    return `<button type="button" class="cand${i === picked ? " on" : ""}" data-i="${i}"><strong>${esc(c.name)}</strong><span>${esc(spec.filter(Boolean).join(" · "))}</span></button>`;
  }).join("");
}
$("candList").onclick = e => {
  const b = e.target.closest(".cand"); if (!b) return;
  const i = +b.dataset.i, c = webCandidates[i];
  const f = F();
  // 候補を選んだときは、AIが入れた欄（黄色）を候補の値で置き換える。商品固有でない欄は消さない
  applyWeb(c, { force: true });
  if (c.description && (!f.description.value.trim() || f.description.classList.contains("ai"))) { f.description.value = c.description; f.description.classList.add("ai"); $("descWrap").classList.remove("hidden"); }
  renderCandidates(i);
  toast("「" + c.name + "」の情報を入れました");
};

async function labelImageForWeb() {
  try {
    let blob = photoBlob;
    if (!blob && editing?.photo_path) {
      await ensureUrls([editing.photo_path]);
      blob = await fetch(photoUrls[editing.photo_path]).then(r => r.ok ? r.blob() : null);
    }
    if (!blob) return null;
    return await blobToBase64(await shrink(blob, 768, 0.75));
  } catch { return null; }
}

$("webBtn").onclick = async () => {
  const f = F();
  if (!f.name.value.trim()) { toast("先に銘柄名を入れてください"); f.name.focus(); return; }
  const drink = { kind: state.kind || "wine" };
  ["name", "producer", "country", "region", "grape", "vintage", "sake_grade", "polish_ratio", "rice", "koji", "beer_style"].forEach(k => { const v = f[k].value.trim(); if (v) drink[k] = v; });
  ["wine_color", "ingredient", "distillation"].forEach(k => { if (state[k]) drink[k] = state[k]; });
  if (abvInput().value.trim()) drink.abv = abvInput().value.trim();
  $("webBtn").disabled = true;
  $("webReading").classList.remove("hidden"); $("webNote").classList.add("hidden"); $("webNote").classList.remove("err");
  webCandidates = []; renderCandidates();
  try {
    const image = await labelImageForWeb();
    const { data, error } = await sb.functions.invoke("research-drink", { body: image ? { drink, image } : { drink } });
    if (error) {
      let msg = "調べるのに失敗しました。";
      try { const j = await error.context.json(); if (j.error) msg = j.error + "。"; } catch {}
      throw new Error(msg);
    }
    const r = data.result || {};
    webRaw = r;
    const filled = applyWeb(r);
    state.sources = r.sources?.length ? r.sources : state.sources;
    renderSources();
    webCandidates = Array.isArray(r.candidates) ? r.candidates : [];
    renderCandidates();
    const notes = [];
    if (webCandidates.length) notes.push(`同じ名前の商品が${webCandidates.length}つ見つかりました。下の候補から選ぶと、精米歩合などが入ります。`);
    else notes.push(filled || f.description.value ? "ネットで調べた内容を黄色の欄に入れました。自分で入力した欄はそのままです。" : "新しく分かったことはありませんでした。");
    if (r.note) notes.push("AIのメモ：" + r.note);
    if (!r.sources?.length) notes.push("参考にしたページを確認できなかったので、内容は念のため見直してください。");
    $("webNote").innerHTML = notes.map(esc).join("<br>");
    $("webNote").classList.remove("hidden");
  } catch (err) {
    $("webNote").textContent = err.message || "調べるのに失敗しました。";
    $("webNote").classList.add("err"); $("webNote").classList.remove("hidden");
  } finally {
    $("webReading").classList.add("hidden"); $("webBtn").disabled = false;
  }
};

$("saveBtn").onclick = async () => {
  const f = F();
  if (!f.name.value.trim()) { toast("銘柄名を入れてください"); f.name.focus(); return; }
  $("saveBtn").disabled = true; $("saveBtn").textContent = "保存中…";
  try {
    const k = state.kind || "wine";
    const row = {
      kind: k,
      name: f.name.value.trim(),
      producer: strOrNull(f.producer.value), country: strOrNull(f.country.value), region: strOrNull(f.region.value),
      wine_color: k === "wine" ? state.wine_color ?? null : null,
      grape: k === "wine" ? strOrNull(f.grape.value) : null,
      vintage: k === "wine" ? intOrNull(f.vintage.value) : null,
      sake_grade: k === "sake" ? strOrNull(f.sake_grade.value) : null,
      polish_ratio: k === "sake" ? intOrNull(f.polish_ratio.value) : null,
      rice: k === "sake" ? strOrNull(f.rice.value) : null,
      serve_temp: k !== "wine" ? state.serve_temp ?? null : null,
      ingredient: k === "shochu" ? state.ingredient ?? null : null,
      koji: k === "shochu" ? strOrNull(f.koji.value) : null,
      distillation: k === "shochu" ? state.distillation ?? null : null,
      beer_style: k === "beer" ? strOrNull(f.beer_style.value) : null,
      abv: k === "shochu" ? numOrNull(f.abv.value) : k === "beer" ? numOrNull(f.abv_beer.value) : null,
      sweetness: k !== "beer" ? state.sweetness ?? null : null, body: state.body ?? null,
      bitterness: k === "beer" ? state.bitterness ?? null : null, rating: state.rating ?? null,
      memo: strOrNull(f.memo.value), price: intOrNull(f.price.value),
      shop: strOrNull(f.shop.value), place: strOrNull(f.place.value),
      drank_on: f.drank_on.value || today(),
      buy_again: f.buy_again.checked,
      description: strOrNull(f.description.value),
      sources: state.sources?.length ? state.sources : null,
    };
    if (aiRaw) row.ai_raw = aiRaw;
    if (photoBlob) Object.assign(row, await uploadPhoto(photoBlob));
    let saved;
    if (editing) {
      const { data, error } = await sb.from("drinks").update(row).eq("id", editing.id).select().single();
      if (error) throw error;
      if (photoBlob) removePhotos(editing);
      saved = data;
    } else {
      const { data, error } = await sb.from("drinks").insert(row).select().single();
      if (error) throw error;
      saved = data;
    }
    $("edit").classList.add("hidden");
    toast("保存しました");
    await load();
    if (editing) openDetail(drinks.find(d => d.id === saved.id));
  } catch (err) {
    console.error(err); toast("保存に失敗しました");
  } finally {
    $("saveBtn").disabled = false; $("saveBtn").textContent = "保存する";
  }
};

/* ---------- detail ---------- */
function openDetail(d) {
  if (!d) return;
  current = d;
  // まずサムネイルを出し、大きい写真は読み込めたら差し替える
  const url = (d.photo_path && photoUrls[d.photo_path]) || (thumbOf(d) && photoUrls[thumbOf(d)]);
  if (d.photo_path && !photoUrls[d.photo_path]) ensureUrls([d.photo_path]).then(() => {
    const img = document.querySelector("#detailBody .dhero");
    if (current === d && img && photoUrls[d.photo_path]) img.src = photoUrls[d.photo_path];
  });
  const scaleTxt = (n, l, r) => n ? `${l} ${"●".repeat(n)}${"○".repeat(5 - n)} ${r}` : null;
  const L = LABELS[d.kind] || LABELS.wine;
  const place = ["産地", [d.country, d.region].filter(Boolean).join(" / ")];
  const abv = ["度数", d.abv != null ? d.abv + "%" : null];
  const items = {
    wine: [["生産者", d.producer], place, ["色", COLOR[d.wine_color]], ["品種", d.grape], ["ヴィンテージ", d.vintage],
      ["甘さ", scaleTxt(d.sweetness, "辛口", "甘口")], ["重さ", scaleTxt(d.body, ...L.body)]],
    sake: [["蔵元", d.producer], place, ["特定名称", d.sake_grade], ["精米歩合", d.polish_ratio ? d.polish_ratio + "%" : null], ["酒米", d.rice],
      ["甘さ", scaleTxt(d.sweetness, "辛口", "甘口")], ["味の濃さ", scaleTxt(d.body, ...L.body)], ["温度", d.serve_temp]],
    shochu: [["蔵元", d.producer], place, ["原料", d.ingredient], ["麹", d.koji], ["蒸留", d.distillation], abv,
      ["甘さ", scaleTxt(d.sweetness, "辛口", "甘口")], ["味の濃さ", scaleTxt(d.body, ...L.body)], ["飲み方", d.serve_temp]],
    beer: [["醸造所", d.producer], place, ["スタイル", d.beer_style], abv,
      ["苦味", scaleTxt(d.bitterness, "弱", "強")], ["コク", scaleTxt(d.body, ...L.body)], ["飲んだ形", d.serve_temp]],
  }[d.kind] || [];
  items.push(["飲んだ日", fmtDate(d.drank_on)], ["価格", d.price ? d.price.toLocaleString() + "円" : null], ["買った店", d.shop], ["飲んだ場所", d.place]);
  const sub = subline(d, false);
  $("detailBody").innerHTML = `
    ${url ? `<img class="dhero" src="${url}" alt="">` : ""}
    <span class="dkind ${d.kind}">${KIND[d.kind]}</span>${d.buy_again ? ` <span class="dkind" style="background:var(--gold)">また買いたい</span>` : ""}
    <h2 class="dname">${esc(d.name)}</h2>
    <p class="dsub">${esc(sub)}</p>
    ${d.rating ? `<p class="drate">${stars(d.rating)}</p>` : ""}
    ${d.memo ? `<div class="dmemo">${esc(d.memo)}</div>` : ""}
    ${d.description ? `<p class="ddesc">${esc(d.description)}</p>` : ""}
    <dl class="dl">${items.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${d.sources?.length ? `<div class="srcs" style="margin-top:20px"><b>参考にしたページ</b>${d.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a>`).join("")}</div>` : ""}`;
  $("detail").classList.remove("hidden"); $("detail").scrollTop = 0;
}
$("detailClose").onclick = () => $("detail").classList.add("hidden");
$("detailEdit").onclick = () => openEdit(current);
$("detailDelete").onclick = async () => {
  if (!current || !confirm(`「${current.name}」の記録を削除します。元に戻せません。`)) return;
  const { error } = await sb.from("drinks").delete().eq("id", current.id);
  if (error) { toast("削除に失敗しました"); return; }
  removePhotos(current);
  $("detail").classList.add("hidden");
  toast("削除しました");
  load();
};

/* ---------- auth ---------- */
let signUpMode = false;
function showApp(on) {
  $("auth").classList.toggle("hidden", on);
  $("app").classList.toggle("hidden", !on);
  $("fab").classList.toggle("hidden", !on);
}
$("authSwitch").onclick = () => {
  signUpMode = !signUpMode;
  $("authBtn").textContent = signUpMode ? "新規登録" : "ログイン";
  $("authSwitch").textContent = signUpMode ? "登録済みの方はログイン" : "はじめての方は新規登録";
  $("password").autocomplete = signUpMode ? "new-password" : "current-password";
};
$("authForm").onsubmit = async e => {
  e.preventDefault();
  const email = $("email").value.trim(), password = $("password").value;
  $("authBtn").disabled = true;
  try {
    if (signUpMode) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split("#")[0] } });
      if (error) throw error;
      if (!data.session) $("authMsg").textContent = "確認メールを送りました。メール内のリンクを開いたあと、ここに戻ってログインしてください。";
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    $("authMsg").textContent = err.message.includes("Invalid login") ? "メールアドレスかパスワードが違います。" : "エラー：" + err.message;
  } finally { $("authBtn").disabled = false; }
};
$("logout").onclick = async () => { await sb.auth.signOut(); };

let authReady = false;
sb.auth.onAuthStateChange((_ev, session) => {
  const u = session?.user ?? null;
  if (authReady && u?.id === user?.id) return;
  authReady = true;
  user = u;
  showApp(!!user);
  if (user) load(); else { drinks = []; photoUrls = {}; }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
