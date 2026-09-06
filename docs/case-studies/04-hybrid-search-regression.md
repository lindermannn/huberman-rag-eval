# Regresión silenciosa de hybrid search

[← Volver al README](../../README.md)

La documentación interna afirmaba que hybrid search estaba en producción. Al revisar el nodo real de recuperación, la función activa era `match_kb_published_documents_v2`: similitud coseno pura.

La función híbrida —RRF entre vector y full-text— seguía en la base, pero había dejado de utilizarse durante una migración que unificó el retrieval de todos los tenants bajo el “Centro de Conocimiento” compartido. Nadie había decidido explícitamente sacrificar hybrid search para este bot.

La función anterior tenía además otro defecto: devolvía `episode_number` y `timestamp_start` como `null` en vez de leerlos de la tabla. Reactivarla sin inspección no habría reparado los deep-links.

## Arreglo aditivo

Se creó `match_kb_published_documents_hybrid_v1` en [`sql/fase5_hybrid_v1_and_standalone.sql`](../../sql/fase5_hybrid_v1_and_standalone.sql):

- no reemplaza la función productiva anterior;
- conserva el modelo de seguridad;
- usa el índice GIN de `content_tsv`;
- recupera los campos de episodio y timestamp;
- selecciona funciones mediante una allowlist explícita en la capa de aplicación.

La verificación usó una consulta real: “¿qué dosis de teanina se recomienda?”. El chunk correcto tenía similitud vectorial ~0 y aparecía únicamente por full-text. Hybrid search era la diferencia entre encontrar la respuesta o no, no una mejora teórica.

## Efecto colateral

Un candidato que entra por texto puede tener similitud vectorial 0 y aun así quedar primero por RRF. El cálculo de confianza anterior tomaba el score del primer resultado después del rerank, lo que podía producir falsos negativos. Se cambió a la similitud máxima entre los chunks realmente citados.

La lección: la documentación registra una intención pasada. El estado real de producción solo se confirma inspeccionando la infraestructura activa.
