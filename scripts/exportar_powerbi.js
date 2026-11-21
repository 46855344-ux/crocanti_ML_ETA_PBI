'use strict';

// ============================================================
// EXPORTACIÓN DE DATOS PARA POWER BI
// ------------------------------------------------------------
// Genera CSV UTF-8 (con BOM) a partir de las vistas vw_bi_*.
// Power BI Desktop puede importar estos CSV o conectarse
// directamente a Neon usando las mismas vistas.
// ============================================================

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const SALIDA = path.join(__dirname, '..', '..', 'powerbi', 'datos');

const EXPORTACIONES = [
    { vista: 'vw_bi_pedidos', archivo: 'pedidos.csv' },
    { vista: 'vw_bi_detalle', archivo: 'detalle_pedidos.csv' },
    { vista: 'vw_bi_productos', archivo: 'productos.csv' },
    { vista: 'vw_bi_repartidores', archivo: 'repartidores.csv' },
    { vista: 'vw_bi_ventas_diarias', archivo: 'ventas_diarias.csv' },
    { vista: 'vw_bi_eta', archivo: 'eta_modelo.csv' }
];

function escapar(valor) {
    if (valor === null || valor === undefined) return '';
    const texto = valor instanceof Date ? valor.toISOString() : String(valor);
    return `"${texto.replace(/"/g, '""')}"`;
}

function aCsv(filas, campos) {
    const encabezado = campos.map((c) => escapar(c.name)).join(',');
    const lineas = filas.map((fila) => campos.map((c) => escapar(fila[c.name])).join(','));
    return `\uFEFF${[encabezado, ...lineas].join('\r\n')}\r\n`;
}

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL no está definido en .env');
    }

    fs.mkdirSync(SALIDA, { recursive: true });
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        for (const item of EXPORTACIONES) {
            const resultado = await pool.query(`SELECT * FROM ${item.vista}`);
            const ruta = path.join(SALIDA, item.archivo);
            fs.writeFileSync(ruta, aCsv(resultado.rows, resultado.fields), 'utf8');
            console.log(`✅ ${item.vista} -> ${item.archivo} (${resultado.rowCount} filas)`);
        }
        console.log(`\nDatos exportados en: ${SALIDA}`);
    } finally {
        await pool.end();
    }
}

main().catch((error) => {
    console.error('❌ No se pudieron exportar los datos para Power BI:', error.message);
    process.exitCode = 1;
});
