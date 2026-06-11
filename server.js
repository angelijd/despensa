// Despensa — gestão de armário e geladeira (versão 100% gratuita)
// Stack: Node.js + Express + Turso (libSQL, SQLite na nuvem, plano gratuito)
// Sem disco persistente: o banco mora no Turso, então o plano free do Render serve.
// Para rodar local sem Turso, ele usa um arquivo em ./data/despensa.db automaticamente.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@libsql/client");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Turso em produção; arquivo local como fallback para desenvolvimento
const TURSO_URL = process.env.TURSO_DATABASE_URL || "";
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || "";
let db;
if (TURSO_URL) {
  db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  console.log("Banco: Turso (nuvem)");
} else {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = createClient({ url: "file:" + path.join(dir, "despensa.db") });
  console.log("Banco: arquivo local (defina TURSO_DATABASE_URL para usar a nuvem)");
}

// ---------- Schema ----------
async function initDb() {
  await db.batch(
    [
      `CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        ean TEXT,
        place TEXT NOT NULL DEFAULT 'armario',
        location TEXT,
        expiry_type TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        vida_util_dias INTEGER,
        status TEXT NOT NULL DEFAULT 'estoque',
        created_at TEXT NOT NULL,
        finished_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS shopping (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        item_id INTEGER,
        source TEXT NOT NULL DEFAULT 'manual',
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ean_cache (
        ean TEXT PRIMARY KEY,
        name TEXT NOT NULL
      )`,
    ],
    "write"
  );
}

// ---------- Helpers ----------
async function rows(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }));
}

async function run(sql, args = []) {
  return db.execute({ sql, args });
}

function todayISO() {
  const now = new Date();
  const sp = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return sp.toISOString().slice(0, 10);
}

function daysUntil(dateStr) {
  const today = new Date(todayISO() + "T00:00:00");
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

function isValidDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + "T00:00:00"));
}

// Limiar de alerta: validade = 5 dias antes; vida útil = 2 dias antes
function alertInfo(item) {
  const days = daysUntil(item.expiry_date);
  const threshold = item.expiry_type === "vida_util" ? 2 : 5;
  return { days_left: days, alert: days <= threshold, expired: days < 0 };
}

function withComputed(item) {
  return { ...item, ...alertInfo(item) };
}

// Envelopa handlers async para nenhum erro derrubar o servidor
const h = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Erro interno: " + err.message });
  });

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Itens ---
app.get("/api/items", h(async (req, res) => {
  const { status, q, place } = req.query;
  let sql = "SELECT * FROM items WHERE 1=1";
  const args = [];
  if (status) { sql += " AND status = ?"; args.push(status); }
  if (place) { sql += " AND place = ?"; args.push(place); }
  if (q) { sql += " AND (name LIKE ? OR location LIKE ?)"; args.push(`%${q}%`, `%${q}%`); }
  sql += " ORDER BY expiry_date ASC";
  res.json((await rows(sql, args)).map(withComputed));
}));

app.post("/api/items", h(async (req, res) => {
  const { name, ean, place, location, expiry_type, expiry_date, vida_util_dias } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "Informe o nome do alimento." });
  if (!["validade", "vida_util"].includes(expiry_type)) {
    return res.status(400).json({ error: "expiry_type deve ser 'validade' ou 'vida_util'." });
  }

  let finalDate;
  let dias = null;
  if (expiry_type === "validade") {
    if (!isValidDate(expiry_date)) return res.status(400).json({ error: "Informe a data de validade (YYYY-MM-DD)." });
    finalDate = expiry_date;
  } else {
    dias = parseInt(vida_util_dias, 10);
    if (!Number.isFinite(dias) || dias < 0) return res.status(400).json({ error: "Informe a vida útil em dias." });
    const d = new Date(todayISO() + "T00:00:00");
    d.setDate(d.getDate() + dias);
    finalDate = d.toISOString().slice(0, 10);
  }

  const result = await run(
    `INSERT INTO items (name, ean, place, location, expiry_type, expiry_date, vida_util_dias, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'estoque', ?)`,
    [String(name).trim(), ean || null, place || "armario", location || null, expiry_type, finalDate, dias, todayISO()]
  );

  if (ean) {
    await run("INSERT OR REPLACE INTO ean_cache (ean, name) VALUES (?, ?)", [String(ean), String(name).trim()]);
  }

  const id = Number(result.lastInsertRowid);
  const item = (await rows("SELECT * FROM items WHERE id = ?", [id]))[0];
  res.status(201).json(withComputed(item));
}));

app.patch("/api/items/:id", h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = (await rows("SELECT * FROM items WHERE id = ?", [id]))[0];
  if (!item) return res.status(404).json({ error: "Item não encontrado." });

  const b = req.body || {};
  const name = b.name !== undefined ? String(b.name).trim() : item.name;
  const place = b.place !== undefined ? b.place : item.place;
  const location = b.location !== undefined ? b.location : item.location;
  const expiry_type = b.expiry_type !== undefined ? b.expiry_type : item.expiry_type;

  let expiry_date = item.expiry_date;
  let dias = item.vida_util_dias;
  if (expiry_type === "validade" && b.expiry_date !== undefined) {
    if (!isValidDate(b.expiry_date)) return res.status(400).json({ error: "Data de validade inválida." });
    expiry_date = b.expiry_date;
    dias = null;
  } else if (expiry_type === "vida_util" && b.vida_util_dias !== undefined) {
    dias = parseInt(b.vida_util_dias, 10);
    if (!Number.isFinite(dias) || dias < 0) return res.status(400).json({ error: "Vida útil inválida." });
    const base = new Date((item.created_at || todayISO()) + "T00:00:00");
    base.setDate(base.getDate() + dias);
    expiry_date = base.toISOString().slice(0, 10);
  }

  await run(
    `UPDATE items SET name=?, place=?, location=?, expiry_type=?, expiry_date=?, vida_util_dias=? WHERE id=?`,
    [name, place, location, expiry_type, expiry_date, dias, id]
  );
  res.json(withComputed((await rows("SELECT * FROM items WHERE id = ?", [id]))[0]));
}));

// Marcar como "acabou" → entra automaticamente na lista de compras
app.post("/api/items/:id/acabou", h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = (await rows("SELECT * FROM items WHERE id = ?", [id]))[0];
  if (!item) return res.status(404).json({ error: "Item não encontrado." });

  await run("UPDATE items SET status='acabou', finished_at=? WHERE id=?", [todayISO(), id]);

  const existing = await rows("SELECT * FROM shopping WHERE done=0 AND LOWER(name)=LOWER(?)", [item.name]);
  if (existing.length === 0) {
    await run("INSERT INTO shopping (name, item_id, source, done, created_at) VALUES (?, ?, 'auto', 0, ?)", [
      item.name, id, todayISO(),
    ]);
  }
  res.json({ ok: true, added_to_list: existing.length === 0 });
}));

app.delete("/api/items/:id", h(async (req, res) => {
  await run("DELETE FROM items WHERE id = ?", [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

// --- Alertas: perto de estragar ou vencer ---
app.get("/api/alerts", h(async (req, res) => {
  const all = (await rows("SELECT * FROM items WHERE status='estoque' ORDER BY expiry_date ASC")).map(withComputed);
  res.json(all.filter((i) => i.alert));
}));

// --- Lista de compras ---
app.get("/api/shopping", h(async (req, res) => {
  res.json(await rows("SELECT * FROM shopping ORDER BY done ASC, id DESC"));
}));

app.post("/api/shopping", h(async (req, res) => {
  const name = String((req.body || {}).name || "").trim();
  if (!name) return res.status(400).json({ error: "Informe o nome." });
  const existing = await rows("SELECT * FROM shopping WHERE done=0 AND LOWER(name)=LOWER(?)", [name]);
  if (existing.length > 0) return res.status(409).json({ error: "Já está na lista." });
  const result = await run(
    "INSERT INTO shopping (name, item_id, source, done, created_at) VALUES (?, NULL, 'manual', 0, ?)",
    [name, todayISO()]
  );
  const row = (await rows("SELECT * FROM shopping WHERE id = ?", [Number(result.lastInsertRowid)]))[0];
  res.status(201).json(row);
}));

app.patch("/api/shopping/:id", h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = (await rows("SELECT * FROM shopping WHERE id=?", [id]))[0];
  if (!row) return res.status(404).json({ error: "Não encontrado." });
  const done = req.body && req.body.done !== undefined ? (req.body.done ? 1 : 0) : row.done ? 0 : 1;
  await run("UPDATE shopping SET done=? WHERE id=?", [done, id]);
  res.json((await rows("SELECT * FROM shopping WHERE id=?", [id]))[0]);
}));

app.delete("/api/shopping/:id", h(async (req, res) => {
  await run("DELETE FROM shopping WHERE id=?", [parseInt(req.params.id, 10)]);
  res.json({ ok: true });
}));

app.post("/api/shopping/clear-done", h(async (req, res) => {
  await run("DELETE FROM shopping WHERE done=1");
  res.json({ ok: true });
}));

// --- EAN: cache local + Open Food Facts ---
app.get("/api/ean/:ean", h(async (req, res) => {
  const ean = String(req.params.ean).replace(/\D/g, "");
  if (!ean) return res.status(400).json({ error: "EAN inválido." });

  const cached = (await rows("SELECT * FROM ean_cache WHERE ean=?", [ean]))[0];
  if (cached) return res.json({ ean, name: cached.name, source: "cache" });

  try {
    const r = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${ean}.json?fields=product_name,product_name_pt,brands`,
      { headers: { "User-Agent": "DespensaApp/1.0 (app pessoal)" }, signal: AbortSignal.timeout(8000) }
    );
    const data = await r.json();
    if (data && data.status === 1 && data.product) {
      const p = data.product;
      const name = [p.product_name_pt || p.product_name, p.brands ? p.brands.split(",")[0].trim() : null]
        .filter(Boolean)
        .join(" — ");
      if (name) return res.json({ ean, name, source: "openfoodfacts" });
    }
    return res.json({ ean, name: null, source: "not_found" });
  } catch (err) {
    return res.json({ ean, name: null, source: "error" });
  }
}));

// --- Pergunta livre (Claude) ---
app.post("/api/ask", h(async (req, res) => {
  const question = String((req.body || {}).question || "").trim();
  if (!question) return res.status(400).json({ error: "Escreva uma pergunta." });
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: "ANTHROPIC_API_KEY não configurada no servidor." });
  }

  const items = (await rows("SELECT * FROM items ORDER BY expiry_date ASC")).map(withComputed);
  const shopping = await rows("SELECT name, source, done FROM shopping ORDER BY done ASC, id DESC");

  const context = {
    hoje: todayISO(),
    regras_alerta: "validade: alerta a 5 dias ou menos; vida útil: alerta a 2 dias ou menos; days_left negativo = vencido/estragado",
    itens: items.map((i) => ({
      nome: i.name,
      onde: i.place,
      localizacao: i.location,
      tipo: i.expiry_type,
      vence_em: i.expiry_date,
      dias_restantes: i.days_left,
      em_alerta: i.alert,
      vencido: i.expired,
      status: i.status,
    })),
    lista_de_compras: shopping,
  };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 800,
        system: [
          "Você é o assistente da despensa de uma casa em Ribeirão Preto. Responda em português do Brasil, curto e direto.",
          "Para perguntas sobre o estoque (onde está, o que vence, o que falta comprar), use APENAS os dados do JSON. Se perguntarem onde está um alimento, responda com o lugar (geladeira/armário/freezer) E a localização detalhada. Se não estiver cadastrado, diga. Não invente itens. Datas no formato dia/mês.",
          "Para DICAS e SUGESTÕES (ex.: o que pôr na lancheira, o que cozinhar), você pode usar conhecimento culinário geral, mas só sugira alimentos que ESTÃO no estoque — e priorize SEMPRE os com menos dias_restantes ou em_alerta=true, para evitar desperdício. Mencione quantos dias restam.",
          "Para perguntas do tipo 'tenho ingredientes para X?': liste mentalmente os ingredientes típicos da receita, compare com o estoque e responda começando com 'Sim' ou 'Não'. Se faltar algo, diga o que falta. Considere que itens muito básicos (sal, água) podem não estar cadastrados — nesse caso mencione com ressalva, sem incluir em 'faltam'.",
          "FORMATO DA RESPOSTA: responda SOMENTE com um JSON válido, sem markdown e sem texto fora dele, no formato:",
          '{"resposta": "texto da resposta para a pessoa", "faltam": ["ingrediente 1", "ingrediente 2"]}',
          "O campo 'faltam' lista ingredientes/itens que a pessoa NÃO tem e precisaria comprar (nomes curtos, ex.: 'fubá', 'ovos'). Se não faltar nada ou a pergunta não envolver compra, retorne \"faltam\": [].",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `Dados da despensa:\n${JSON.stringify(context, null, 1)}\n\nPergunta: ${question}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    if (data && Array.isArray(data.content)) {
      const text = data.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
      const clean = text.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(clean);
        if (parsed && typeof parsed.resposta === "string") {
          const faltam = Array.isArray(parsed.faltam)
            ? parsed.faltam.map((f) => String(f).trim()).filter(Boolean)
            : [];
          return res.json({ answer: parsed.resposta, missing: faltam });
        }
      } catch {}
      return res.json({ answer: text || "Não consegui formular uma resposta.", missing: [] });
    }
    const msg = data && data.error && data.error.message ? data.error.message : "Resposta inesperada da API.";
    return res.status(502).json({ error: msg });
  } catch (err) {
    return res.status(502).json({ error: "Falha ao consultar a IA: " + err.message });
  }
}));

// Endpoint de saúde — usado pelo "despertador" (cron-job.org) para manter o app acordado
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Despensa rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error("Falha ao iniciar o banco:", err.message);
    process.exit(1);
  });
