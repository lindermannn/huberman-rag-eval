# Metodología de evaluación

[← Volver al README](../README.md)

La tesis de este repositorio es que un sistema RAG necesita un instrumento medido, no solo respuestas plausibles. El harness separa la posición del resultado, la utilidad del contexto y el respaldo factual de la respuesta.

## Qué mide cada métrica

### Recall@8

Para cada pregunta con ground truth de episodio, comprueba si alguno de los episodios esperados aparece entre los ocho resultados recuperados.

```text
Recall@8 = preguntas con HIT / preguntas evaluables
```

Un HIT no garantiza que los demás fragmentos sean útiles. Solo demuestra que apareció al menos un episodio esperado.

### MRR

MRR premia que el primer episodio esperado aparezca antes en el ranking. Para cada pregunta evaluable aporta `1/rank`; un fallo aporta 0.

```text
MRR = suma(1 / rank del primer episodio esperado) / preguntas evaluables
```

La posición usada se calcula después de descartar resultados cuyo `episode_number` sea nulo, igual que en el harness de producción.

### Relevancia del contexto

De los 6 fragmentos que llegan al generador, mide cuántos ayudan a responder. Publicidad, patrocinios, introducciones y pedidos de suscripción cuentan como ruido.

Esta métrica detecta un fallo que Recall@8 no ve: el episodio correcto puede aparecer y aun así dejar casi todos los puestos restantes llenos de contenido inútil.

### Groundedness

Extrae las afirmaciones factuales de la respuesta y mide qué fracción está respaldada por el contexto recuperado. El juez recibe los fragmentos completos, exactamente como el generador; no se truncan.

## Regla de exclusión

Recall@8 y MRR incluyen únicamente preguntas que:

1. no son controles `offtopic`; y
2. tienen al menos un episodio esperado en `expected_episodes`.

Las preguntas genéricas no tienen un episodio único como ground truth. Una consulta amplia puede ser contestada correctamente por muchos episodios distintos. Contarla como MISS por no devolver uno elegido arbitrariamente reduciría Recall@8 y MRR sin representar una degradación real.

Esta regla define el denominador y, por tanto, el significado del Recall@8 **78,1 %** y del MRR **0,593**. El test `aggregate excluye preguntas sin ground truth en vez de contarlas como MISS` fija explícitamente esa decisión: un cambio futuro no puede alterar silenciosamente las métricas.

## Ruido del juez

El juez LLM es estocástico. `RAG_JUDGE_REPEAT=N` repite el juicio sobre las mismas entradas, generando la respuesta una sola vez para no mezclar la varianza del generador con la del evaluador.

La calibración actual encontró un piso de ruido de **~9 pts**. Una diferencia menor no debe interpretarse como mejora o degradación. El ruido tampoco es uniforme: se concentra en preguntas con contexto pobre o ambiguo.

## Reproducir los tests offline

Los tests unitarios importan solo [`src/metrics.js`](../src/metrics.js). No cargan `.env`, no hacen llamadas de red y no necesitan credenciales.

```bash
npm ci
npm test
```

CI ejecuta exactamente esos comandos sobre Node.js LTS en un runner limpio.

## Reproducir el harness completo

El harness completo sí consulta OpenAI y Supabase. Requiere `OPENAI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_URL` en el entorno.

```bash
# Recuperación: Recall@8 y MRR
node --env-file=.env src/eval_rag.js

# Recuperación + relevancia del contexto + groundedness
RAG_JUDGE=1 node --env-file=.env src/eval_rag.js

# Prueba de humo antes de ejecutar las 42 preguntas
RAG_JUDGE=1 RAG_LIMIT=3 node --env-file=.env src/eval_rag.js

# Medición del ruido sobre una muestra de los cuatro tipos
RAG_JUDGE=1 RAG_JUDGE_REPEAT=3 RAG_IDS=gq04,gq14,gq22,gq29,gq33,gq37,gq40,gq35 node --env-file=.env src/eval_rag.js
```

En PowerShell, las variables de entorno se asignan con `$env:NOMBRE="valor"` antes de ejecutar Node.

Cada corrida guarda un JSON versionable por timestamp y modo en `data/eval_results/`. La salida conserva el detalle por pregunta, el resumen de Recall@8/MRR y, cuando se activa el juez, relevancia, groundedness, desglose por tipo, acuerdo y consumo de tokens.
