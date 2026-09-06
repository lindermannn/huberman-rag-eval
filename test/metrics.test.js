const test = require('node:test');
const assert = require('node:assert/strict');

const {
  aggregate,
  esFamiliaRazonamiento,
  evalOne,
  parseJson,
  resumirSerie
} = require('../src/metrics');

function rows(episodes) {
  return episodes.map((episode_number, index) => ({
    episode_number,
    similarity: 1 - (index / 100)
  }));
}

test('evalOne registra un acierto en la posicion 1', () => {
  assert.deepEqual(evalOne(rows([42, 7, 9]), [42]), {
    hit: true,
    rank: 1,
    topScore: 1,
    gotEpisodes: [42, 7, 9]
  });
});

test('evalOne registra un acierto en la posicion 8', () => {
  const result = evalOne(rows([1, 2, 3, 4, 5, 6, 7, 42]), [42]);
  assert.equal(result.hit, true);
  assert.equal(result.rank, 8);
});

test('evalOne registra un fallo cuando los resultados no coinciden', () => {
  const result = evalOne(rows([1, 2, 3]), [42]);
  assert.equal(result.hit, false);
  assert.equal(result.rank, null);
});

test('evalOne maneja una lista de resultados vacia', () => {
  assert.deepEqual(evalOne([], [42]), {
    hit: false,
    rank: null,
    topScore: 0,
    gotEpisodes: []
  });
});

test('evalOne ignora episodios nulos y detecta que el esperado esta ausente', () => {
  const result = evalOne([
    { episode_number: null, similarity: 0.9 },
    { episode_number: 7, similarity: 0.8 }
  ], [42]);

  assert.deepEqual(result, {
    hit: false,
    rank: null,
    topScore: 0.9,
    gotEpisodes: [7]
  });
});

test('evalOne marca como no evaluable una pregunta sin ground truth', () => {
  const result = evalOne(rows([1, 2, 3]), []);
  assert.equal(result.hit, null);
  assert.equal(result.rank, null);
});

test('aggregate calcula MRR usando 1/rank en la posicion correcta', () => {
  const result = aggregate([
    { type: 'specific', expectedEpisodes: [1], hit: true, rank: 2 },
    { type: 'specific', expectedEpisodes: [2], hit: true, rank: 4 },
    { type: 'specific', expectedEpisodes: [3], hit: false, rank: null }
  ]);

  assert.equal(result.evaluable, 3);
  assert.equal(result.hits, 2);
  assert.equal(result.recallAtK, 2 / 3);
  assert.equal(result.mrr, ((1 / 2) + (1 / 4)) / 3);
});

test('aggregate excluye preguntas sin ground truth en vez de contarlas como MISS', () => {
  const result = aggregate([
    { type: 'specific', expectedEpisodes: [42], hit: true, rank: 1 },
    { type: 'generic', expectedEpisodes: [], hit: null, rank: null }
  ]);

  assert.deepEqual(result, {
    hits: 1,
    evaluable: 1,
    recallAtK: 1,
    mrr: 1
  });
});

test('aggregate excluye controles fuera de tema aunque tengan episodio esperado', () => {
  const result = aggregate([
    { type: 'specific', expectedEpisodes: [42], hit: true, rank: 2 },
    { type: 'offtopic', expectedEpisodes: [99], hit: false, rank: null }
  ]);

  assert.deepEqual(result, {
    hits: 1,
    evaluable: 1,
    recallAtK: 1,
    mrr: 1 / 2
  });
});

test('aggregate devuelve ceros cuando no hay preguntas evaluables', () => {
  assert.deepEqual(aggregate([]), {
    hits: 0,
    evaluable: 0,
    recallAtK: 0,
    mrr: 0
  });
});

test('parseJson acepta JSON directo y fenced', () => {
  assert.deepEqual(parseJson('{"total":2}'), { total: 2 });
  assert.deepEqual(parseJson('```json\n[true,false]\n```'), [true, false]);
  assert.equal(parseJson('no es json'), null);
});

test('esFamiliaRazonamiento conserva la clasificacion de modelos', () => {
  assert.equal(esFamiliaRazonamiento('gpt-5.6-luna'), true);
  assert.equal(esFamiliaRazonamiento('o1'), true);
  assert.equal(esFamiliaRazonamiento('gpt-4.1'), false);
});

test('resumirSerie conserva media, rango y desviacion poblacional', () => {
  assert.deepEqual(resumirSerie([]), null);
  assert.deepEqual(resumirSerie([1, 3]), {
    n: 2,
    media: 2,
    min: 1,
    max: 3,
    rango: 2,
    desviacion: 1,
    valores: [1, 3]
  });
});
