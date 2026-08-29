// Evalua el RAG de tenant_huberman contra el set de preguntas doradas (data/golden_questions.json).
// Corre 100% local. Mide Hit@K, Recall@K y MRR comparando episode_number esperado vs el que devuelve Supabase.
//
// Uso (Node 20+ carga el .env solo, no hace falta exportar nada):
//   node --env-file=.env src/eval_rag.js                          -> solo recuperacion (barato, ~$0.00002)
//   $env:RAG_JUDGE="1"; node --env-file=.env src/eval_rag.js      -> + relevancia del contexto y groundedness
//   $env:RAG_MODE="vector"; node --env-file=.env src/eval_rag.js  -> baseline Fase 1
//
// El .env necesita OPENAI_API_KEY y SUPABASE_SERVICE_ROLE_KEY.
//
// POR QUE EXISTEN LAS METRICAS DE JUEZ (RAG_JUDGE=1):
// Recall@8 y MRR miden POSICION en el ranking: "¿esta el episodio esperado en el top-8?".
// No miden si lo recuperado SIRVE. En 2026-08 una consulta real devolvio 6/6 fragmentos
// publicitarios (context precision 0%) y el modelo respondio de su conocimiento pretrained
// adjuntando 6 citas que no respaldaban nada — con Recall@8 sin registrar absolutamente nada.
// De ahi estas dos metricas:
//   contextRelevance -> de los K fragmentos recuperados, ¿cuantos sirven para responder?
//   groundedness     -> de las afirmaciones de la respuesta, ¿cuantas se apoyan en el contexto?
//
// Guarda el resultado con timestamp y modo en data/eval_results/ para comparar antes/despues de cada fase.

const fs = require('fs');
const path = require('path');

const OPENAI_KEY = process.env.OPENAI_API_KEY;
// Acepta los nombres que se usaron historicamente en este repo.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
  || process.env.supabase_api_key
  || process.env.SUPABASE_API_KEY;
const MODE = (process.env.RAG_MODE || 'production').toLowerCase();

// Modos:
//   production -> match_kb_published_documents_hybrid_v1  (LA QUE USA EL BOT HOY)
//   hybrid     -> match_kb_documents_hybrid   (legacy Fase 2; OJO: devuelve episode_number NULL,
//                                              por eso reporta 0% desde la migracion de Fase 3)
//   vector     -> match_kb_documents          (baseline Fase 1)
const RPC_BY_MODE = {
  production: 'match_kb_published_documents_hybrid_v1',
  hybrid: 'match_kb_documents_hybrid',
  vector: 'match_kb_documents'
};
const RPC_NAME = RPC_BY_MODE[MODE] || RPC_BY_MODE.production;
// El corpus vivio en el proyecto de la plataforma SaaS hasta el 2026-08-13; desde la
// extraccion standalone tiene proyecto propio. Configurable para no repetir ese error.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_RPC_URL = `${SUPABASE_URL}/rest/v1/rpc/${RPC_NAME}`;
const TENANT_ID = process.env.RAG_TENANT_ID || 'tenant_huberman';
const BRAND_ID = process.env.RAG_BRAND_ID; // marca principal de tenant_huberman
const TOP_K = 8;

// Metricas de juez LLM: opt-in porque cuestan ~3 llamadas extra por pregunta.
const JUDGE = /^(1|true|si|yes)$/i.test(process.env.RAG_JUDGE || '');
const JUDGE_MODEL = process.env.RAG_JUDGE_MODEL || 'gpt-4.1-mini';
const ANSWER_MODEL = process.env.RAG_ANSWER_MODEL || 'gpt-4.1'; // el mismo que usa produccion
// Cuantos fragmentos entran a la respuesta en produccion (Build RAG Context And Citations).
const ANSWER_CHUNKS = 6;

if (!OPENAI_KEY) { console.error('Falta OPENAI_API_KEY.'); process.exit(1); }
if (!SUPABASE_KEY) { console.error('Falta SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1); }

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'golden_questions.json'), 'utf8'));

async function embed(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: [text] })
  });
  const body = await res.json();
  if (!res.ok || !body.data) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data[0].embedding;
}

async function queryKb(embedding, queryText) {
  const payload = { query_embedding: embedding, match_tenant_id: TENANT_ID, match_count: TOP_K };
  if (MODE === 'hybrid') payload.query_text = queryText;
  if (MODE === 'production') {
    // La funcion de produccion exige brand_id y acepta el texto para la mitad full-text del RRF.
    payload.query_text = queryText;
    payload.match_brand_id = BRAND_ID;
    payload.rrf_k = 50;
  }
  const res = await fetch(SUPABASE_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok) {
    const detalle = JSON.stringify(body).slice(0, 300);
    if (res.status === 401) {
      throw new Error(`Supabase 401 en ${SUPABASE_URL}: la SUPABASE_SERVICE_ROLE_KEY es de otro proyecto. ${detalle}`);
    }
    if (res.status === 403 && detalle.includes('TENANT_OR_BRAND_MISMATCH')) {
      throw new Error(`Supabase 403: tenant/brand no existen en ${SUPABASE_URL}. Revisa SUPABASE_URL, TENANT_ID y BRAND_ID. ${detalle}`);
    }
    throw new Error(`Supabase ${res.status}: ${detalle}`);
  }
  return Array.isArray(body) ? body : [];
}

async function chat(model, messages, maxTokens) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages })
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return (body.choices?.[0]?.message?.content || '').trim();
}

function parseJson(text) {
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|```$/g, '').trim()); }
  catch (e) { return null; }
}

// RELEVANCIA DEL CONTEXTO: de los fragmentos recuperados, ¿cuantos ayudan a responder?
// Es la metrica que habria cazado los 6/6 anuncios sin que nadie leyera logs a mano.
async function judgeContextRelevance(question, rows) {
  const chunks = rows.slice(0, ANSWER_CHUNKS);
  if (chunks.length === 0) return { score: 0, useful: 0, total: 0 };
  const listado = chunks
    .map((r, i) => `[${i + 1}] ${String(r.content || '').slice(0, 700)}`)
    .join('\n\n');
  const out = await chat(JUDGE_MODEL, [
    { role: 'system', content: 'Sos un evaluador estricto de sistemas RAG. Para cada fragmento decidis si aporta informacion que ayude a responder la pregunta. Publicidad, patrocinios, intros del podcast, pedidos de suscripcion y saludos NO aportan: son ruido. Responde SOLO un array JSON de booleanos, uno por fragmento, en orden. Ejemplo: [true,false,true]' },
    { role: 'user', content: `Pregunta: ${question}\n\nFragmentos:\n${listado}` }
  ], 200);
  const arr = parseJson(out);
  if (!Array.isArray(arr) || arr.length === 0) return { score: null, useful: null, total: chunks.length };
  const useful = arr.filter(Boolean).length;
  return { score: useful / chunks.length, useful, total: chunks.length };
}

// Genera una respuesta con el MISMO prompt que produccion, para medir groundedness real.
async function generateAnswer(question, rows) {
  const contexto = rows.slice(0, ANSWER_CHUNKS)
    .map((r, i) => `(${i + 1}) ${r.content || ''}`).join('\n\n');
  return chat(ANSWER_MODEL, [
    { role: 'system', content: 'Eres un asistente de conocimiento basado en el podcast Huberman Lab. Responde en espanol, de forma practica y especifica, usando los mecanismos, cifras y protocolos concretos que aparezcan en la INFORMACION DE LA BASE DE CONOCIMIENTO. Usa exclusivamente esa informacion. Nunca inventes cifras, dosis, estudios ni afirmaciones que no esten ahi. Si no alcanza para responder con precision, dilo honestamente.' },
    { role: 'user', content: `INFORMACION DE LA BASE DE CONOCIMIENTO:\n${contexto || '(sin resultados)'}\n\nPREGUNTA: ${question}` }
  ], 700);
}

// GROUNDEDNESS: ¿cada afirmacion de la respuesta se apoya en el contexto, o el modelo la invento?
// Es la metrica que habria cazado la respuesta "excelente" con 6 citas que no la respaldaban.
async function judgeGroundedness(question, answer, rows) {
  const contexto = rows.slice(0, ANSWER_CHUNKS)
    .map((r, i) => `(${i + 1}) ${String(r.content || '').slice(0, 900)}`).join('\n\n');
  const out = await chat(JUDGE_MODEL, [
    { role: 'system', content: 'Sos un evaluador estricto de fundamentacion en sistemas RAG. Extraes las afirmaciones factuales de la respuesta (cifras, dosis, mecanismos, recomendaciones concretas) e indicas cuantas estan respaldadas por el CONTEXTO. Ignora frases de cortesia, preguntas de cierre y generalidades sin contenido factual. Responde SOLO JSON: {"total":N,"respaldadas":M}' },
    { role: 'user', content: `PREGUNTA: ${question}\n\nCONTEXTO:\n${contexto || '(sin resultados)'}\n\nRESPUESTA A EVALUAR:\n${answer}` }
  ], 200);
  const o = parseJson(out);
  if (!o || typeof o.total !== 'number' || typeof o.respaldadas !== 'number') return { score: null, total: null, supported: null };
  if (o.total === 0) return { score: null, total: 0, supported: 0 };
  return { score: o.respaldadas / o.total, total: o.total, supported: o.respaldadas };
}

function evalOne(rows, expectedEpisodes) {
  const gotEpisodes = rows.map(r => r.episode_number).filter(e => e != null);
  const topScore = rows.length ? rows[0].similarity : 0;
  if (expectedEpisodes.length === 0) {
    return { hit: null, rank: null, topScore, gotEpisodes };
  }
  let rank = null;
  for (let i = 0; i < gotEpisodes.length; i++) {
    if (expectedEpisodes.includes(gotEpisodes[i])) { rank = i + 1; break; }
  }
  return { hit: rank !== null, rank, topScore, gotEpisodes };
}

async function main() {
  const results = [];
  let hits = 0, evaluable = 0, mrrSum = 0;

  // RAG_LIMIT=3 corre solo las primeras N preguntas: prueba de humo barata antes
  // de gastar saldo real en las 42 con juez.
  const limite = parseInt(process.env.RAG_LIMIT || '0', 10);
  const preguntas = limite > 0 ? golden.questions.slice(0, limite) : golden.questions;

  for (const q of preguntas) {
    const embedding = await embed(q.question);
    const rows = await queryKb(embedding, q.question);
    const evalResult = evalOne(rows, q.expected_episodes || []);
    const row = { id: q.id, type: q.type, question: q.question, ...evalResult };

    // Recall/MRR solo aplican a preguntas CON ground truth de episodio.
    // Las 'generic' no lo tienen a proposito (a una consulta amplia le sirven muchos
    // episodios distintos); contarlas como MISS deprimiria el recall de forma enganosa.
    const tieneGroundTruth = (q.expected_episodes || []).length > 0;
    if (q.type !== 'offtopic' && tieneGroundTruth) {
      evaluable++;
      if (evalResult.hit) { hits++; mrrSum += 1 / evalResult.rank; }
    }

    if (JUDGE) {
      const rel = await judgeContextRelevance(q.question, rows);
      row.contextRelevance = rel.score;
      row.chunksUtiles = rel.useful;
      row.chunksTotal = rel.total;
      if (q.type !== 'offtopic') {
        const answer = await generateAnswer(q.question, rows);
        const gr = await judgeGroundedness(q.question, answer, rows);
        row.groundedness = gr.score;
        row.afirmaciones = gr.total;
        row.afirmacionesRespaldadas = gr.supported;
      }
    }

    results.push(row);

    let status;
    if (q.type === 'offtopic') status = `topScore=${evalResult.topScore.toFixed(2)} (se espera bajo)`;
    else if (!tieneGroundTruth) status = 'sin ground truth (solo juez)';
    else status = evalResult.hit ? `HIT rank=${evalResult.rank}` : 'MISS';
    if (JUDGE && row.contextRelevance !== null && row.contextRelevance !== undefined) {
      status += ` | ctxRel=${row.chunksUtiles}/${row.chunksTotal}`;
      if (row.groundedness !== null && row.groundedness !== undefined) {
        status += ` grounded=${row.afirmacionesRespaldadas}/${row.afirmaciones}`;
      }
    }
    console.log(`[${q.type}] ${q.id} ${status} -- ${q.question}`);
  }

  const recallAtK = evaluable ? (hits / evaluable) : 0;
  const mrr = evaluable ? (mrrSum / evaluable) : 0;
  const offtopicScores = results.filter(r => r.type === 'offtopic').map(r => r.topScore);
  const avgOfftopicScore = offtopicScores.length ? offtopicScores.reduce((a, b) => a + b, 0) / offtopicScores.length : null;

  const promedio = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const r3 = (v) => (v === null || v === undefined ? null : Math.round(v * 1000) / 1000);
  const metrica = (campo, filtro = () => true) =>
    promedio(results.filter(r => filtro(r) && typeof r[campo] === 'number').map(r => r[campo]));

  // Desglose por tipo: las genericas son las que exponen contaminacion publicitaria,
  // y las offtopic deberian tener relevancia ~0 (no hay nada util que recuperar).
  const porTipo = {};
  if (JUDGE) {
    for (const t of [...new Set(results.map(r => r.type))]) {
      porTipo[t] = {
        contextRelevance: r3(metrica('contextRelevance', r => r.type === t)),
        groundedness: r3(metrica('groundedness', r => r.type === t))
      };
    }
  }

  const summary = {
    timestamp: new Date().toISOString(),
    mode: MODE,
    topK: TOP_K,
    judge: JUDGE ? { judgeModel: JUDGE_MODEL, answerModel: ANSWER_MODEL, answerChunks: ANSWER_CHUNKS } : null,
    totalQuestions: preguntas.length,
    evaluable,
    hits,
    recallAtK: Math.round(recallAtK * 1000) / 1000,
    mrr: Math.round(mrr * 1000) / 1000,
    avgOfftopicScore: avgOfftopicScore !== null ? Math.round(avgOfftopicScore * 1000) / 1000 : null,
    avgContextRelevance: JUDGE ? r3(metrica('contextRelevance', r => r.type !== 'offtopic')) : null,
    avgGroundedness: JUDGE ? r3(metrica('groundedness')) : null,
    porTipo: JUDGE ? porTipo : null,
    results
  };

  console.log(`\n=== RESUMEN (modo: ${MODE}) ===`);
  console.log(`Recall@${TOP_K}: ${(recallAtK * 100).toFixed(1)}% (${hits}/${evaluable})`);
  console.log(`MRR: ${mrr.toFixed(3)}`);
  if (avgOfftopicScore !== null) console.log(`Score promedio en preguntas fuera de tema: ${avgOfftopicScore.toFixed(3)} (mientras mas bajo, mejor)`);
  if (JUDGE) {
    console.log(`Relevancia del contexto: ${(summary.avgContextRelevance * 100).toFixed(1)}% (fragmentos utiles de los ${ANSWER_CHUNKS} que van al modelo)`);
    console.log(`Groundedness: ${(summary.avgGroundedness * 100).toFixed(1)}% (afirmaciones respaldadas por el contexto)`);
    console.log('\nPor tipo de pregunta:');
    for (const [t, m] of Object.entries(porTipo)) {
      const rel = m.contextRelevance === null ? 'n/a' : `${(m.contextRelevance * 100).toFixed(1)}%`;
      const gr = m.groundedness === null ? 'n/a' : `${(m.groundedness * 100).toFixed(1)}%`;
      console.log(`  ${t.padEnd(9)} relevancia=${rel.padStart(6)}  groundedness=${gr.padStart(6)}`);
    }
  }

  const outDir = path.join(__dirname, '..', 'data', 'eval_results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `eval_${MODE}_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));
  console.log(`\nGuardado en ${outFile}`);
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
