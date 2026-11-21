'use strict';

// Exporta pedidos entregados reales desde `vw_bi_eta` para reentrenar
// el modelo de ETA cuando existan suficientes registros.
// Uso: npm run exportar-datos-eta

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const SALIDA = path.join(__dirname, '..', 'ml', 'datos_eta_reales.csv');
const COLUMNAS = [
    'distancia_km',
    'carga_cocina',
    'repartidores_disponibles',
    'hora_sin',
    'dia_semana',
    'es_fin_semana',
    'cantidad_items',
    'total',
    'es_delivery',
    'minutos_entrega'
];

function escapar(valor) {
    if (valor === null || valor === undefined) return '';
    return `"${String(valor).replace(/"/g, '""')}"`;
}

async function main() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const resultado = await pool.query(`
            SELECT
                COALESCE(distancia_km, 0) AS distancia_km,
                COALESCE(carga_cocina, 0) AS carga_cocina,
                COALESCE(repartidores_disponibles, 0) AS repartidores_disponibles,
                COALESCE(hora, EXTRACT(HOUR FROM fecha)::int) AS hora_sin,
                COALESCE(dia_semana, EXTRACT(DOW FROM fecha)::int) AS dia_semana,
                COALESCE(es_fin_semana, 0) AS es_fin_semana,
                COALESCE(cantidad_items, 0) AS cantidad_items,
                COALESCE(total, 0) AS total,
                CASE WHEN tipo_entrega = 'DELIVERY' THEN 1 ELSE 0 END AS es_delivery,
                minutos_reales AS minutos_entrega
            FROM vw_bi_eta
            WHERE minutos_reales IS NOT NULL
              AND minutos_reales > 0
            ORDER BY fecha ASC
        `);

        const lineas = [COLUMNAS.map(escapar).join(',')];
        for (const fila of resultado.rows) {
            lineas.push(COLUMNAS.map((c) => escapar(fila[c])).join(','));
        }
        fs.writeFileSync(SALIDA, `\uFEFF${lineas.join('\r\n')}\r\n`, 'utf8');

        console.log(`✅ Datos reales exportados: ${SALIDA}`);
        console.log(`   Filas: ${resultado.rowCount}`);
        if (resultado.rowCount < 100) {
            console.log('   ⚠️  Menos de 100 filas: aún no es suficiente para reentrenar.');
        } else {
            console.log('   Reentrena con: python ml/entrenar_eta.py --datos real');
        }
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error('❌ No se pudieron exportar los datos reales de ETA:', error.message);
    process.exitCode = 1;
});
