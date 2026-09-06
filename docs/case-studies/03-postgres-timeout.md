# Cuando triplicar la KB agotó el timeout de Postgres

[← Volver al README](../../README.md)

Después de la migración de 9,355 a ~27,254 filas, la función de hybrid search empezó a fallar con `57014: canceling statement due to statement timeout`.

La causa raíz fue doble y se confirmó consultando `pg_indexes`:

1. Nunca había existido un índice GIN sobre la columna de full-text search. A 9K filas era una decisión consciente con la condición documentada de revisarla si la tabla crecía.
2. Las estadísticas del planner estaban obsoletas después del INSERT masivo.

El arreglo aisló ambas causas: `ANALYZE kb_documents` y luego `CREATE INDEX ... USING gin (content_tsv)`. El cambio reproducible está en [`sql/fase3_fix_hybrid_timeout.sql`](../../sql/fase3_fix_hybrid_timeout.sql). La consulta pasó de timeout a ~1.5s.

La lección: una decisión de performance correcta a una escala tiene una fecha de vencimiento implícita. Documentar su condición de invalidez permitió diagnosticar el problema en minutos.
