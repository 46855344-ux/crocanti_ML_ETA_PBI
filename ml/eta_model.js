'use strict';

// ============================================================
// INFERENCIA DEL MODELO DE ETA · CROCANTI
// ------------------------------------------------------------
// El modelo se entrena con `ml/entrenar_eta.py` y se exporta a
// `ml/modelo_eta.json`. Aquí solo se recorre el bosque; no se
// necesita Python en producción.
// ============================================================

const fs = require('fs');
const path = require('path');

const RUTA_MODELO = path.join(__dirname, 'modelo_eta.json');
let modeloCache = null;

function cargarModelo() {
    if (modeloCache) return modeloCache;
    const crudo = fs.readFileSync(RUTA_MODELO, 'utf8');
    modeloCache = JSON.parse(crudo);
    return modeloCache;
}

function limitar(valor, minimo = 8, maximo = 90) {
    return Math.max(minimo, Math.min(maximo, valor));
}

function predecirArbol(nodos, valores) {
    let indice = 0;
    // Los árboles exportados tienen una profundidad máxima pequeña.
    for (let paso = 0; paso < 64; paso += 1) {
        const nodo = nodos[indice];
        if (!nodo) return null;
        if (Object.prototype.hasOwnProperty.call(nodo, 'v')) return nodo.v;

        const valor = valores[nodo.f];
        indice = valor <= nodo.t ? nodo.l : nodo.r;
    }
    return null;
}

/**
 * Construye el vector de features en el orden exacto del modelo.
 * Las variables no disponibles se envían como 0.
 */
function construirFeaturesEta(datos = {}) {
    const modelo = cargarModelo();
    return modelo.features.map((nombre) => {
        const valor = Number(datos[nombre] ?? 0);
        return Number.isFinite(valor) ? valor : 0;
    });
}

/**
 * Devuelve la predicción del bosque y un intervalo aproximado de 90 %
 * usando la dispersión entre árboles.
 */
function predecirEta(datos = {}) {
    try {
        const modelo = cargarModelo();
        const valores = construirFeaturesEta(datos);
        if (valores.length !== modelo.features.length) return null;

        const predicciones = [];
        for (const arbol of modelo.arboles) {
            const valor = predecirArbol(arbol.nodos, valores);
            if (Number.isFinite(valor)) predicciones.push(valor);
        }
        if (!predicciones.length) return null;

        const media = predicciones.reduce((a, b) => a + b, 0) / predicciones.length;
        const varianza = predicciones.reduce((a, b) => a + (b - media) ** 2, 0) /
            predicciones.length;
        const desviacion = Math.sqrt(varianza);
        const margen = 1.645 * desviacion;
        const [minimo, maximo] = modelo.rango || [8, 90];

        return {
            etaMinutos: Math.round(limitar(media, minimo, maximo)),
            etaMinimo: Math.round(limitar(media - margen, minimo, maximo)),
            etaMaximo: Math.round(limitar(media + margen, minimo, maximo)),
            desviacionMinutos: Number(desviacion.toFixed(2)),
            modelo: modelo.version,
            arboles: modelo.arboles.length
        };
    } catch (error) {
        return null;
    }
}

function obtenerMetricasEta() {
    const modelo = cargarModelo();
    return {
        version: modelo.version,
        algoritmo: modelo.algoritmo,
        dataset: modelo.dataset,
        entrenado_en: modelo.entrenado_en,
        target: modelo.target,
        features: modelo.features,
        rango: modelo.rango,
        n_estimators: modelo.n_estimators,
        max_depth: modelo.max_depth,
        metricas: modelo.metricas,
        importancia_features: modelo.importancia_features,
        nota: 'Modelo entrenado con dataset sintético académico. Reentrenar con pedidos reales cuando existan suficientes.'
    };
}

module.exports = {
    cargarModelo,
    construirFeaturesEta,
    predecirEta,
    obtenerMetricasEta
};
