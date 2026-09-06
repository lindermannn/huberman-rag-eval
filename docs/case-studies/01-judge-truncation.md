# El juez truncaba su propia evidencia

[← Volver al README](../../README.md)

## La retractación

La primera línea base sostuvo que cuanto más vaga era la pregunta, más inventaba el modelo: groundedness caía de 95.0% a 77.6%. Al repetir la medición sin truncar el contexto, el valor para preguntas vagas fue **90.6%**. La diferencia respecto de las específicas quedó en 4.4 puntos, por debajo del piso de ruido del juez; la afirmación original dejó de sostenerse y fue retirada.

La causa encaja con el sesgo observado. Las preguntas vagas producen respuestas más largas, apoyadas en partes profundas de los fragmentos. El evaluador cortaba a 700 caracteres para relevancia y 900 para groundedness. Así marcaba como inventado contenido que sí estaba respaldado, y lo hacía selectivamente sobre el tipo de pregunta que genera respuestas más largas.

El hallazgo que sobrevivió fue distinto: la contaminación publicitaria era real y había sido verificada manualmente en producción. Lo que se retractó fue la generalización sobre las preguntas vagas.

## Mismo sistema, distinto instrumento

Juez `gpt-5.6-luna` con contexto completo frente a `gpt-4.1-mini` con contexto truncado, sobre los mismos datos:

| Tipo | Relevancia del contexto | Groundedness |
|---|---:|---:|
| Específicas (28) | 81.5% (72.0%) | **95.0%** (95.0%) |
| Vagas (5) | 90.0% (83.3%) | **90.6%** (77.6%) |
| Genéricas (6) | 88.9% (80.6%) | **87.3%** (86.3%) |
| Fuera de tema (3) | 16.7% (11.1%) | n/a |
| **Global** | **83.8%** (74.8%) | **93.2%** (91.4%) |

Recall@8 y MRR permanecieron idénticos: 78.1% y 0.593. Ese control confirma que la recuperación no cambió; el movimiento provenía del instrumento.

## Tres defectos que no se ven en el resultado agregado

### 1. El juez veía una entrada distinta

El generador recibía fragmentos completos. El juez recibía versiones truncadas. Una afirmación obtenida del final de un fragmento podía estar fundamentada para el sistema y parecer inventada para el evaluador.

La corrección fue pasar al juez exactamente el mismo contexto que ve el generador.

### 2. Juez y generador pertenecían a la misma familia

`gpt-4.1-mini` evaluaba respuestas de `gpt-4.1`. Se cambió a `gpt-5.6-luna`, un modelo de razonamiento, aunque el límite honesto permanece: ambos siguen siendo del mismo proveedor.

El cambio también exigió ramificar los parámetros de inferencia. Los modelos `gpt-5*` rechazan `max_tokens` y solo aceptan `temperature=1`; el harness usa `max_completion_tokens` para esa familia y detecta cuando todo el presupuesto se consume razonando sin emitir respuesta.

### 3. No se conocía el ruido del juez

`RAG_JUDGE_REPEAT=N` juzga N veces las mismas entradas. La respuesta se genera una sola vez, para no mezclar varianza del generador con varianza del evaluador.

Muestra de 8 preguntas que cubre los cuatro tipos, con 3 repeticiones:

| Medición | Valor |
|---|---:|
| Fragmentos con veredicto unánime | **91.7%** |
| Relevancia — desviación media / rango medio | 3.7 pts / 8.3 pts |
| Groundedness — desviación media / rango medio | 4.3 pts / 9.5 pts |
| **Piso de ruido** | **~9 puntos** |

Una diferencia menor a ~9 puntos entre dos corridas no es señal. El ruido además se concentra en casos ambiguos: cinco preguntas fueron idénticas en las tres corridas, mientras dos mostraron rangos de 20 y 34 puntos. Medir solo preguntas específicas había producido 100% de unanimidad y un piso aparente de ~5 puntos.

El denominador también resultó inestable. Sobre la misma respuesta, el juez contó entre 15 y 26 afirmaciones factuales; el ratio de groundedness fue más estable que sus componentes.

## Lo que Recall@8 no puede medir

- **Relevancia del contexto:** de los 6 fragmentos enviados al modelo, cuántos aportan información.
- **Groundedness:** de las afirmaciones factuales de la respuesta, cuántas están respaldadas.

Un acierto de recall puede tener casi todo el contexto lleno de ruido. “¿Cuáles son los tres pilares de un sueño saludable?” recuperó el episodio esperado en el puesto 3, pero solo **1 de 6** fragmentos servía.

Un fallo de recall también puede producir una respuesta correcta. “¿Cuándo hay que exponerse a la luz solar de la mañana?” no recuperó el episodio esperado, pero devolvió **6/6 fragmentos relevantes** y **8/8 afirmaciones respaldadas**.

Las métricas se validaron con controles extremos antes de usarlas: contexto publicitario frente a mixto, una respuesta con cifras inventadas frente a otra fiel al contexto. Sin esa validación, un juez LLM sería solo otra fuente de números sin verificar.
