# Contaminación publicitaria invisible para Recall@8

[← Volver al README](../../README.md)

Una consulta real —“suplementos para entrenar fuerza”— devolvió **6 de 6 fragmentos publicitarios**. No había contenido sobre creatina o proteína. El modelo respondió desde conocimiento preentrenado y el código añadió seis enlaces reales que no respaldaban el texto.

La publicidad se repetía en cientos de episodios y saturaba términos genéricos como “suplementos”, “sueño” y “enfoque”. El contenido sustantivo solía mencionar compuestos concretos, por lo que perdía esos puestos.

## Dos reglas fallidas antes de encontrar una útil

1. **Palabras clave:** marcaba 245 fragmentos, pero solo capturaba 1 de los 6 culpables. El propio anuncio usaba lenguaje de “protocolo de suplementación” y pasaba por contenido legítimo.
2. **Texto repetido entre episodios:** encontraba copy publicitario, pero también bloques de ~3.000 caracteres que empezaban con una introducción y terminaban explicando neuronas y neurotransmisores. Aplicarlo habría destruido contenido real.
3. **Longitud:** los fragmentos cortos eran publicidad pura; los largos eran mixtos y debían conservarse.

Se desactivaron 46 fragmentos, 0.17% de la KB, todos segmentos de menos de 2.000 caracteres. La revisión posterior encontró **4 falsos positivos** y los restauró. Uno era `hub-ep108-proto21`, el protocolo más útil para responder sobre suplementación. La regla se había validado contra los culpables, pero no contra todos los tipos de contenido afectados.

## El golden set no mostró la mejora

Al comparar la evaluación antes y después, **los 36 conjuntos recuperados fueron idénticos**. Recall@8 y MRR no cambiaron.

No era una prueba de que la limpieza fuese inútil. Era evidencia de que el instrumento no cubría la consulta genérica que había causado el incidente. La versión posterior del set incorporó 6 preguntas genéricas tomadas de logs reales y las evaluó por relevancia del contexto, sin imponer un único episodio como ground truth.

## Verificación end-to-end

Se repitió la misma consulta en producción antes y después:

| | Antes (`8688`) | Después (`8707`) |
|---|---:|---:|
| Fuentes publicitarias | **6 de 6** | **0 de 6** |
| Datos verificables en el contexto | ninguno | todos |
| Confianza reportada | 0.55 | 0.67 |

Después de la limpieza, cada dato podía rastrearse a un fragmento citado: 3 a 5 gramos diarios de creatina; ~5 g/día para ~82 kg; más de 66 estudios y 12-20% de potencia; beta-alanina para esfuerzos de 60-240 segundos en dosis de 2-5 g; y la recomendación de evitar megadosis de vitamina C.

La instrucción de usar exclusivamente la base ya existía. El problema era que el contexto no contenía información útil. La prueba manual confirmó el arreglo, pero no escala; por eso el harness mide ahora relevancia del contexto y groundedness además de ranking.

La conclusión metodológica es precisa: **Recall@8 responde si apareció el episodio esperado, no si los puestos recuperados sirven ni si la respuesta se apoya en ellos.**
