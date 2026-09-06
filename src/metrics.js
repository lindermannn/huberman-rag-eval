function parseJson(text) {
  try { return JSON.parse(text.replace(/^```(?:json)?\s*|```$/g, '').trim()); }
  catch (e) { return null; }
}

function esFamiliaRazonamiento(model) {
  return /^(gpt-5|o[1-9])/.test(model);
}

function resumirSerie(valores) {
  if (valores.length === 0) return null;
  const media = valores.reduce((a, b) => a + b, 0) / valores.length;
  const varianza = valores.reduce((a, b) => a + (b - media) ** 2, 0) / valores.length;
  return {
    n: valores.length,
    media,
    min: Math.min(...valores),
    max: Math.max(...valores),
    rango: Math.max(...valores) - Math.min(...valores),
    desviacion: Math.sqrt(varianza),
    valores
  };
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

function aggregate(resultados) {
  let hits = 0;
  let evaluable = 0;
  let mrrSum = 0;

  for (const resultado of resultados) {
    // Recall/MRR solo aplican a preguntas CON ground truth de episodio.
    // Las genericas no lo tienen a proposito: una consulta amplia puede tener
    // muchos episodios validos, y contarla como MISS deprimiria ambas metricas.
    const tieneGroundTruth = (resultado.expectedEpisodes || []).length > 0;
    if (resultado.type !== 'offtopic' && tieneGroundTruth) {
      evaluable++;
      if (resultado.hit) {
        hits++;
        mrrSum += 1 / resultado.rank;
      }
    }
  }

  return {
    hits,
    evaluable,
    recallAtK: evaluable ? (hits / evaluable) : 0,
    mrr: evaluable ? (mrrSum / evaluable) : 0
  };
}

module.exports = {
  aggregate,
  esFamiliaRazonamiento,
  evalOne,
  parseJson,
  resumirSerie
};
