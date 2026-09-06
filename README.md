# Huberman RAG — retrieval with a measured evaluation harness · [![CI](https://github.com/lindermannn/huberman-rag-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/lindermannn/huberman-rag-eval/actions/workflows/ci.yml) · [Live demo](https://production-hybrid-rag.lovable.app)

Production Telegram bot over **27,254 chunks** from ~417 [Huberman Lab](https://www.hubermanlab.com/) episodes. Hybrid retrieval (pgvector + Postgres full-text, fused with RRF) → query rewriting → LLM rerank, running as a self-contained n8n workflow against a dedicated Supabase project.

**Measured, not claimed** — 42 golden questions run against the production retrieval function:

| Recall@8 | MRR | Context relevance | Groundedness | Judge noise floor |
|---|---|---|---|---|
| 78.1% | 0.593 | 83.8% | 93.2% | ~9 pts |

**The evaluation harness is the point of this repo — and it was wrong first.** An earlier baseline claimed vague questions caused more hallucination. The finding was retracted after discovering that the judge truncated its own input and selectively penalised the longer answers those questions produce. Read [the judge-truncation case study](docs/case-studies/01-judge-truncation.md).

> Architecture and case studies are written in Spanish.

## Arquitectura

### Ingesta offline

```text
transcripts/resúmenes de episodios (data/raw/EP-XXX/)
  → normalización a filas KB (id, topic, text, episode_number, episode_date)
  → embeddings (OpenAI text-embedding-3-small, batches de 100)
  → upsert idempotente a Supabase (kb_documents, pgvector)
```

[`src/migrate_to_supabase.js`](src/migrate_to_supabase.js) carga la KB inicial. [`src/build_transcript_chunks.js`](src/build_transcript_chunks.js) agrega chunks por sección usando timestamps reales del podcast, con sub-split por oración y IDs deduplicados. [`src/migrate_transcript_chunks_to_supabase.js`](src/migrate_transcript_chunks_to_supabase.js) hace la carga aditiva.

### Recuperación online

```text
mensaje
  → query rewriting
  → embedding de la query
  → hybrid search en Supabase
       similitud vectorial (pgvector) ⊕ full-text Postgres
       Reciprocal Rank Fusion (RRF, k=50)
  → LLM rerank
  → respuesta fundamentada
       [Episodio N]
       [Episodio N | hh:mm:ss → YouTube al minuto exacto]
```

El retrieval es incondicional y determinístico dentro de un workflow autocontenido. No depende de que un agente decida invocar una herramienta. El corpus, la función de recuperación y el workflow viven en el mismo proyecto dedicado.

### Por qué hybrid + rewriting + rerank

- **Query rewriting** convierte preguntas vagas o coloquiales en términos recuperables.
- **Hybrid search** combina señal semántica y léxica para dosis, estudios y nombres exactos.
- **LLM rerank** reordena los candidatos RRF según la pregunta original antes de responder.

## Evaluación

El set contiene 42 preguntas doradas en [`data/golden_questions.json`](data/golden_questions.json): 28 específicas, 5 vagas, 6 genéricas tomadas de producción y 3 controles fuera de tema. El harness [`src/eval_rag.js`](src/eval_rag.js) mide posición (Recall@8, MRR), utilidad del contexto y groundedness. La metodología y la regla de exclusión están documentadas en [`docs/EVALUATION.md`](docs/EVALUATION.md).

```bash
# Recuperación: un embedding por pregunta
node --env-file=.env src/eval_rag.js

# Juez LLM sobre contexto y respuesta
RAG_JUDGE=1 node --env-file=.env src/eval_rag.js

# Smoke test antes de las 42
RAG_JUDGE=1 RAG_LIMIT=3 node --env-file=.env src/eval_rag.js
```

Requiere `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_URL`. También acepta `RAG_TENANT_ID`, `RAG_BRAND_ID`, `RAG_MODE`, `RAG_JUDGE_MODEL`, `RAG_ANSWER_MODEL`, `RAG_JUDGE_REPEAT`, `RAG_LIMIT` y `RAG_IDS`.

| Modo | Recall@8 | MRR | Score prom. fuera de tema |
|---|---:|---:|---:|
| Vector puro, KB de resúmenes | 33.3% (11/33) | 0.259 | 0.208 |
| Hybrid + rewriting + rerank | 36.4% (12/33) | 0.269 | 0.208 |
| Hybrid + chunks de transcript | 36.4% (12/33) | 0.289 | 0.217 |
| Producción, proyecto compartido (ivfflat) | 57.6% (19/33) | 0.425 | 0.274 |
| **Producción actual, proyecto propio (HNSW)** | **78.1% (25/32)** | **0.593** | 0.339 |

El denominador cambió de 33 a 32 al corregir una pregunta sin ground truth que contaba como fallo. La comparación honesta es 59.4% → 78.1%. La hipótesis ivfflat → HNSW es fundada, pero no está verificada porque el estado anterior ya no existe.

## Casos de estudio

1. [El juez truncaba su propia evidencia](docs/case-studies/01-judge-truncation.md) — retractación, calibración y piso de ruido.
2. [El RAG no se invocaba](docs/case-studies/02-retrieval-routing.md) — del tool-calling a un pipeline determinístico.
3. [La KB triplicó y Postgres agotó el timeout](docs/case-studies/03-postgres-timeout.md) — índice GIN y estadísticas.
4. [La infraestructura real contradijo la documentación](docs/case-studies/04-hybrid-search-regression.md) — regresión silenciosa de hybrid search.
5. [La publicidad ganó seis de seis puestos](docs/case-studies/05-ad-contamination.md) — fallo invisible para Recall@8.

## Limitaciones conocidas

- El salto de recall entre los dos proyectos no puede atribuirse con certeza sin reconstruir ambos índices.
- El juez y el generador siguen siendo del mismo proveedor.
- El piso de ruido se midió sobre 8 preguntas y 3 repeticiones; no caracteriza toda la cola.
- El juez LLM discrimina casos extremos, pero aún no está calibrado contra anotación humana.
- 34/413 episodios siguen fuera del índice de transcript por un formato de captions distinto.
- Quedan por evaluar un cross-encoder reranker y asignación de slots por tipo de chunk.

## Fuente y stack

La CLI de extracción/traducción se ejecuta con `npm install` y `npm start`; produce la fuente cruda que alimenta la ingesta. La búsqueda exploratoria previa al RAG sigue disponible con `node src/test_search.js "dormir"`.

n8n Cloud · Supabase/Postgres + pgvector y GIN · OpenAI `text-embedding-3-small`, `gpt-4.1` y `gpt-4.1-mini` · Node.js
