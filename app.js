import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const CFG = window.SW_CONFIG;
const sb = createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const $ = id => document.getElementById(id);
const BUCKET = "labels";

let user = null;
let drinks = [];
let photoUrls = {};          // photo_path -> signed URL
let filterKind = "all";
let editing = null;          // 編集中のレコード（新規は null）
let current = null;          // 詳細表示中のレコード
let photoBlob = null;        // 新しく撮った写真（縮小済み）
let aiRaw = null;
let state = {};              // チップ・スケール・評価の値

const COLOR = { red: "赤", white: "白", rose: "ロゼ", sparkling: "泡" };
const KIND = { wine: "ワイン", sake: "日本酒" };

/* ---------- util ---------- */
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("on"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("on"), 2200); }
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function stars(n) { return n ? "★".repeat(n) + "☆".repeat(5 - n) : ""; }
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
function fmtDate(s) { if (!s) return ""; const [y, m, d] = s.split("-"); return `${y}.${m}.${d}`; }
function intOrNull(v) { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return Number.isFinite(n) ? n : null; }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)); }
function strOrNull(v) { const s = String(v ?? "").trim(); return s ? s : null; }

// 写真を長辺1280pxのJPEGに縮小
async function shrink(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  let w, h, draw;
  if (bmp) { w = bmp.width; h = bmp.height; draw = ctx => ctx.drawImage(bmp, 0, 0, cw, ch); }
  else {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
    w = img.naturalWidth; h = img.naturalHeight; draw = ctx => ctx.drawImage(img, 0, 0, cw, ch);
  }
  const s = Math.min(1, 1280 / Math.max(w, h));
  var cw = Math.round(w * s), ch = Math.round(h * s);
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  draw(c.getContext("2d"));
  return await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
}
function blobToBase64(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
}

/* ---------- data ---------- */
async function load() {
  const { data, error } = await sb.from("drinks").select("*").order("drank_on", { ascending: false }).order("created_at", { ascending: false });
  if (error) { toast("読み込みに失敗しました"); console.error(error); return; }
  drinks = data;
  const paths = drinks.map(d => d.photo_path).filter(p => p && !photoUrls[p]);
  if (paths.length) {
    const { data: urls } = await sb.storage.from(BUCKET).createSignedUrls(paths, 60 * 60 * 6);
    (urls || []).forEach(u => { if (u.signedUrl) photoUrls[u.path] = u.signedUrl; });
  }
  renderList();
  fillShops();
}

function fillShops() {
  const shops = [...new Set(drinks.map(d => d.shop).filter(Boolean))];
  $("shops").innerHTML = shops.map(s => `<option value="${esc(s)}">`).join("");
}

/* ---------- list ---------- */
function renderList() {
  const q = $("q").value.trim().toLowerCase();
  let rows = drinks.filter(d => filterKind === "all" || d.kind === filterKind);
  if (q) rows = rows.filter(d => [d.name, d.producer, d.country, d.region, d.shop, d.place, d.grape, d.sake_grade, d.rice, d.memo].join(" ").toLowerCase().includes(q));
  const sort = $("sort").value;
  if (sort === "rating") rows = [...rows].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  if (sort === "again") rows = rows.filter(d => d.buy_again);

  $("count").textContent = drinks.length ? `${rows.length} 本` : "";
  $("empty").classList.toggle("hidden", drinks.length > 0);
  $("grid").innerHTML = rows.map(d => {
    const url = d.photo_path && photoUrls[d.photo_path];
    const sub = d.kind === "wine"
      ? [COLOR[d.wine_color], d.country, d.vintage].filter(Boolean).join(" · ")
      : [d.sake_grade, d.region].filter(Boolean).join(" · ");
    return `<button class="item" data-id="${d.id}" type="button">
      <div class="thumb" style="${url ? `background-image:url('${url}')` : ""}">
        ${url ? "" : `<div class="ph">${d.kind === "wine" ? "葡" : "酒"}</div>`}
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
  document.querySelectorAll(".only-wine").forEach(el => el.classList.toggle("hidden", k !== "wine"));
  document.querySelectorAll(".only-sake").forEach(el => el.classList.toggle("hidden", k !== "sake"));
  $("lbProducer").textContent = k === "sake" ? "蔵元" : "生産者・ワイナリー";
  $("lbRegion").textContent = k === "sake" ? "都道府県" : "地域";
  $("bodyL").textContent = k === "sake" ? "淡麗" : "軽い";
  $("bodyR").textContent = k === "sake" ? "濃醇" : "重い";
}
buildScale("sweetness"); buildScale("body"); buildRate();

const F = () => $("form").elements;
const TEXT_FIELDS = ["name", "producer", "country", "region", "grape", "vintage", "sake_grade", "polish_ratio", "rice", "memo", "price", "shop", "place", "drank_on"];

function fillForm(d, fromAi = false) {
  const f = F();
  TEXT_FIELDS.forEach(k => {
    if (fromAi && !(k in d)) return;
    const v = d[k];
    if (fromAi && (v === null || v === undefined || v === "")) return;
    f[k].value = v ?? "";
    f[k].classList.toggle("ai", fromAi);
  });
  if (!fromAi) f.buy_again.checked = !!d.buy_again;
  ["wine_color", "serve_temp", "sweetness", "body", "rating"].forEach(k => { if (!fromAi || d[k] != null) state[k] = d[k] ?? null; });
  if (d.kind === "wine" || d.kind === "sake") setKind(d.kind);
  ["wine_color", "serve_temp"].forEach(paintChips); paintScale("sweetness"); paintScale("body"); paintRate();
}
document.querySelectorAll("#form input, #form textarea").forEach(el => el.addEventListener("input", () => el.classList.remove("ai")));

/* ---------- add / edit ---------- */
function resetEdit() {
  photoBlob = null; aiRaw = null; state = {};
  $("form").reset();
  document.querySelectorAll("#form .ai").forEach(el => el.classList.remove("ai"));
  $("photo").value = "";
  $("preview").removeAttribute("src");
  ["photoWrap", "reading", "aiNote", "form", "saveBar", "aiMark", "reRead"].forEach(id => $(id).classList.add("hidden"));
  $("aiNote").classList.remove("err");
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
function openEdit(d) {
  editing = d; resetEdit();
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
  try { photoBlob = await shrink(file); } catch { toast("写真を読み込めませんでした"); return; }
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
    if (!["wine", "sake"].includes(mapped.kind)) delete mapped.kind;
    mapped.vintage = intOrNull(r.vintage); mapped.polish_ratio = intOrNull(r.polish_ratio);
    ["sweetness", "body"].forEach(k => { const n = intOrNull(r[k]); mapped[k] = n >= 1 && n <= 5 ? n : null; });
    if (!COLOR[mapped.wine_color]) mapped.wine_color = null;
    fillForm(mapped, true);
    $("aiMark").classList.remove("hidden");
    const notes = ["黄色の項目はAIが入力しました。違っていたら直してください。"];
    if (mapped.sweetness || mapped.body) notes.push("味わいは銘柄の一般的な傾向です。自分の感じ方で直してください。");
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
      serve_temp: k === "sake" ? state.serve_temp ?? null : null,
      sweetness: state.sweetness ?? null, body: state.body ?? null, rating: state.rating ?? null,
      memo: strOrNull(f.memo.value), price: intOrNull(f.price.value),
      shop: strOrNull(f.shop.value), place: strOrNull(f.place.value),
      drank_on: f.drank_on.value || today(),
      buy_again: f.buy_again.checked,
    };
    if (aiRaw) row.ai_raw = aiRaw;
    if (photoBlob) {
      const path = `${user.id}/${uid()}.jpg`;
      const { error } = await sb.storage.from(BUCKET).upload(path, photoBlob, { contentType: "image/jpeg" });
      if (error) throw error;
      row.photo_path = path;
      photoUrls[path] = URL.createObjectURL(photoBlob);
    }
    let saved;
    if (editing) {
      const { data, error } = await sb.from("drinks").update(row).eq("id", editing.id).select().single();
      if (error) throw error;
      if (photoBlob && editing.photo_path) sb.storage.from(BUCKET).remove([editing.photo_path]);
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
  const url = d.photo_path && photoUrls[d.photo_path];
  const scaleTxt = (n, l, r) => n ? `${l} ${"●".repeat(n)}${"○".repeat(5 - n)} ${r}` : null;
  const items = d.kind === "wine" ? [
    ["生産者", d.producer], ["産地", [d.country, d.region].filter(Boolean).join(" / ")], ["色", COLOR[d.wine_color]],
    ["品種", d.grape], ["ヴィンテージ", d.vintage],
    ["甘さ", scaleTxt(d.sweetness, "辛口", "甘口")], ["重さ", scaleTxt(d.body, "軽い", "重い")],
  ] : [
    ["蔵元", d.producer], ["産地", [d.country, d.region].filter(Boolean).join(" / ")], ["特定名称", d.sake_grade],
    ["精米歩合", d.polish_ratio ? d.polish_ratio + "%" : null], ["酒米", d.rice],
    ["甘さ", scaleTxt(d.sweetness, "辛口", "甘口")], ["味の濃さ", scaleTxt(d.body, "淡麗", "濃醇")], ["温度", d.serve_temp],
  ];
  items.push(["飲んだ日", fmtDate(d.drank_on)], ["価格", d.price ? d.price.toLocaleString() + "円" : null], ["買った店", d.shop], ["飲んだ場所", d.place]);
  const sub = d.kind === "wine" ? [COLOR[d.wine_color], d.vintage].filter(Boolean).join(" · ") : [d.sake_grade].filter(Boolean).join("");
  $("detailBody").innerHTML = `
    ${url ? `<img class="dhero" src="${url}" alt="">` : ""}
    <span class="dkind ${d.kind}">${KIND[d.kind]}</span>${d.buy_again ? ` <span class="dkind" style="background:var(--gold)">また買いたい</span>` : ""}
    <h2 class="dname">${esc(d.name)}</h2>
    <p class="dsub">${esc(sub)}</p>
    ${d.rating ? `<p class="drate">${stars(d.rating)}</p>` : ""}
    ${d.memo ? `<div class="dmemo">${esc(d.memo)}</div>` : ""}
    <dl class="dl">${items.filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
  $("detail").classList.remove("hidden"); $("detail").scrollTop = 0;
}
$("detailClose").onclick = () => $("detail").classList.add("hidden");
$("detailEdit").onclick = () => openEdit(current);
$("detailDelete").onclick = async () => {
  if (!current || !confirm(`「${current.name}」の記録を削除します。元に戻せません。`)) return;
  const { error } = await sb.from("drinks").delete().eq("id", current.id);
  if (error) { toast("削除に失敗しました"); return; }
  if (current.photo_path) sb.storage.from(BUCKET).remove([current.photo_path]);
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
