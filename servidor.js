// Revisa — servidor da IA (Node 18+, sem dependências)
// O app manda o conteúdo da matéria; este servidor pede o estudo para a IA e devolve em JSON.
// A chave da IA fica SÓ aqui (variável de ambiente), nunca dentro do app.
//
// Rodar:  ANTHROPIC_API_KEY=sua_chave node servidor.js
// Variáveis: ANTHROPIC_API_KEY (obrigatória), MODELO (padrão claude-sonnet-5-5), PORT (padrão 8787),
//            APP_TOKEN (opcional: se definido, o app precisa mandar o mesmo valor no cabeçalho x-app-token)

const http = require("http");

const PORT = process.env.PORT || 8787;
const CHAVE = process.env.ANTHROPIC_API_KEY;
const MODELO = process.env.MODELO || "claude-sonnet-5-5";
const APP_TOKEN = process.env.APP_TOKEN || "";
const MAX_CORPO = 15 * 1024 * 1024; // 15 MB (até 5 fotos reduzidas)
const LIMITE_POR_HORA = 20; // proteção simples contra abuso, por aparelho

const usos = new Map(); // aparelho -> [horários]

function promptEstudo(materia, texto, qtdFotos) {
  return `Você é um professor brasileiro que prepara material de revisão para prova. Matéria: ${materia || "não informada"}.
${qtdFotos ? `As ${qtdFotos} imagens anexadas são fotos de caderno, livro ou slides com o conteúdo.` : ""}
${texto ? `Conteúdo enviado pelo aluno:\n"""\n${texto.slice(0, 40000)}\n"""` : ""}
Crie o material de estudo SOMENTE com base nesse conteúdo, em português do Brasil, linguagem simples.
Responda apenas com um objeto JSON, sem nenhum texto antes ou depois, neste formato:
{"titulo":"assunto principal em até 5 palavras","resumo":["6 a 10 frases curtas; destaque os termos-chave com **asteriscos duplos**"],"flashcards":[{"f":"pergunta curta","v":"resposta curta"}],"quiz":[{"p":"pergunta no estilo de prova","o":["A","B","C","D"],"c":0,"e":"explicação curta de por que a certa é a certa"}]}
Gere de 8 a 12 flashcards e de 6 a 10 perguntas no quiz, com 4 alternativas cada; "c" é o índice (0 a 3) da alternativa correta, variando a posição.
Se o conteúdo estiver ilegível ou não for matéria de estudo, responda {"erro":"explique o problema em uma frase"}.`;
}

function extrairJSON(txt) {
  try { return JSON.parse(txt); } catch {}
  const m = txt.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]); } catch {} }
  const i = txt.indexOf("{"), j = txt.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(txt.slice(i, j + 1)); } catch {} }
  return null;
}

function limpar(r) {
  r.resumo = (Array.isArray(r.resumo) ? r.resumo : []).map(String).filter(Boolean);
  r.flashcards = (Array.isArray(r.flashcards) ? r.flashcards : []).filter((f) => f && f.f && f.v).map((f) => ({ f: String(f.f), v: String(f.v) }));
  r.quiz = (Array.isArray(r.quiz) ? r.quiz : [])
    .filter((q) => q && q.p && Array.isArray(q.o) && q.o.length >= 2)
    .map((q) => ({ p: String(q.p), o: q.o.slice(0, 5).map(String), c: Math.max(0, Math.min(q.o.length - 1, Number(q.c) || 0)), e: String(q.e || "") }));
  r.titulo = String(r.titulo || "Meu estudo").slice(0, 60);
  return r;
}

async function gerarEstudo({ materia, texto, imagens }) {
  const fotos = (Array.isArray(imagens) ? imagens : []).slice(0, 5);
  const conteudo = [
    ...fotos.map((b64) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(b64) } })),
    { type: "text", text: promptEstudo(String(materia || "").slice(0, 100), String(texto || ""), fotos.length) },
  ];
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": CHAVE, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODELO, max_tokens: 6000, messages: [{ role: "user", content: conteudo }] }),
  });
  if (!resp.ok) {
    const det = await resp.text();
    console.error("IA respondeu", resp.status, det.slice(0, 500));
    throw { status: resp.status === 429 ? 429 : 502, erro: resp.status === 429 ? "Muitos pedidos agora. Tente em instantes." : "A IA não respondeu. Tente de novo." };
  }
  const dados = await resp.json();
  const txt = (dados.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const r = extrairJSON(txt);
  if (!r) throw { status: 502, erro: "A resposta veio incompleta. Tente com menos conteúdo." };
  if (r.erro) throw { status: 422, erro: String(r.erro) };
  return limpar(r);
}

function responder(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-app-token, x-aparelho" });
  res.end(b);
}

function podeUsar(aparelho) {
  const agora = Date.now(), lista = (usos.get(aparelho) || []).filter((t) => agora - t < 3600e3);
  if (lista.length >= LIMITE_POR_HORA) return false;
  lista.push(agora); usos.set(aparelho, lista); return true;
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return responder(res, 204, {});
  if (req.method === "GET" && req.url === "/") return responder(res, 200, { ok: true, app: "Revisa", modelo: MODELO });
  if (req.method !== "POST" || req.url !== "/estudo") return responder(res, 404, { erro: "Rota não encontrada." });
  if (APP_TOKEN && req.headers["x-app-token"] !== APP_TOKEN) return responder(res, 401, { erro: "App não autorizado." });
  const aparelho = String(req.headers["x-aparelho"] || req.socket.remoteAddress);
  if (!podeUsar(aparelho)) return responder(res, 429, { erro: "Limite de estudos por hora atingido. Tente mais tarde." });

  let tam = 0; const partes = [];
  req.on("data", (c) => { tam += c.length; if (tam > MAX_CORPO) { responder(res, 413, { erro: "Fotos grandes demais." }); req.destroy(); } else partes.push(c); });
  req.on("end", async () => {
    if (res.writableEnded) return;
    let corpo;
    try { corpo = JSON.parse(Buffer.concat(partes).toString("utf8")); } catch { return responder(res, 400, { erro: "Pedido inválido." }); }
    if (!corpo.texto && !(corpo.imagens || []).length) return responder(res, 400, { erro: "Envie fotos ou o texto da matéria." });
    try { responder(res, 200, await gerarEstudo(corpo)); }
    catch (e) { console.error(e); responder(res, e.status || 500, { erro: e.erro || "Erro inesperado. Tente de novo." }); }
  });
}).listen(PORT, () => {
  if (!CHAVE) console.warn("ATENÇÃO: defina ANTHROPIC_API_KEY antes de usar.");
  console.log(`Servidor do Revisa rodando na porta ${PORT} (modelo ${MODELO})`);
});
