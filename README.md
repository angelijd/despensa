# Despensa 🥫

App de gestão do armário e da geladeira: estoque com validade/vida útil, localização detalhada, lista de compras automática, alertas e pergunta livre com IA.

## Funções

1. **Acabou → lista de compras**: marcar um alimento como "acabou" o coloca automaticamente na lista (sem duplicar).
2. **Lista de compras**: itens automáticos + adição manual. Ao marcar como comprado, o app oferece recadastrar no estoque com validade nova.
3. **Alertas**: validade → aviso **5 dias** antes; vida útil → aviso **2 dias** antes. Vencidos/estragados também aparecem.
4. **Onde está**: cada alimento tem lugar (geladeira/armário/freezer) + localização livre ("embaixo da pia, prateleira do fundo, saco azul e prata"). Busca na aba Despensa ou pergunta em linguagem natural na aba Perguntar.
5. **Dicas inteligentes (aba Perguntar)**: sugestões de consumo que priorizam o que está mais perto de vencer ("que frutas pôr na lancheira?") e checagem de receitas ("tenho ingredientes para bolo de fubá?" → sim/não + o que falta). Quando faltam ingredientes, a resposta traz botões para mandá-los à lista de compras com um toque.
6. **Código de barras**: leitura pela câmera (BarcodeDetector nativo no Chrome/Android, ZXing como fallback no Safari/iOS). O EAN é consultado na Open Food Facts; produtos não encontrados você nomeia uma vez e o app memoriza o EAN para sempre (`ean_cache`).

## Stack (100% gratuita)

- Node.js + Express, no plano **free do Render**
- Banco: **Turso** (libSQL, SQLite na nuvem, plano gratuito) — sem disco persistente
- Rodando local sem Turso, usa arquivo em `./data/despensa.db` automaticamente
- Frontend vanilla (HTML/CSS/JS), mobile-first
- Pergunta livre: API da Anthropic (claude-haiku-4-5) no backend

## Rodar local

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
# http://localhost:3000 (usa banco em arquivo local; defina TURSO_DATABASE_URL para usar a nuvem)
```

> A câmera só funciona em HTTPS ou em `localhost`. No celular, use o deploy no Render.

## Deploy gratuito (Turso + Render free)

### 1. Banco no Turso
1. Crie conta em [app.turso.tech](https://app.turso.tech) (login com GitHub).
2. **Create Database** → nome `despensa` → região `gru` (São Paulo, se disponível) ou a mais próxima.
3. Na página do banco, copie a **URL** (`libsql://despensa-....turso.io`) e gere um **Token** (Create Token / Generate Token), copiando o valor.

### 2. Serviço no Render
1. **New → Web Service**, conecte o repo do GitHub.
   - Build: `npm install` · Start: `node server.js`
   - Instance Type: **Free**
2. **Environment Variables**:
   - `TURSO_DATABASE_URL` = a URL `libsql://...`
   - `TURSO_AUTH_TOKEN` = o token
   - `ANTHROPIC_API_KEY` = chave da Anthropic (só para a aba Perguntar)
3. Deploy. Não precisa de disco: os dados moram no Turso.

### 3. (Opcional) Evitar que o app durma
O plano free do Render hiberna após 15 min sem uso (a 1ª abertura demora ~1 min). Para manter acordado: crie um job gratuito em [cron-job.org](https://cron-job.org) chamando `https://SEU-APP.onrender.com/api/health` a cada 14 minutos.

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `PORT` | não | Porta (Render define sozinho) |
| `TURSO_DATABASE_URL` | em produção | URL `libsql://...` do banco no Turso |
| `TURSO_AUTH_TOKEN` | em produção | Token de acesso do Turso |
| `ANTHROPIC_API_KEY` | só p/ aba Perguntar | Chave da API da Anthropic |

## API

- `GET /api/items?status=estoque&q=&place=` — itens (com `days_left`, `alert`, `expired` calculados)
- `POST /api/items` — cadastrar (`expiry_type`: `validade` + `expiry_date`, ou `vida_util` + `vida_util_dias`)
- `PATCH /api/items/:id` · `DELETE /api/items/:id`
- `POST /api/items/:id/acabou` — marca como acabou + adiciona à lista
- `GET /api/alerts` — perto de vencer/estragar
- `GET/POST /api/shopping` · `PATCH/DELETE /api/shopping/:id` · `POST /api/shopping/clear-done`
- `GET /api/ean/:ean` — cache local → Open Food Facts
- `POST /api/ask` — pergunta livre (Claude); retorna `{answer, missing[]}` — `missing` são ingredientes faltantes para receitas
- `GET /api/health` — usado pelo despertador (cron-job.org)
