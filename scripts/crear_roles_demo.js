require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const usuarios = [
    {
        nombre: 'Cajero Demo',
        correo: 'cajero@crocanti.com',
        clave: 'cajero123',
        rol: 'cajero'
    },
    {
        nombre: 'Cocina Demo',
        correo: 'cocina@crocanti.com',
        clave: 'cocina123',
        rol: 'cocina'
    }
];

(async () => {
    for (const usuario of usuarios) {
        const hash = await bcrypt.hash(usuario.clave, 10);
        const result = await pool.query(`
            INSERT INTO usuarios (nombre, correo, clave, rol)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (correo) DO UPDATE SET
                nombre = EXCLUDED.nombre,
                clave = EXCLUDED.clave,
                rol = EXCLUDED.rol
            RETURNING id, correo, rol
        `, [usuario.nombre, usuario.correo, hash, usuario.rol]);
        console.log('Usuario listo:', result.rows[0]);
    }
    await pool.end();
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
