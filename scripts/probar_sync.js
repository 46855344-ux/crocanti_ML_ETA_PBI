'use strict';

// ============================================================
// PRUEBA REAL DE SINCRONIZACIÓN CONTRA NEON
// ------------------------------------------------------------
// Requiere que el backend esté corriendo.
//
// Uso:
//   node scripts/probar_sync.js admin@crocanti.com TU_CLAVE
//
// También puedes definir ADMIN_CORREO y ADMIN_CLAVE en el entorno.
//
// El script inserta un producto temporal, comprueba la idempotencia,
// lo actualiza, lo elimina y verifica cada cambio directamente en
// Neon. Al final limpia cualquier residuo.
// ============================================================

require('dotenv').config();

const crypto = require('crypto');
const { Client } = require('pg');

const BASE = process.env.API_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
const correo = process.argv[2] || process.env.ADMIN_CORREO || 'admin@crocanti.com';
const clave = process.argv[3] || process.env.ADMIN_CLAVE;

if (!clave) {
    console.error('Falta la contraseña del administrador.');
    console.error('Uso: node scripts/probar_sync.js admin@crocanti.com TU_CLAVE');
    process.exit(1);
}

async function api(ruta, opciones = {}) {
    const respuesta = await fetch(BASE + ruta, opciones);
    const texto = await respuesta.text();
    let cuerpo = null;
    try {
        cuerpo = texto ? JSON.parse(texto) : null;
    } catch {
        cuerpo = texto;
    }
    return { status: respuesta.status, body: cuerpo };
}

function operacion(uuid, tipo, idRemoto, datos) {
    return {
        uuidOperation: uuid,
        entidad: 'PRODUCTO',
        idLocal: 9001,
        idRemoto,
        tipoOperacion: tipo,
        datosJson: JSON.stringify(datos)
    };
}

async function main() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    await client.connect();

    const nombre = `PRUEBA SYNC ${Date.now()}`;
    let idRemoto = null;

    try {
        const salud = await api('/api/health');
        console.log(`Salud del backend: ${salud.status} ${JSON.stringify(salud.body)}`);

        const login = await api('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correo, clave })
        });
        if (login.status !== 200 || !login.body?.token) {
            throw new Error(`Login falló (${login.status}): ${JSON.stringify(login.body)}`);
        }
        const headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${login.body.token}`
        };
        console.log(`Login correcto: ${login.body.correo} (${login.body.rol})`);

        const datos = {
            id: 0,
            nombre,
            categoria: 'PRUEBA',
            precio: 10.5,
            descripcion: 'Producto temporal de prueba',
            imagenEmoji: '🧪',
            disponible: true,
            enPromocion: false
        };

        const uuidInsert = crypto.randomUUID();
        const insert = await api('/api/sync', {
            method: 'POST',
            headers,
            body: JSON.stringify({ operaciones: [operacion(uuidInsert, 'INSERT', null, datos)] })
        });
        idRemoto = insert.body?.resultados?.[0]?.idRemoto ?? null;
        console.log(`INSERT: ${insert.status} idRemoto=${idRemoto}`);
        console.log('  Neon:', JSON.stringify((await client.query(
            'SELECT id, nombre, precio FROM productos WHERE id = $1', [idRemoto]
        )).rows[0]));

        const repetido = await api('/api/sync', {
            method: 'POST',
            headers,
            body: JSON.stringify({ operaciones: [operacion(uuidInsert, 'INSERT', null, datos)] })
        });
        const conteo = await client.query(
            'SELECT count(*)::int AS n FROM productos WHERE lower(nombre) = lower($1)', [nombre]
        );
        console.log(`IDEMPOTENCIA: ${repetido.status} id=${repetido.body?.resultados?.[0]?.idRemoto} filas=${conteo.rows[0].n}`);

        const uuidUpdate = crypto.randomUUID();
        const actualizado = { ...datos, precio: 99.99, descripcion: 'Precio actualizado por sync' };
        const update = await api('/api/sync', {
            method: 'POST',
            headers,
            body: JSON.stringify({ operaciones: [operacion(uuidUpdate, 'UPDATE', idRemoto, actualizado)] })
        });
        console.log(`UPDATE: ${update.status}`);
        console.log('  Neon:', JSON.stringify((await client.query(
            'SELECT id, nombre, precio, descripcion FROM productos WHERE id = $1', [idRemoto]
        )).rows[0]));

        const uuidDelete = crypto.randomUUID();
        const borrar = await api('/api/sync', {
            method: 'POST',
            headers,
            body: JSON.stringify({ operaciones: [operacion(uuidDelete, 'DELETE', idRemoto, actualizado)] })
        });
        const restantes = await client.query('SELECT count(*)::int AS n FROM productos WHERE id = $1', [idRemoto]);
        console.log(`DELETE: ${borrar.status} filas_restantes=${restantes.rows[0].n}`);

        const bitacora = await client.query(
            `SELECT tipo_operacion, id_remoto, id_local
             FROM sync_operaciones
             WHERE uuid_operation = ANY($1)
             ORDER BY procesado_en`,
            [[uuidInsert, uuidUpdate, uuidDelete]]
        );
        console.log('Bitácora en Neon:');
        bitacora.rows.forEach((fila) => console.log(' ', JSON.stringify(fila)));
        idRemoto = null;
        console.log('\nPrueba de sincronización completada correctamente.');
    } finally {
        if (idRemoto !== null) {
            await client.query('DELETE FROM productos WHERE id = $1', [idRemoto]).catch(() => {});
        }
        await client.query('DELETE FROM productos WHERE lower(nombre) = lower($1)', [nombre]).catch(() => {});
        await client.end();
    }
}

main().catch((error) => {
    console.error('La prueba falló:', error.message);
    process.exit(1);
});
