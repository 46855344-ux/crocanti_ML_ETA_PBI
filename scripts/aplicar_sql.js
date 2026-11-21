'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

async function main() {
    const argumento = process.argv[2];
    if (!argumento) {
        throw new Error('Uso: node scripts/aplicar_sql.js sql/archivo.sql');
    }

    const archivo = path.isAbsolute(argumento)
        ? argumento
        : path.join(__dirname, '..', argumento);
    if (!fs.existsSync(archivo)) {
        throw new Error(`No existe el archivo: ${archivo}`);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    const client = await pool.connect();

    try {
        const sql = fs.readFileSync(archivo, 'utf8');
        const resultado = await client.query(sql);
        const ultimo = Array.isArray(resultado) ? resultado[resultado.length - 1] : resultado;
        console.log(`✅ SQL aplicado: ${path.basename(archivo)}`);
        if (ultimo && ultimo.rows && ultimo.rows.length) {
            console.log(ultimo.rows);
        }
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch((error) => {
    console.error('❌ Error al aplicar SQL:', error.message);
    process.exitCode = 1;
});
