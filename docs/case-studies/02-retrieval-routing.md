# Cuando el RAG no se invoca

[← Volver al README](../../README.md)

## El fallo

Una conversación real respondió de forma genérica y sin citas a “¿qué es la L-teanina?”, aunque el pipeline de recuperación estaba completo y medido. Las trazas mostraron **cero invocaciones** al RAG: el agente había contestado desde conocimiento preentrenado.

La causa no estaba en retrieval. La regla que activaba la herramienta describía el dominio comercial genérico de la plataforma compartida —planes, precios, horarios—. Una pregunta de salud no encajaba, por lo que el agente siguió correctamente sus instrucciones y omitió la herramienta.

El primer arreglo parametrizó por tenant el dominio que dispara la recuperación, con un valor por defecto que preservaba el comportamiento de los demás tenants. Se verificó en vivo contra el mensaje original.

La lección inicial fue que “el pipeline funciona” y “el pipeline se invoca cuando corresponde” son propiedades distintas. La segunda puede fallar silenciosamente y no aparece en métricas de recall.

## El diseño pendiente expuso un acoplamiento mayor

Para impedir citas fabricadas se consideró persistir el resultado del RAG y recuperarlo mediante un identificador exacto de turno. Al implementar esa correlación apareció un problema estructural: el despachador compartido por todos los tenants y módulos eliminaba cualquier campo no incluido en su allowlist. Ni siquiera un identificador de sesión llegaba al pipeline.

Blindar un solo bot exigía entonces tocar infraestructura compartida de gran radio de impacto.

## Decisión: eliminar la clase de fallo

En lugar de sofisticar el mecanismo compartido, el bot se extrajo a un workflow único y autocontenido. Conservó trigger, deduplicación, recuperación y composición, pero el retrieval dejó de ser una herramienta opcional y pasó a ser un paso incondicional.

Sin una herramienta que el modelo pueda decidir no invocar, desaparece la clase completa de fallo. Ya no se necesita correlación entre ejecuciones para garantizar que las citas provienen de la recuperación.

La extracción terminó el 2026-08-13 con la migración a un proyecto Supabase propio. Con las 27.254 filas, la función de recuperación y el workflow en el mismo proyecto, también se eliminó el acoplamiento de datos con la plataforma multi-tenant.

## Fallos de migración que solo mostró producción

- Un nodo con cero resultados legítimos cortaba silenciosamente la cadena downstream. n8n no ejecuta los nodos siguientes ante una salida vacía salvo configuración explícita.
- Actualizar un parámetro existente por una ruta JSON Pointer creó una rama nueva en lugar de sustituir la expresión real. La API y la ejecución reportaban éxito, pero el nodo final enviaba un error genérico. Solo la comparación entre la salida calculada y el mensaje enviado reveló el fallo.

La lección final: si blindar un caso límite obliga a modificar más infraestructura compartida de la que el caso justifica, reducir el acoplamiento puede ser una solución más segura que añadir otro mecanismo.
