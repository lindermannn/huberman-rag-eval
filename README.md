# Huberman RAG — retrieval with a measured evaluation harness

Production Telegram bot over **27,254 chunks** from ~417 [Huberman Lab](https://www.hubermanlab.com/) episodes. Hybrid retrieval (pgvector + Postgres full-text, fused with RRF) → query rewriting → LLM rerank, running as a self-contained n8n workflow against a dedicated Supabase project.

**Measured, not claimed** — 42 golden questions run against the production retrieval function:

| Recall@8 | MRR | Context relevance | Groundedness | Judge noise floor |
|---|---|---|---|---|
| 78.1% | 0.593 | 83.8% | 93.2% | ~9 pts |

**The evaluation harness is the point of this repo — and it was wrong first.** An earlier baseline reported that vague questions caused more hallucination. That finding was **retracted** once the judge turned out to be truncating its own input, penalising exactly the long answers vague questions produce. → [Case study: tuning the instrument before trusting it](#afinar-el-instrumento-antes-de-confiar-en-él-2026-08-30)

Not an LLM wrapper with a long prompt: a retrieval pipeline iterated against data. Five production case studies below, including a silent hybrid-search regression found by reading live infrastructure, and an ad-contamination failure that recall metrics structurally cannot see.

> Architecture and case studies below are written in Spanish.

## Arquitectura

### 1. Ingesta (offline, un solo run)

```
transcripts/resúmenes de episodios (data/raw/EP-XXX/)
  → normalización a filas KB (id, topic, text, episode_number, episode_date)
  → embeddings (OpenAI text-embedding-3-small, batches de 100)
  → upsert a Supabase (kb_documents, pgvector), idempotente por id
```

Script: [`src/migrate_to_supabase.js`](src/migrate_to_supabase.js). Corre 100% local (Node nativo, sin dependencias) — la migración vía n8n Cloud se abandonó tras crashes de OOM reproducibles independientes del tamaño del batch (9355/1000/200 filas crasheaban igual); moverla fuera de la plataforma de orquestación fue la decisión correcta. Resultado: **9,355 filas** indexadas.

**Fase 3 — segunda capa de ingesta, chunking por timestamp real:** [`src/build_transcript_chunks.js`](src/build_transcript_chunks.js) parsea los transcripts traducidos y corta un chunk por sección usando los marcadores de capítulo reales del propio podcast (`## [hh:mm:ss] Título`), con sub-split por oración para secciones >3000 chars y de-duplicación de IDs. Resultado: **17,899 chunks adicionales** (379/413 episodios) con `timestamp_start`/`timestamp_end` reales, subidos de forma aditiva por [`src/migrate_transcript_chunks_to_supabase.js`](src/migrate_transcript_chunks_to_supabase.js) — la KB pasó de 9,355 a ~27,254 filas sin tocar las existentes (reversible con un `DELETE WHERE topic='transcript_segment'`).

### 2. Recuperación (online, por mensaje)

```
mensaje del usuario
  → Query Rewriting (LLM reescribe preguntas vagas/coloquiales a keywords de búsqueda concretas)
  → embedding de la query reescrita
  → Hybrid Search en Supabase (match_kb_published_documents_hybrid_v1):
        similitud vectorial (coseno, pgvector)  ⊕  full-text search Postgres (BM25-like, content_tsv/websearch_to_tsquery)
        fusionados con Reciprocal Rank Fusion (RRF, k=50)
  → LLM Rerank (reordena los top-K candidatos por relevancia real a la pregunta)
  → construcción de respuesta con cita:
        [Episodio N]                              (filas de resumen, sin timestamp)
        [Episodio N | hh:mm:ss → youtu.be/ID?t=s]  (chunks de transcript: deep-link
                                                    de YouTube al minuto exacto)
```

Desde 2026-07-21 corre en un **workflow único y autocontenido** (ver Caso de estudio 4) — sin agente con tool-calling, sin dependencia de ninguna infraestructura multi-tenant compartida. El retrieval es incondicional y determinístico: no hay una decisión de "¿llamo al RAG o no?" de la que un LLM se pueda saltear.

## Por qué hybrid + rewriting + rerank, y no solo vector search

Búsqueda vectorial pura falla en dos casos comunes en este dominio: (a) preguntas con términos técnicos exactos (dosis, nombres de estudios) donde el match léxico gana al semántico, y (b) preguntas vagas/coloquiales ("cómo duermo mejor") donde el embedding de la pregunta cruda no se parece al embedding de los chunks relevantes. Cada etapa ataca un modo de fallo distinto:

- **Query rewriting** — normaliza la intención antes de embeddear, para que preguntas vagas recuperen contenido específico.
- **Hybrid search (RRF)** — combina señal semántica y léxica; recupera casos donde una sola señal no basta.
- **LLM rerank** — el top-K de RRF no siempre está ordenado por relevancia real a la pregunta original; un segundo paso de relevancia lo corrige antes de construir la respuesta.

## Evaluación

Metodología: set de 42 "preguntas doradas" ([`data/golden_questions.json`](data/golden_questions.json)) con ground truth (número de episodio esperado) **sacado directamente de la KB real**, nunca inventado — 28 específicas, 5 vagas, 3 de control fuera de tema (para verificar degradación honesta, no alucinación) y 6 genéricas. Harness de evaluación 100% local: [`src/eval_rag.js`](src/eval_rag.js).

Mide dos familias de métricas complementarias:

- **Posición en el ranking** — Recall@8 y MRR. Baratas (un embedding por pregunta), corren por defecto.
- **Utilidad de lo recuperado** — relevancia del contexto y groundedness, vía juez LLM. Se activan con `RAG_JUDGE=1` porque cuestan tres llamadas extra por pregunta.

Las 6 preguntas genéricas ("suplementos para entrenar fuerza", "qué tomar para dormir") están **tomadas de logs reales de producción**, no inventadas, y no llevan episodio esperado: a una consulta amplia le sirven muchos episodios distintos, así que exigir uno concreto mediría ruido. Se evalúan solo por relevancia del contexto — que es precisamente donde la contaminación publicitaria se manifiesta.

```bash
# Solo recuperación (Recall@8 + MRR) — un embedding por pregunta
node --env-file=.env src/eval_rag.js

# Con las métricas de juez LLM
RAG_JUDGE=1 node --env-file=.env src/eval_rag.js

# Prueba de humo antes de gastar en las 42
RAG_JUDGE=1 RAG_LIMIT=3 node --env-file=.env src/eval_rag.js

# Ruido del propio juez: juzga 3 veces las mismas entradas.
# La muestra debe cubrir los cuatro tipos de pregunta, no solo las primeras del set.
RAG_JUDGE=1 RAG_JUDGE_REPEAT=3 RAG_IDS=gq04,gq14,gq22,gq29,gq33,gq37,gq40,gq35   node --env-file=.env src/eval_rag.js
```

Necesita `OPENAI_API_KEY` y la `SUPABASE_SERVICE_ROLE_KEY` **del proyecto del bot** — la función de recuperación está concedida solo a `service_role`, así que una clave publishable no sirve. Ajustables por entorno: `SUPABASE_URL`, `RAG_TENANT_ID`, `RAG_BRAND_ID`, `RAG_MODE`, `RAG_JUDGE_MODEL`, `RAG_ANSWER_MODEL`, `RAG_JUDGE_REPEAT`, `RAG_LIMIT`, `RAG_IDS`.

Cada corrida imprime su consumo de tokens. La evaluación completa de las 42 con juez de razonamiento y contexto sin truncar gasta **~180K tokens de entrada y ~52K de salida en el juez** (de los cuales 50K son de razonamiento invisible en la respuesta), más ~95K en el generador. El modo `RAG_JUDGE_REPEAT` multiplica la parte del juez, por eso conviene acotarlo con `RAG_IDS`.

| Modo | Fecha | Recall@8 | MRR | Score prom. fuera de tema |
|---|---|---|---|---|
| Vector puro (baseline, KB de resúmenes) | 07-10 | 33.3% (11/33) | 0.259 | 0.208 |
| Hybrid + rewriting + rerank | 07-10 | 36.4% (12/33) | 0.269 | 0.208 |
| Hybrid + chunks de transcript (Fase 3, ~27K filas) | 07-12 | 36.4% (12/33) | 0.289 | 0.217 |
| Función de producción, proyecto compartido (ivfflat) | 08-04 | 57.6% (19/33) | 0.425 | 0.274 |
| **Producción actual, proyecto propio (HNSW)** | 08-29 | **78.1% (25/32)** | **0.593** | 0.339 |

**Sobre el salto de la última fila, con la advertencia por delante:** el denominador cambió de 33 a 32 porque se corrigió que una pregunta sin ground truth contaba como fallo, así que la comparación honesta es 59.4% → 78.1%. Y no es mérito de ningún cambio de recuperación: entre ambas mediciones el corpus se migró a un proyecto Supabase propio y el índice vectorial pasó de **ivfflat (`lists=170`) a HNSW**. ivfflat es aproximado y con ese número de listas sobre 27K filas se deja candidatos afuera; HNSW recupera muchos más. Es la explicación más probable, pero **no está verificada**: el estado anterior ya no existe, así que no pude re-medirlo. Se reporta como hipótesis fundada, no como conclusión.

El MRR sí es señal limpia: **16 de los 25 aciertos salen en el puesto 1**. Cuando el sistema encuentra el episodio correcto, lo rankea primero.

El harness evalúa **recuperación pura**, sin el query rewriting que sí corre en producción, así que 78.1% es un piso, no el rendimiento del bot completo.

### Resultados de las métricas de juez (2026-08-30, 42 preguntas)

Juez `gpt-5.6-luna` con contexto completo. Entre paréntesis, lo que medía el instrumento anterior (`gpt-4.1-mini` con contexto truncado) — mismo sistema, mismo día de datos, solo cambió el instrumento:

| Tipo | Relevancia del contexto | Groundedness |
|---|---|---|
| Específicas (28) | 81.5% (72.0%) | **95.0%** (95.0%) |
| Vagas (5) | 90.0% (83.3%) | **90.6%** (77.6%) |
| Genéricas (6) | 88.9% (80.6%) | **87.3%** (86.3%) |
| Fuera de tema (3) | 16.7% (11.1%) | n/a |
| **Global** | **83.8%** (74.8%) | **93.2%** (91.4%) |

Recall@8 y MRR quedaron **idénticos** entre ambas corridas (78.1% / 0.593). Sirven de control: la recuperación no se tocó, así que todo el movimiento de arriba es del instrumento, no del sistema.

Con el piso de ruido de ~9 puntos, solo dos diferencias son señal: relevancia en específicas (+9.5) y groundedness en vagas (+13.0). El resto entra dentro del error del propio juez y no se puede interpretar.

> [!warning] Corrección de una conclusión anterior
> La primera línea base reportó que **"cuanto más vaga la pregunta, más inventa el modelo"**, con groundedness cayendo de 95% a 77.6%. Medido sin truncar el contexto, ese número real es **90.6%**. La caída respecto de las específicas es de 4.4 puntos — **por debajo del piso de ruido**, así que ya no sostiene la afirmación.
>
> La explicación encaja con la causa: las preguntas vagas producen respuestas largas que se apoyan en partes profundas de los fragmentos, justo lo que el corte a 900 caracteres eliminaba del contexto que veía el juez. El instrumento marcaba como inventado lo que sí estaba respaldado, y lo hacía **selectivamente en el tipo de pregunta que genera respuestas más largas** — un sesgo, no ruido aleatorio.
>
> El hallazgo que quedó en pie es el otro: el incidente de la publicidad (caso de estudio 5) fue real y verificado a mano contra ejecuciones de producción. Lo que no se sostiene es la generalización de que las preguntas vagas alucinan más.

Dos lecturas que Recall@8 no podía dar y que sí sobreviven:

**1. Un acierto de recall puede tener el contexto lleno de ruido.** *"¿Cuáles son los tres pilares de un sueño saludable?"* recuperó el episodio esperado en el puesto 3 — Recall@8 lo cuenta como éxito — pero solo **1 de 6** fragmentos servía. La métrica de posición no ve la calidad de lo que llena los otros cinco puestos.

**2. Un fallo de recall puede ser una respuesta correcta.** *"¿Cuándo hay que exponerse a la luz solar de la mañana?"* cuenta como MISS y sin embargo trajo **6/6 fragmentos relevantes** y respondió con **8/8 afirmaciones respaldadas**. El episodio "esperado" no salió, pero otros responden igual de bien. Eso no es un fallo del sistema: es un límite del ground truth de un episodio único por pregunta.

El control fuera de tema se comporta como debe: 11.1% de relevancia, o sea que para "cuál es la capital de Francia" el sistema no encuentra casi nada — y no lo disfraza.

### Afinar el instrumento antes de confiar en él (2026-08-30)

La primera línea base salió con un juez que tenía tres defectos de método. Ninguno se ve en los números: se ven leyendo el código del evaluador.

**1. El juez leía una entrada distinta de la que ve el sistema.** Los fragmentos se truncaban a 700 caracteres para relevancia y 900 para groundedness. Un fragmento cuyo contenido útil empezaba en el carácter 800 se juzgaba como ruido, y una afirmación que el generador sacó del final de un fragmento largo se contaba como inventada. Eran **falsos positivos de alucinación fabricados por el propio instrumento**. Ahora el juez recibe el contexto completo, el mismo que el generador.

**2. El juez era de la misma familia que el generador** — `gpt-4.1-mini` corrigiendo a `gpt-4.1`. Un modelo que evalúa texto de su propia familia tiende a premiarlo. Ahora juzga `gpt-5.6-luna`, que además razona antes de responder, que es justo lo que pide contar afirmaciones respaldadas.

> **Límite honesto:** sigue siendo OpenAI. Cambia el modelo y el modo de inferencia, no el proveedor, así que reduce el sesgo intra-familia pero no lo elimina. Un juez de otro proveedor sería mejor; `RAG_JUDGE_MODEL` queda configurable para cuando haya credenciales de otro.

Cambiar a un modelo de razonamiento obligó a corregir el manejo de parámetros: los `gpt-5*` rechazan `max_tokens` con un 400 y **solo aceptan `temperature=1`**. Es exactamente el fallo que tumbó el motor del SaaS durante una semana en agosto, así que `chat()` ahora ramifica por familia y detecta el caso en que el modelo agota su presupuesto razonando sin llegar a emitir respuesta.

**3. No se conocía el ruido del propio juez.** Sin eso, comparar dos corridas es leer un termómetro sin saber su precisión. `RAG_JUDGE_REPEAT=N` juzga N veces **las mismas entradas** — la respuesta se genera una sola vez y se juzga N veces, para no mezclar la varianza del generador con la del juez. Con `gpt-5.6-luna` esto dejó de ser opcional: al no aceptar `temperature=0`, el juez es estocástico por construcción.

#### Resultado: el ruido no está donde uno lo buscaría

Muestra de 8 preguntas cubriendo los cuatro tipos, 3 repeticiones cada una:

| | Valor |
|---|---|
| Fragmentos con veredicto unánime en las 3 corridas | **91.7%** |
| Relevancia — desviación media / rango medio | 3.7 pts / 8.3 pts |
| Groundedness — desviación media / rango medio | 4.3 pts / 9.5 pts |
| **Piso de ruido** | **~9 puntos** |

**Una diferencia menor a ~9 puntos entre dos corridas no es señal.** La primera línea base no traía esa cifra, así que cualquier comparación contra ella habría sido interpretación de ruido.

Dos cosas que solo se ven en el detalle por pregunta:

**El ruido se concentra en los casos límite.** Cinco de las ocho preguntas dieron resultados idénticos en las tres corridas. Casi todo el ruido sale de dos: una con groundedness `43/63/63` (rango de 20 puntos) y otra con relevancia `50/33/67` (rango de 34). Ambas son preguntas cuyo contexto recuperado es pobre o ambiguo — o sea que **el juez es estable cuando el caso es claro e inestable justo donde hay que decidir**. Un único piso de ruido global subestima el error en los casos difíciles.

**Medir el ruido solo sobre preguntas específicas lo subestima a la mitad.** La primera medición usó las 3 primeras del set, todas específicas: dio 100% de unanimidad y un piso de ~5 puntos. Al muestrear los cuatro tipos, la unanimidad bajó a 91.7% y el piso subió a ~9. La muestra con la que se calibra un instrumento tiene que parecerse a aquello sobre lo que se va a usar.

**Lo más inestable es el denominador, no el ratio.** Juzgando la misma respuesta, el juez contó entre 15 y 26 afirmaciones factuales. Cuántas afirmaciones contiene un texto es un juicio con latitud legítima; qué fracción está respaldada resulta bastante más estable que sus dos componentes por separado.

### Las dos métricas que Recall@8 no puede dar

Recall@8 responde *"¿está el episodio esperado entre los 8 primeros?"*. No responde *"¿sirve de algo lo que trajo?"* ni *"¿la respuesta sale de ahí o el modelo la inventó?"*. Las dos métricas nuevas cubren cada hueco:

| Métrica | Pregunta que responde | Cómo se calcula |
|---|---|---|
| **Relevancia del contexto** | De los 6 fragmentos que llegan al modelo, ¿cuántos aportan algo? | Un juez LLM marca cada fragmento como útil o ruido (publicidad, patrocinios, intros, pedidos de suscripción) |
| **Groundedness** | De las afirmaciones de la respuesta, ¿cuántas se apoyan en el contexto? | Se genera una respuesta con el prompt de producción y un juez cuenta afirmaciones respaldadas sobre afirmaciones totales |

Ambas se validaron con casos controlados antes de usarlas: contexto 100% publicitario → relevancia 0/2; contexto mixto → 1/2; respuesta con cifras inventadas ("20 g de creatina, aumento de fuerza del 47%") → groundedness 0/4; respuesta fiel al contexto → 3/3. Sin esa validación previa, un juez LLM es solo otra fuente de números sin verificar.

El episodio que motivó ambas: una consulta real devolvió **6 de 6 fragmentos publicitarios** y el modelo respondió de su conocimiento pretrained adjuntando 6 citas que no respaldaban nada. Relevancia del contexto 0%, groundedness ~0% — y Recall@8 sin registrar absolutamente nada.

Sobre las tres primeras filas: mejora real pero modesta, reportada sin inflar. El score de las preguntas de control se mantuvo estable y bajo, confirmando que el sistema no empezó a alucinar para preguntas fuera de dominio al subir el recall. La Fase 3 no movió el Recall@8 (los chunks finos no agregan episodios nuevos al top-8) pero sí el MRR: cuando el sistema encuentra el episodio correcto lo rankea mejor, porque existe una unidad de contenido específica en vez de solo el resumen del episodio completo. Ejemplo real: "¿qué es la L-teanina?" pasó de "no encontré información" (gap de granularidad documentado abajo) a una cita precisa con timestamp.

### Resultado negativo: la limpieza de publicidad no movió estas métricas

Al desactivar 46 fragmentos publicitarios (caso de estudio 5) se corrió la evaluación con y sin ellos: **los 36 conjuntos recuperados resultaron idénticos**, con el mismo Recall@8 y el mismo MRR. Efecto nulo, verificado comparando los resultados fila por fila — no estimado.

Eso no invalida la limpieza: expone un límite de la métrica. Recall@8 responde *"¿está el episodio esperado entre los 8 primeros?"*, no *"¿cuántos de esos 8 puestos sirven de algo?"*. Un caso real de producción devolvió **6 de 6 fragmentos publicitarios** para "suplementos para entrenar fuerza" — context precision de 0%, Recall@8 sin registrar nada. El golden set tampoco cubre ese patrón: sus preguntas de suplementos son específicas (creatina, mioinositol) y la publicidad solo compite en consultas genéricas.

Conclusión metodológica: **medir recall no alcanza para detectar contaminación del contexto.**

### Verificación end-to-end: la misma consulta, antes y después

La comprobación que el golden set no podía dar se hizo repitiendo en producción la consulta real que destapó el problema. Dos ejecuciones del mismo workflow, misma pregunta, separadas por la limpieza:

| | Antes (`8688`) | Después (`8707`) |
|---|---|---|
| Fuentes publicitarias | **6 de 6** | **0 de 6** |
| Datos verificables en el contexto recuperado | ninguno | todos |
| Confianza reportada | 0.55 | 0.67 |

Antes, el contexto no contenía una sola mención a creatina: el modelo respondió **desde su conocimiento pretrained** y el código le adjuntó seis citas a anuncios que no respaldaban nada. Las citas eran reales —links válidos, timestamps correctos— pero no sostenían el texto. Un fallo de *groundedness* que ninguna métrica de recall detecta y que, a simple vista, se ve como una respuesta excelente.

Después, cada dato de la respuesta se rastrea a un fragmento citado: "3 a 5 gramos diarios" (Ep 121, Andy Galpin), "~5 g/día para ~82 kg" y "más de 66 estudios, 12-20% de potencia" (Ep 280), "beta-alanina 60-240 segundos, dosis 2-5 g" (Ep 22), "evitar megadosis de vitamina C" (Ep 306). Aparecieron además las voces que correspondían —Layne Norton, Andy Galpin, Darren Candow— que la base tenía desde el principio, tapadas por seis lecturas de patrocinio.

**Las dos mitades del hallazgo no se contradicen:** efecto cero en el golden set, y de 100% a 0% de contaminación en una consulta real. El golden set no contiene consultas genéricas, que es exactamente donde la publicidad competía. La limpieza sirvió justo donde el instrumento no miraba.

Nota sobre groundedness: en la ejecución posterior, el modelo se apoyó en el contexto sin cambiar una línea del prompt. La instrucción *"usa exclusivamente la información de la base"* ya estaba bien escrita — lo que fallaba era que no había información que usar. Eso no elimina la necesidad de medir groundedness (esta verificación se hizo cotejando frase por frase a mano, y eso no escala), pero descarta que el problema estuviera en el prompt.

## Caso de estudio: bug en producción (2026-07-11)

Un test de conversación real reportó una respuesta genérica sin citas de episodio para "¿qué es la L-teanina?", pese a que el pipeline de arriba estaba completo y medido. Diagnóstico por trazas de ejecución (no por prueba y error): el nodo de la herramienta RAG mostraba **cero invocaciones** para ese mensaje — el agente nunca llamó al pipeline, respondió de su conocimiento pretrained.

**Causa raíz:** la regla que obliga al agente a usar la herramienta de recuperación estaba escrita para el caso de uso comercial genérico de la plataforma compartida ("preguntas sobre la empresa: planes, precios, horarios..."). Una pregunta de salud no encaja en esa categoría, así que el agente, siguiendo correctamente sus propias instrucciones, nunca activó el RAG. El pipeline de recuperación era correcto; el *routing* hacia él no lo era.

**Fix:** el dominio que dispara la herramienta se parametrizó por tenant (con default que preserva el comportamiento de todos los demás tenants de la plataforma compartida), verificado en vivo contra el mensaje real antes de publicar a producción.

Lección: en un sistema RAG multi-tenant, "el pipeline de recuperación funciona" y "el pipeline de recuperación se invoca cuando debería" son cosas distintas que hay que verificar por separado — la segunda falla silenciosamente y no aparece en ninguna métrica de recall.

## Caso de estudio 2: timeout de Postgres al triplicar la KB (2026-07-12)

Inmediatamente después de la migración de Fase 3 (9,355 → ~27,254 filas), la función de hybrid search empezó a fallar con `57014: canceling statement due to statement timeout`. Causa raíz doble, confirmada consultando `pg_indexes` (no adivinando): (a) **nunca existió índice GIN** sobre la columna de full-text search — decisión consciente y documentada a 9K filas ("revisar si crece"), que dejó de ser válida al triplicar la tabla; (b) estadísticas del planner obsoletas tras el INSERT masivo. Fix en dos pasos aislados: `ANALYZE kb_documents` + `CREATE INDEX ... USING gin (content_tsv)` ([`sql/fase3_fix_hybrid_timeout.sql`](sql/fase3_fix_hybrid_timeout.sql)). La consulta pasó de timeout a ~1.5s.

Lección: una decisión de performance correcta a una escala ("no necesito este índice") lleva fecha de vencimiento implícita — documentarla junto a su condición de invalidez es lo que permitió diagnosticar esto en minutos.

## Fase 4 — citas accionables y modelo (2026-07-12)

- **Deep-links de YouTube al minuto exacto:** [`src/gen_youtube_map.js`](src/gen_youtube_map.js) construye el mapa `episode_number → youtube_id` (406 ids validados) desde el frontmatter de los transcripts; el nodo de formateo del RAG convierte `timestamp_start` a segundos y arma `https://youtu.be/<id>?t=<seg>`. Sin cambios de esquema ni re-embeddings: metadata derivada de la fuente canónica, incrustada en el paso de formateo.
- **Upgrade del modelo del agente** de `gpt-4.1-mini` a `gpt-4.1` (configurable por tenant, cambio de un solo campo): mejora medida en obediencia de instrucciones — mini inventaba URLs en la sección de fuentes; 4.1 respeta la regla "solo links que vengan de la recuperación".
- **Formato de respuesta iterado con feedback de usuario real:** el cuerpo va limpio (sin citas inline) y las fuentes se ofrecen bajo demanda — decisión de producto tras observar que el modelo omitía citas inconsistentemente cuando había muchos episodios juntos.

## Caso de estudio 3: regresión silenciosa de hybrid search, encontrada leyendo infraestructura real (2026-07-21)

Al proponer una optimización de búsqueda vectorial, la documentación interna decía "hybrid search en producción" — pero leer el nodo real de recuperación reveló que la función activa (`match_kb_published_documents_v2`) era **similitud coseno pura**. La función hybrid (RRF vector + full-text) seguía existiendo en la base pero había dejado de usarse en algún punto no documentado, como efecto secundario de una migración de plataforma que unificó el retrieval de todos los tenants bajo una función genérica del "Centro de Conocimiento" compartido — sin que nadie tomara la decisión explícita de sacrificar el hybrid para este bot.

Bonus al investigar: la función vieja tenía un bug propio no detectado — hardcodeaba `episode_number`/`timestamp_start` a `null` en vez de leerlos de la tabla, así que ni siquiera reactivarla tal cual hubiera arreglado las citas con deep-link.

**Fix:** función RPC nueva y aditiva (`match_kb_published_documents_hybrid_v1`, [`sql/fase5_hybrid_v1_and_standalone.sql`](sql/fase5_hybrid_v1_and_standalone.sql)) — no modifica la función en producción, mismo modelo de seguridad, usa el índice GIN existente sobre `content_tsv`, y de paso corrige el bug de los campos en `null`. El branch por función se resuelve en la capa de aplicación (config por tenant con allowlist explícito — nunca se interpola un string sin validar en la URL del RPC), default = comportamiento actual para cualquier tenant sin config, cero riesgo para el resto de la plataforma. Verificado con un caso real documentado (`¿qué dosis de teanina se recomienda?`): el chunk correcto tenía similitud vectorial ~0 y solo aparecía vía el componente full-text — confirmando que el hybrid search no es una mejora teórica, es la diferencia entre encontrar la respuesta o no.

**Efecto colateral encontrado y corregido:** con hybrid, un chunk top-ranked por RRF puede tener similitud vectorial 0 (si llegó solo por texto). El cálculo de confianza original tomaba el score del primer resultado post-rerank — con hybrid eso podía leer 0 y disparar falsos negativos. Fix: usar el máximo de similitud entre los chunks realmente citados, no el del primero.

Lección: la documentación describe una intención pasada; el estado real de un sistema en producción solo se confirma leyéndolo.

## Caso de estudio 4: de tool-calling agéntico a pipeline determinístico — eliminar la clase de bug, no parchearla (2026-07-21)

La limitación de citas fabricadas (Fase 4, arriba) tenía un diseño de arreglo pendiente: persistir el resultado del RAG y releerlo por un identificador de ejecución exacto (`turnId`), para que el nodo final pudiera construir las citas en código sin depender de si el agente decidió invocar la herramienta o no. Al empezar a implementarlo apareció un hallazgo que cambió el plan: el despachador de módulos — compartido por **todos** los tenants y **todos** los módulos de la plataforma (no solo RAG) — descarta silenciosamente cualquier campo no whitelisteado en tránsito. Ni siquiera un identificador de sesión llegaba hoy al pipeline de RAG. Implementar el mecanismo de correlación exacto requería tocar ese despachador compartido — blast radius alto para blindar un bot de un solo tenant.

**Decisión:** en vez de aumentar la sofisticación de la arquitectura compartida, reducir el acoplamiento del bot con ella. Extracción completa a un workflow único y autocontenido: mismo trigger de Telegram, misma capa de dedup, pero el pipeline de recuperación y composición corre inline, sin pasar por el router ni el motor de agente compartidos. El cambio de diseño más importante: **el retrieval dejó de ser una decisión de un agente con tool-calling y pasó a ser un paso incondicional del pipeline.** Sin una herramienta que un LLM pueda decidir no invocar, la clase de bug completa (citas fabricadas cuando el agente saltea el RAG) deja de ser posible — no hace falta ningún mecanismo de correlación cross-ejecución para blindarla.

**La extracción se completó el 2026-08-13 con la migración a un proyecto Supabase propio.** Hasta entonces el bot ya no dependía del router ni del motor de agente compartidos, pero seguía leyendo del mismo Postgres que la plataforma multi-tenant — un acoplamiento de datos que la separación de workflows no resolvía. Con las 27.254 filas en su propio proyecto, el bot es portable de verdad: el corpus, la función de recuperación y el workflow se mueven juntos.

Ese cambio dejó una lección de mantenimiento: el harness de evaluación tenía el proyecto **hardcodeado** y quedó apuntando al viejo durante dos semanas, fallando con un error de autorización engañoso. Hoy el proyecto, el tenant y la marca se leen de variables de entorno, con el proyecto correcto por defecto — un valor hardcodeado en una herramienta de medición se convierte en deuda en cuanto la infraestructura se mueve.

Además, ya con cero dependencias de la plataforma compartida, se sumaron mejoras de producto que antes hubieran significado tocar infraestructura común: memoria de conversación propia con expiración (6h de inactividad reinicia el contexto), detección de saludos/chit-chat para no gastar una llamada de RAG completa en un "Hola", y las citas con deep-link vuelven a ofrecerse bajo demanda — pero ahora con un *fast path* que responde con los links de la última respuesta sin volver a correr el pipeline completo.

**Dos bugs reales de la migración, detectados en producción antes/después de publicar (no en desarrollo):**
- Un nodo que puede devolver legítimamente cero resultados (usuario sin historial previo) cortaba en silencio toda la cadena downstream — n8n no ejecuta nodos aguas abajo de un resultado vacío salvo que se declare explícitamente lo contrario.
- Reasignar un parámetro que ya existía en un nodo (en vez de crear uno nuevo) usando una ruta de tipo JSON Pointer falló silenciosamente dos veces — creó una ruta anidada nueva en vez de sobrescribir la real, dejando la expresión vieja activa. La API reportaba éxito y cada ejecución real mostraba `status: success`; el bot respondía igual un mensaje de error genérico a cada usuario. Solo fue visible comparando la salida calculada por el pipeline contra lo que el nodo de envío realmente mandó — la lección operativa: "la ejecución no lanzó error" no es lo mismo que "el resultado es el esperado".

Lección: cuando blindar una arquitectura compartida contra un caso límite requiere tocar más infraestructura común de la que el caso límite justifica, la opción correcta puede ser reducir el acoplamiento en vez de aumentar la sofisticación del blindaje.

## Caso de estudio 5: contaminación por publicidad, y por qué el recall no la ve (2026-08-04)

Una pregunta real de un usuario — *"suplementos para entrenar fuerza"* — devolvió **seis fragmentos y los seis eran lecturas de patrocinio** del podcast ("nos hemos asociado con Momentous… envíos internacionales…"). Cero contenido sobre creatina o proteína. Causa: el anuncio se repite en cientos de episodios y satura las palabras genéricas que la gente más busca ("suplementos", "sueño", "enfoque"), ganándole al contenido sustantivo, que menciona el compuesto específico en vez del término genérico.

Lo relevante fue el proceso, porque **las dos primeras reglas de detección fallaron y solo se supo por validarlas contra datos reales antes de aplicarlas**:

1. **Por palabras clave** — marcaba 245 fragmentos. Contrastada contra los 6 culpables reales, solo atrapaba 1: el propio anuncio dice *"protocolo de suplementación optimizado"*, y esa palabra lo hacía pasar por contenido legítimo.
2. **Por texto repetido entre episodios** — conceptualmente mejor (la publicidad es copy-paste, el contenido es único), pero los candidatos incluían bloques de ~3.000 caracteres que arrancan con la intro y **terminan explicando neuronas y neurotransmisores**. Aplicarla habría destruido contenido real.
3. **Por longitud** — el discriminador confiable: los fragmentos cortos son publicidad pura, los largos siempre son mixtos.

Resultado: 46 fragmentos desactivados (0.17% de la KB), todos segmentos de transcripción de <2.000 caracteres. Al aplicar aparecieron **4 falsos positivos** que hubo que restaurar — entre ellos `hub-ep108-proto21`, el protocolo *"Marco Racional para la Toma de Decisiones sobre Suplementación"*, que es justamente el mejor fragmento de la base para responder sobre suplementos: había caído porque el protocolo usa las mismas frases que el anuncio. La regla se había validado contra los culpables (¿los atrapa?) pero no contra los **tipos de contenido** (¿a quién más golpea?).

El desenlace más útil está en la sección de evaluación: **medido, el efecto sobre Recall@8 y MRR fue exactamente cero**, lo que expuso que la métrica es ciega a este tipo de degradación.

## Limitaciones conocidas / roadmap

- **El salto de recall 08-04 → 08-29 no está atribuido con certeza.** La hipótesis (ivfflat → HNSW) es fundada pero no se pudo verificar: el estado anterior ya no existe. Un A/B limpio requeriría reconstruir ambos índices sobre el mismo corpus y re-medir.
- **El juez sigue siendo del mismo proveedor que el generador.** `gpt-5.6-luna` reduce el sesgo intra-familia respecto de `gpt-4.1-mini`, no lo elimina. Un juez de otro proveedor es la mejora pendiente más clara; `RAG_JUDGE_MODEL` ya es configurable.
- **El piso de ruido se midió sobre 8 preguntas y 3 repeticiones.** Suficiente para saber que ~9 puntos no son señal, escaso para caracterizar la cola. Más repeticiones darían un intervalo en vez de un rango.
- **El ruido del juez no es uniforme y se reporta como si lo fuera.** Se concentra en preguntas de contexto ambiguo, donde llega a 20-34 puntos de rango. Un piso por tipo de pregunta —o condicionado a la relevancia del contexto— sería más honesto que un único número global.
- **El juez LLM no está calibrado contra criterio humano.** Se validó que discrimina en casos extremos (publicidad vs. contenido útil), no que coincida con un anotador humano en casos ambiguos. Para eso haría falta un subconjunto etiquetado a mano y medir acuerdo.
- **34/413 episodios fuera del índice de transcript** (formato de caption por línea distinto al de marcadores de capítulo) — pendiente extender el parser.
- **Cross-encoder reranker** dedicado en vez de LLM-rerank genérico, y benchmark más amplio que las 42 preguntas doradas.
- **Slot allocation por tipo de chunk** (resumen de episodio vs. segmento de transcript con timestamp): hoy compiten sin distinción por los mismos puestos del top-K; garantizar representación mínima de cada tipo podría mejorar la especificidad de las respuestas — identificado, no implementado.

## Stack

n8n Cloud (orquestación) · Supabase/Postgres + pgvector (vector store + full-text search + GIN full-text index) · OpenAI (`text-embedding-3-small`, `gpt-4.1` agente, `gpt-4.1-mini` rewriting/rerank) · Node.js (scripts de ingesta y evaluación, sin dependencias externas).

---

## Apéndice: pipeline de extracción y traducción de la fuente

Herramienta CLI usada para construir la KB cruda a partir del repositorio [Huberman-Lab-Wiki](https://github.com/PatrykWajs/Huberman-Lab-Wiki): extrae resúmenes/transcripts, los traduce al español y los compila en un índice JSON estructurado. Es la etapa previa a la ingesta descrita arriba (esta herramienta produce `data/raw/EP-XXX/`, que luego alimenta `src/migrate_to_supabase.js`).

### Instalación
```bash
npm install
```

### Configuración opcional (traducción vía Gemini)
Sin `GEMINI_API_KEY` cae automáticamente a la API web gratuita de Google Translate.
```bash
cp .env.example .env   # pegar GEMINI_API_KEY
```

### Uso
```bash
npm start   # menú interactivo
```

- **Opción 1 — Extracción:** trae resúmenes/transcripts crudos del repo clonado a `data/raw/EP-XXX/` (evita los problemas de rutas con `:` de Windows usando comandos Git directos).
- **Opción 2 — Traducción por lotes:** inglés→español (resúmenes y/o transcripts), con límite de lote configurable y progreso persistido en `data/translated/progress.json` (reanudable).
- **Opción 3 — Compilar base JSON:** agrega todo a `data/database/index.json` + `data/database/episodes/EP-XXX.json`.
- **Opción 4 — Test de búsqueda por keywords** (herramienta exploratoria previa al RAG real):
  ```bash
  node src/test_search.js "dormir"
  ```

### Esquema de `data/database/`
- `index.json`: metadata + resúmenes de los 413 episodios.
- `episodes/EP-XXX.json`:
  ```json
  {
    "id": "EP-XXX",
    "title_en": "English Title",
    "title_es": "Spanish Title",
    "summary_en": "Markdown...",
    "summary_es": "Markdown...",
    "transcript_en": "Markdown...",
    "transcript_es": "Markdown...",
    "has_summary": true,
    "has_summary_translated": true,
    "has_transcript": true,
    "has_transcript_translated": false
  }
  ```
