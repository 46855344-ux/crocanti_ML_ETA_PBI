'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function main() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL no está definido en .env');
    }

    const archivo = path.join(__dirname, '..', 'sql', '009_catalogo_inicial.sql');
    const sql = fs.readFileSync(archivo, 'utf8');
    const client = await pool.connect();

    try {
        await client.query(sql);
        const resultado = await client.query('SELECT count(*)::int AS total FROM productos');
        console.log(`✅ Catálogo inicial aplicado. Productos en Neon: ${resultado.rows[0].total}`);
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error('❌ No se pudo aplicar el catálogo inicial:', error.message);
    process.exitCode = 1;
});
