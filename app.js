// Despensa — frontend
const $ = (id) => document.getElementById(id);

const state = { view: "estoque", place: "", q: "", scanner: null, scanStream: null };

const PLACE_LABEL = { geladeira: "Geladeira", armario: "Armário", freezer: "Freezer", outro: "Outro" };

// ---------- util ----------
async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Erro inesperado.");
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function expiryPill(item) {
  const d = item.days_left;
  let cls = "", txt = "";
  if (d < 0) { cls = "bad"; txt = item.expiry_type === "vida_util" ? `estragou há ${-d}d` : `venceu há ${-d}d`; }
  else if (d === 0) { cls = "bad"; txt = "vence hoje"; }
  else if (item.alert) { cls = "warn"; txt = `${d}d restantes`; }
  else { txt = `vence ${fmtDate(item.expiry_date)}`; }
  return `<span class="pill ${cls}">${txt}</span>`;
}

// ---------- navegação ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.view = tab.dataset.view;
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $(`view-${state.view}`).classList.add("active");
    refresh();
  });
});

// ---------- estoque ----------
async function renderItems() {
  const params = new URLSearchParams({ status: "estoque" });
  if (state.place) params.set("place", state.place);
  if (state.q) params.set("q", state.q);
  const items = await api(`/api/items?${params}`);

  const list = $("items-list");
  list.innerHTML = items.map((i) => `
    <li class="card" data-id="${i.id}">
      <div class="row1">
        <div>
          <div class="name">${escapeHtml(i.name)}</div>
          <div class="meta"><span class="place">${PLACE_LABEL[i.place] || i.place}</span>${i.location ? " · " + escapeHtml(i.location) : ""}</div>
        </div>
        ${expiryPill(i)}
      </div>
      <div class="actions">
        <button class="btn-sm acabou" data-act="acabou">Acabou 🛒</button>
        <button class="btn-sm" data-act="editar">Editar</button>
        <button class="btn-sm danger" data-act="excluir">Excluir</button>
      </div>
    </li>`).join("");
  $("items-empty").classList.toggle("hidden", items.length > 0);
  $("badge-estoque").textContent = items.length;
  $("badge-estoque").classList.toggle("hidden", items.length === 0);
}

$("items-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  try {
    if (btn.dataset.act === "acabou") {
      const r = await api(`/api/items/${id}/acabou`, { method: "POST" });
      toast(r.added_to_list ? "Movido para a lista de compras 🛒" : "Marcado como acabou (já estava na lista)");
      refresh();
    } else if (btn.dataset.act === "excluir") {
      if (confirm("Excluir este alimento de vez?")) {
        await api(`/api/items/${id}`, { method: "DELETE" });
        refresh();
      }
    } else if (btn.dataset.act === "editar") {
      const items = await api(`/api/items?status=estoque`);
      const item = items.find((x) => String(x.id) === String(id));
      if (item) openSheet(item);
    }
  } catch (err) { toast(err.message); }
});

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); renderItems(); }, 250);
});

$("place-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#place-chips .chip").forEach((c) => c.classList.remove("active"));
  chip.classList.add("active");
  state.place = chip.dataset.place;
  renderItems();
});

// ---------- lista de compras ----------
async function renderShopping() {
  const list = await api("/api/shopping");
  const ul = $("shopping-list");
  ul.innerHTML = list.map((s) => `
    <li class="card shop-item ${s.done ? "done" : ""}" data-id="${s.id}">
      <input type="checkbox" ${s.done ? "checked" : ""} />
      <span class="sname">${escapeHtml(s.name)}</span>
      ${s.source === "auto" ? '<span class="tag-auto">acabou</span>' : ""}
      <button class="btn-sm danger" data-act="del">✕</button>
    </li>`).join("");
  const pending = list.filter((s) => !s.done).length;
  $("shopping-empty").classList.toggle("hidden", list.length > 0);
  $("clear-done").classList.toggle("hidden", !list.some((s) => s.done));
  $("badge-compras").textContent = pending;
  $("badge-compras").classList.toggle("hidden", pending === 0);
}

$("shopping-add").addEventListener("click", addShopping);
$("shopping-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addShopping(); } });
async function addShopping() {
  const name = $("shopping-input").value.trim();
  if (!name) return;
  try {
    await api("/api/shopping", { method: "POST", body: { name } });
    $("shopping-input").value = "";
    renderShopping();
  } catch (err) { toast(err.message); }
}

$("shopping-list").addEventListener("click", async (e) => {
  const li = e.target.closest(".shop-item");
  if (!li) return;
  const id = li.dataset.id;
  try {
    if (e.target.matches('input[type="checkbox"]')) {
      const r = await api(`/api/shopping/${id}`, { method: "PATCH", body: { done: e.target.checked } });
      if (r.done) {
        // Comprou: oferece recadastrar no estoque com validade nova
        if (confirm(`Comprou "${r.name}"? Quer cadastrar no estoque agora?`)) {
          openSheet({ name: r.name });
        }
      }
      renderShopping();
    } else if (e.target.closest('button[data-act="del"]')) {
      await api(`/api/shopping/${id}`, { method: "DELETE" });
      renderShopping();
    }
  } catch (err) { toast(err.message); }
});

$("clear-done").addEventListener("click", async () => {
  await api("/api/shopping/clear-done", { method: "POST" });
  renderShopping();
});

// ---------- alertas ----------
async function renderAlerts() {
  const alerts = await api("/api/alerts");
  $("alerts-list").innerHTML = alerts.map((i) => `
    <li class="card">
      <div class="row1">
        <div>
          <div class="name">${escapeHtml(i.name)}</div>
          <div class="meta"><span class="place">${PLACE_LABEL[i.place] || i.place}</span>${i.location ? " · " + escapeHtml(i.location) : ""}</div>
        </div>
        ${expiryPill(i)}
      </div>
    </li>`).join("");
  $("alerts-empty").classList.toggle("hidden", alerts.length > 0);
  $("badge-alertas").textContent = alerts.length;
  $("badge-alertas").classList.toggle("hidden", alerts.length === 0);
}

// ---------- perguntar (IA) ----------
function addBubble(text, who, thinking = false) {
  const div = document.createElement("div");
  div.className = `bubble ${who}${thinking ? " thinking" : ""}`;
  div.textContent = text;
  $("chat-log").appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "end" });
  return div;
}

async function ask(question) {
  if (!question) return;
  addBubble(question, "user");
  $("ask-input").value = "";
  const wait = addBubble("Pensando…", "bot", true);
  try {
    const r = await api("/api/ask", { method: "POST", body: { question } });
    wait.textContent = r.answer;
    wait.classList.remove("thinking");
    if (Array.isArray(r.missing) && r.missing.length > 0) {
      renderMissing(wait, r.missing);
    }
  } catch (err) {
    wait.textContent = "⚠️ " + err.message;
    wait.classList.remove("thinking");
  }
}

// Faltou ingrediente? Um toque e ele vai pra lista de compras.
function renderMissing(bubble, missing) {
  const box = document.createElement("div");
  box.className = "missing-box";
  const label = document.createElement("div");
  label.className = "missing-label";
  label.textContent = "Adicionar à lista de compras:";
  box.appendChild(label);

  const row = document.createElement("div");
  row.className = "missing-row";
  missing.forEach((name) => {
    const b = document.createElement("button");
    b.className = "chip missing-chip";
    b.textContent = "+ " + name;
    b.addEventListener("click", async () => {
      try {
        await api("/api/shopping", { method: "POST", body: { name } });
        b.textContent = "✓ " + name;
        b.disabled = true;
        renderShopping();
      } catch (err) {
        if (/Já está/.test(err.message)) { b.textContent = "✓ " + name; b.disabled = true; }
        else toast(err.message);
      }
    });
    row.appendChild(b);
  });

  if (missing.length > 1) {
    const all = document.createElement("button");
    all.className = "chip missing-chip all";
    all.textContent = "+ Adicionar tudo";
    all.addEventListener("click", () => {
      row.querySelectorAll(".missing-chip:not(.all):not(:disabled)").forEach((b) => b.click());
      all.disabled = true;
    });
    row.appendChild(all);
  }

  box.appendChild(row);
  bubble.appendChild(box);
  box.scrollIntoView({ behavior: "smooth", block: "end" });
}

$("ask-send").addEventListener("click", () => ask($("ask-input").value.trim()));
$("ask-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ask($("ask-input").value.trim()); } });
document.querySelectorAll(".chips.suggest .chip").forEach((c) =>
  c.addEventListener("click", () => { $("ask-input").value = c.dataset.q; $("ask-input").focus(); })
);

// ---------- sheet de cadastro ----------
function openSheet(prefill = null) {
  stopScanner();
  $("f-editing").value = prefill && prefill.id ? prefill.id : "";
  $("sheet-title").textContent = prefill && prefill.id ? "Editar alimento" : "Cadastrar alimento";
  $("f-name").value = prefill ? prefill.name || "" : "";
  $("f-place").value = prefill && prefill.place ? prefill.place : "armario";
  $("f-location").value = prefill ? prefill.location || "" : "";
  $("f-ean").value = prefill ? prefill.ean || "" : "";
  const type = prefill && prefill.expiry_type ? prefill.expiry_type : "validade";
  setExpiryType(type);
  $("f-date").value = prefill && prefill.expiry_type === "validade" ? prefill.expiry_date : "";
  $("f-dias").value = prefill && prefill.vida_util_dias != null ? prefill.vida_util_dias : "";
  $("scan-status").classList.add("hidden");
  $("sheet").classList.remove("hidden");
  $("sheet-backdrop").classList.remove("hidden");
}

function closeSheet() {
  stopScanner();
  $("sheet").classList.add("hidden");
  $("sheet-backdrop").classList.add("hidden");
}

function setExpiryType(type) {
  $("seg-validade").classList.toggle("active", type === "validade");
  $("seg-vida").classList.toggle("active", type === "vida_util");
  $("wrap-validade").classList.toggle("hidden", type !== "validade");
  $("wrap-vida").classList.toggle("hidden", type !== "vida_util");
  $("sheet").dataset.expiryType = type;
}

$("seg-validade").addEventListener("click", () => setExpiryType("validade"));
$("seg-vida").addEventListener("click", () => setExpiryType("vida_util"));
$("fab").addEventListener("click", () => openSheet());
$("sheet-cancel").addEventListener("click", closeSheet);
$("sheet-backdrop").addEventListener("click", closeSheet);

$("sheet-save").addEventListener("click", async () => {
  const type = $("sheet").dataset.expiryType || "validade";
  const body = {
    name: $("f-name").value.trim(),
    ean: $("f-ean").value || null,
    place: $("f-place").value,
    location: $("f-location").value.trim() || null,
    expiry_type: type,
    expiry_date: $("f-date").value || null,
    vida_util_dias: $("f-dias").value !== "" ? parseInt($("f-dias").value, 10) : null,
  };
  if (!body.name) return toast("Dê um nome ao alimento.");
  if (type === "validade" && !body.expiry_date) return toast("Informe a data de validade.");
  if (type === "vida_util" && (body.vida_util_dias == null || isNaN(body.vida_util_dias))) return toast("Informe a vida útil em dias.");

  try {
    const editing = $("f-editing").value;
    if (editing) {
      await api(`/api/items/${editing}`, { method: "PATCH", body });
      toast("Alimento atualizado ✅");
    } else {
      await api("/api/items", { method: "POST", body });
      toast("Alimento cadastrado ✅");
    }
    closeSheet();
    refresh();
  } catch (err) { toast(err.message); }
});

// ---------- scanner de código de barras ----------
function scanStatus(msg) {
  const el = $("scan-status");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function onEanDetected(ean) {
  stopScanner();
  $("f-ean").value = ean;
  if (navigator.vibrate) navigator.vibrate(80);
  scanStatus(`Código ${ean} lido. Buscando produto…`);
  try {
    const r = await api(`/api/ean/${ean}`);
    if (r.name) {
      $("f-name").value = r.name;
      scanStatus(r.source === "cache" ? "Produto reconhecido (já cadastrado antes) ✅" : "Produto encontrado na Open Food Facts ✅");
    } else {
      scanStatus("Código lido, mas o produto não está na base. Digite o nome uma vez — da próxima ele será reconhecido.");
      $("f-name").focus();
    }
  } catch {
    scanStatus("Código lido. Não consegui consultar a base agora; digite o nome.");
  }
}

$("scan-btn").addEventListener("click", startScanner);
$("scan-stop").addEventListener("click", stopScanner);

async function startScanner() {
  $("scanner-wrap").classList.remove("hidden");
  const video = $("scanner-video");
  try {
    // 1ª opção: BarcodeDetector nativo (Chrome/Android)
    if ("BarcodeDetector" in window) {
      const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e"] });
      state.scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" }, audio: false,
      });
      video.srcObject = state.scanStream;
      await video.play();
      state.scanner = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length > 0) onEanDetected(codes[0].rawValue);
        } catch {}
      }, 350);
      scanStatus("Aponte a câmera para o código de barras…");
      return;
    }
    // 2ª opção: ZXing (Safari/iOS e outros)
    if (window.ZXing) {
      const reader = new ZXing.BrowserMultiFormatReader();
      state.scanner = reader;
      scanStatus("Aponte a câmera para o código de barras…");
      reader.decodeFromVideoDevice(undefined, video, (result) => {
        if (result) onEanDetected(result.getText());
      });
      return;
    }
    scanStatus("Este navegador não suporta leitura de código de barras. Digite o nome manualmente.");
  } catch (err) {
    scanStatus("Não consegui acessar a câmera (verifique a permissão e se o site está em HTTPS).");
    $("scanner-wrap").classList.add("hidden");
  }
}

function stopScanner() {
  if (state.scanner) {
    if (typeof state.scanner === "number") clearInterval(state.scanner);
    else if (state.scanner.reset) state.scanner.reset();
    state.scanner = null;
  }
  if (state.scanStream) {
    state.scanStream.getTracks().forEach((t) => t.stop());
    state.scanStream = null;
  }
  const video = $("scanner-video");
  video.srcObject = null;
  $("scanner-wrap").classList.add("hidden");
}

// ---------- refresh geral ----------
async function refresh() {
  try {
    await Promise.all([renderItems(), renderShopping(), renderAlerts()]);
  } catch (err) {
    toast(err.message);
  }
}

const hoje = new Date().toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short", timeZone: "America/Sao_Paulo" });
$("today-label").textContent = hoje;
refresh();
