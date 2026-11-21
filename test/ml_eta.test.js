'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearApp } = require('../app');
const {
    construirFeaturesEta,
    predecirEta,
    obtenerMetricasEta
} = require('../ml/eta_model');

async function conServidor(app, fn) {
    const servidor = app.listen(0);
    await new Promise((resolve) => servidor.once('listening', resolve));
    const { port } = servidor.address();
    try {
        return await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => servidor.close(resolve));
    }
}

test('el modelo ETA reporta métricas mejores que la heurística', () => {
    const metricas = obtenerMetricasEta();
    assert.equal(metricas.version, 'eta_rf_v1');
    assert.ok(metricas.features.includes('distancia_km'));
    assert.ok(metricas.metricas.mae_modelo > 0);
    assert.ok(metricas.metricas.mae_modelo < metricas.metricas.mae_heuristico);
    assert.ok(metricas.metricas.r2_modelo > 0.8);
    assert.ok(metricas.n_estimators > 0);
});

test('construirFeaturesEta respeta el orden del modelo', () => {
    const features = construirFeaturesEta({
        distancia_km: 4.2,
        carga_cocina: 3,
        repartidores_disponibles: 2,
        hora_sin: 13,
        dia_semana: 5,
        es_fin_semana: 1,
        cantidad_items: 4,
        total: 55,
        es_delivery: 1
    });
    assert.equal(features.length, 9);
    assert.deepEqual(features, [4.2, 3, 2, 13, 5, 1, 4, 55, 1]);
});

test('la predicción de ETA es coherente y devuelve intervalo', () => {
    const delivery = predecirEta({
        distancia_km: 4.2,
        carga_cocina: 3,
        repartidores_disponibles: 2,
        hora_sin: 13,
        dia_semana: 5,
        es_fin_semana: 1,
        cantidad_items: 4,
        total: 55,
        es_delivery: 1
    });
    assert.ok(delivery);
    assert.ok(delivery.etaMinutos >= 8 && delivery.etaMinutos <= 90);
    assert.ok(delivery.etaMinimo <= delivery.etaMinutos);
    assert.ok(delivery.etaMaximo >= delivery.etaMinutos);
    assert.equal(delivery.modelo, 'eta_rf_v1');

    const recojo = predecirEta({
        distancia_km: 0,
        carga_cocina: 5,
        repartidores_disponibles: 0,
        hora_sin: 20,
        dia_semana: 1,
        es_fin_semana: 0,
        cantidad_items: 2,
        total: 30,
        es_delivery: 0
    });
    assert.ok(recojo);
    assert.ok(recojo.etaMinutos >= 8 && recojo.etaMinutos <= 90);
});

test('GET /api/ml/eta/modelo expone las métricas del modelo', async () => {
    const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/ml/eta/modelo`);
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.version, 'eta_rf_v1');
        assert.ok(cuerpo.metricas.mae_modelo < cuerpo.metricas.mae_heuristico);
        assert.ok(Array.isArray(cuerpo.features));
    });
});
