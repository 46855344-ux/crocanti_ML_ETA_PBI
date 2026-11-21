'use strict';

// ============================================================
// MIGRACIÓN DE CONTRASEÑAS A BCRYPT
// ------------------------------------------------------------
// Uso: npm run hashear-claves
// Recorre los usuarios cuya clave aún está en texto plano y la
// reemplaza por un hash bcrypt. Es idempotente.
// ============================================================

require('dotenv').config();

const { Client } = require('pg');
const { hashearClave, esHashBcrypt } = require('../seguridad');

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    await client.connect();
    const resultado = await client.query('SELECT id, correo, clave FROM usuarios ORDER BY id');

    let migradas = 0;
    for (const usuario of resultado.rows) {
        if (esHashBcrypt(usuario.clave)) continue;
        const hash = await hashearClave(usuario.clave);
        await client.query('UPDATE usuarios SET clave = $1 WHERE id = $2', [hash, usuario.id]);
        migradas += 1;
        console.log(`✔ ${usuario.correo} migrado a bcrypt`);
    }

    console.log(`\nTotal de claves migradas: ${migradas}`);
    await client.end();
}

main().catch((error) => {
    console.error('No se pudieron migrar las claves:', error.message);
    process.exit(1);
});
