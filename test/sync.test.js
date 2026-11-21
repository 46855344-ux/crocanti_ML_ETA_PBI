'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearApp } = require('../app');
const {
    crearServicioSync,
    normalizarOperacion,
    construirSentencia,
    ordenarOperaciones
} = require('../sync');

// ------------------------------------------------------------
// Dobles de prueba (sin base de datos real)
// ------------------------------------------------------------
function crearPoolFalso(opciones = {}) {
    const consultas = [];
    const operaciones = opciones.operaciones || new Map();
    const productosLocales = opciones.productosLocales || new Map();
    const productosPorNombre = opciones.productosPorNombre || new Map();
    const ids = opciones.ids || {};

    return {
        consultas,
        async connect() {
            return {
                async query(text, values = []) {
                    const sql = String(text).trim();
                    consultas.push({ sql, values });

                    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

                    if (/SELECT id_remoto[\s\S]*WHERE entidad = 'PRODUCTO' AND id_local/i.test(sql)) {
                        const id = productosLocales.get(values[0]);
                        return id === undefined
                            ? { rows: [], rowCount: 0 }
                            : { rows: [{ id_remoto: id }], rowCount: 1 };
                    }

                    if (/SELECT id_remoto FROM sync_operaciones/i.test(sql)) {
                        const id = operaciones.get(values[0]);
                        return id === undefined
                            ? { rows: [], rowCount: 0 }
                            : { rows: [{ id_remoto: id }], rowCount: 1 };
                    }

                    if (/SELECT id FROM productos[\s\S]*lower\(trim\(nombre\)\)/i.test(sql)) {
                        const id = productosPorNombre.get(String(values[0]).trim().toLowerCase());
                        return id === undefined
                            ? { rows: [], rowCount: 0 }
                            : { rows: [{ id }], rowCount: 1 };
                    }

                    if (/INSERT INTO sync_operaciones/i.test(sql)) {
                        if (!operaciones.has(values[0])) operaciones.set(values[0], values[3]);
                        return { rows: [], rowCount: 1 };
                    }

                    if (/SELECT NULL::integer/i.test(sql)) return { rows: [{ id: null }], rowCount: 1 };
                    if (/INSERT INTO productos/i.test(sql)) return { rows: [{ id: ids.producto ?? 41 }], rowCount: 1 };
                    if (/INSERT INTO promociones/i.test(sql)) return { rows: [{ id: ids.promocion ?? 7 }], rowCount: 1 };
                    if (/^(UPDATE|DELETE FROM) productos/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };
                    if (/^(UPDATE|DELETE FROM) promociones/i.test(sql)) return { rows: [{ id: values[0] }], rowCount: 1 };

                    return { rows: [], rowCount: 0 };
                },
                release() {}
            };
        }
    };
}

function operacionProducto(extra = {}) {
    return {
        uuidOperation: 'uuid-producto-1',
        entidad: 'PRODUCTO',
        idLocal: 0,
        tipoOperacion: 'INSERT',
        datosJson: JSON.stringify({
            id: 0,
            nombre: 'Pollo Entero',
            categoria: 'Pollo',
            precio: 25.9,
            descripcion: 'Pollo entero crocante',
            imagenEmoji: '🍗',
            disponible: true,
            enPromocion: false
        }),
        fechaCreacion: 1,
        ...extra
    };
}

function operacionPromocion(extra = {}) {
    return {
        uuidOperation: 'uuid-promo-1',
        entidad: 'PROMOCION',
        idLocal: 0,
        tipoOperacion: 'INSERT',
        datosJson: JSON.stringify({
            id: 0,
            productoId: 3,
            productoIdRemoto: 12,
            descuentoPorcentaje: 15,
            activa: true
        }),
        fechaCreacion: 2,
        ...extra
    };
}

// ------------------------------------------------------------
// 1. Normalización del contrato
// ------------------------------------------------------------
test('rechaza una operación sin uuidOperation', () => {
    assert.throws(() => normalizarOperacion({ entidad: 'PRODUCTO', tipoOperacion: 'INSERT' }), /uuidOperation/);
});

test('rechaza una entidad no soportada', () => {
    assert.throws(() => normalizarOperacion(operacionProducto({ entidad: 'USUARIO' })), /Entidad no soportada/);
});

test('rechaza un tipo de operación no soportado', () => {
    assert.throws(() => normalizarOperacion(operacionProducto({ tipoOperacion: 'UPSERT' })), /Tipo de operación/);
});

test('rechaza un datosJson que no es JSON', () => {
    assert.throws(() => normalizarOperacion(operacionProducto({ datosJson: 'no-es-json' })), /JSON válido/);
});

test('toma el idRemoto del payload cuando no viene explícito', () => {
    const op = normalizarOperacion(operacionProducto({ tipoOperacion: 'UPDATE', datosJson: JSON.stringify({ id: 9, nombre: 'X', categoria: 'Y', precio: 1 }) }));
    assert.equal(op.idRemoto, 9);
});

// ------------------------------------------------------------
// 2. Sentencias SQL
// ------------------------------------------------------------
test('el INSERT de producto es idempotente por uuid_operation', () => {
    const { text, values } = construirSentencia(normalizarOperacion(operacionProducto()));
    assert.match(text, /INSERT INTO productos/);
    assert.match(text, /ON CONFLICT \(uuid_operation\) DO UPDATE/);
    assert.equal(values[0], 'uuid-producto-1');
    assert.equal(values[1], 'Pollo Entero');
});

test('el UPDATE de producto usa el id remoto', () => {
    const { text, values } = construirSentencia(
        normalizarOperacion(operacionProducto({ tipoOperacion: 'UPDATE', idRemoto: 12 }))
    );
    assert.match(text, /UPDATE productos SET/);
    assert.match(text, /WHERE id = \$1/);
    assert.equal(values[0], 12);
});

test('el DELETE de producto usa el id remoto', () => {
    const { text, values } = construirSentencia(
        normalizarOperacion(operacionProducto({ tipoOperacion: 'DELETE', idRemoto: 12 }))
    );
    assert.match(text, /DELETE FROM productos WHERE id = \$1/);
    assert.equal(values[0], 12);
});

test('la promoción usa productoIdRemoto cuando existe', () => {
    const { values } = construirSentencia(normalizarOperacion(operacionPromocion()));
    assert.equal(values[1], 12);
});

test('la promoción cae en productoId local cuando no hay remoto', () => {
    const op = operacionPromocion({
        datosJson: JSON.stringify({ productoId: 3, descuentoPorcentaje: 10, activa: true })
    });
    const { values } = construirSentencia(normalizarOperacion(op));
    assert.equal(values[1], 3);
});

test('ordena los productos antes que las promociones', () => {
    const ordenadas = ordenarOperaciones([operacionPromocion(), operacionProducto()]);
    assert.equal(ordenadas[0].entidad, 'PRODUCTO');
});

// ------------------------------------------------------------
// 3. Servicio de sincronización
// ------------------------------------------------------------
test('aplica una operación y registra el id remoto', async () => {
    const pool = crearPoolFalso();
    const servicio = crearServicioSync(pool);

    const resultados = await servicio.procesar([operacionProducto()]);

    assert.equal(resultados.length, 1);
    assert.equal(resultados[0].exito, true);
    assert.equal(resultados[0].idRemoto, 41);
    assert.ok(pool.consultas.some((c) => /INSERT INTO sync_operaciones/i.test(c.sql)));
});

test('no duplica un producto que ya existe en Neon con el mismo nombre', async () => {
    const pool = crearPoolFalso({
        productosPorNombre: new Map([['pollo entero', 41]])
    });
    const servicio = crearServicioSync(pool);

    const resultados = await servicio.procesar([
        operacionProducto({ uuidOperation: 'uuid-producto-duplicado' })
    ]);

    assert.equal(resultados[0].exito, true);
    assert.equal(resultados[0].idRemoto, 41);
    assert.equal(pool.consultas.some((c) => /INSERT INTO productos/i.test(c.sql)), false);
    assert.ok(pool.consultas.some((c) => /UPDATE productos SET/i.test(c.sql)));
});

test('es idempotente: no reaplica una operación ya procesada', async () => {
    const operaciones = new Map([['uuid-producto-1', 41]]);
    const pool = crearPoolFalso({ operaciones });
    const servicio = crearServicioSync(pool);

    const resultados = await servicio.procesar([operacionProducto()]);

    assert.equal(resultados[0].exito, true);
    assert.equal(resultados[0].idRemoto, 41);
    assert.equal(pool.consultas.some((c) => /INSERT INTO productos/i.test(c.sql)), false);
});

test('devuelve error por operación sin afectar a las demás', async () => {
    const pool = crearPoolFalso();
    const servicio = crearServicioSync(pool);

    const resultados = await servicio.procesar([
        operacionProducto(),
        operacionProducto({ uuidOperation: 'uuid-malo', entidad: 'INVENTARIO' })
    ]);

    const malo = resultados.find((r) => r.uuidOperation === 'uuid-malo');
    const bueno = resultados.find((r) => r.uuidOperation === 'uuid-producto-1');

    assert.equal(bueno.exito, true);
    assert.equal(malo.exito, false);
    assert.match(malo.mensajeError, /Entidad no soportada/);
});

test('un UPDATE de una fila inexistente se convierte en INSERT', async () => {
    const pool = crearPoolFalso();
    const servicio = crearServicioSync(pool);

    // La primera consulta UPDATE devuelve rowCount 0 -> se inserta.
    pool.connect = async () => ({
        async query(text, values = []) {
            const sql = String(text).trim();
            pool.consultas.push({ sql, values });
            if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };
            if (/SELECT id_remoto FROM sync_operaciones/i.test(sql)) return { rows: [], rowCount: 0 };
            if (/INSERT INTO sync_operaciones/i.test(sql)) return { rows: [], rowCount: 1 };
            if (/UPDATE productos/i.test(sql)) return { rows: [], rowCount: 0 };
            if (/INSERT INTO productos/i.test(sql)) return { rows: [{ id: 99 }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        },
        release() {}
    });

    const resultados = await servicio.procesar([
        operacionProducto({ tipoOperacion: 'UPDATE', idRemoto: 99 })
    ]);

    assert.equal(resultados[0].exito, true);
    assert.equal(resultados[0].idRemoto, 99);
    assert.ok(pool.consultas.some((c) => /INSERT INTO productos/i.test(c.sql)));
});

test('resuelve el producto remoto de una promoción creada antes de sincronizar su producto', async () => {
    const pool = crearPoolFalso({ productosLocales: new Map([[31, 45]]) });
    const servicio = crearServicioSync(pool);

    const resultados = await servicio.procesar([
        operacionPromocion({
            uuidOperation: 'uuid-promo-offline',
            datosJson: JSON.stringify({
                id: 0,
                productoId: 31,
                descuentoPorcentaje: 10,
                activa: true
            })
        })
    ]);

    assert.equal(resultados[0].exito, true);
    const insercion = pool.consultas.find((c) => /INSERT INTO promociones/i.test(c.sql));
    assert.equal(insercion.values[1], 45);
});

// ------------------------------------------------------------
// 4. Contrato HTTP
// ------------------------------------------------------------
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

test('POST /api/sync responde 400 si no hay operaciones', async () => {
    const app = crearApp(crearPoolFalso(), { syncService: crearServicioSync(crearPoolFalso()), auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operaciones: [] })
        });
        assert.equal(respuesta.status, 400);
    });
});

test('POST /api/sync devuelve el contrato esperado por Android', async () => {
    const servicio = {
        async procesar() {
            return [{ uuidOperation: 'uuid-producto-1', idRemoto: 41, exito: true, mensajeError: null }];
        }
    };
    const app = crearApp(crearPoolFalso(), { syncService: servicio, auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ operaciones: [operacionProducto()] })
        });
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.deepEqual(cuerpo.resultados[0], {
            uuidOperation: 'uuid-producto-1',
            idRemoto: 41,
            exito: true,
            mensajeError: null
        });
    });
});

test('GET /api/promociones traduce snake_case a camelCase', async () => {
    const pool = {
        async query() {
            return {
                rows: [{ id: 1, producto_id: 5, descuento_porcentaje: '15.50', activa: true }],
                rowCount: 1
            };
        }
    };
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/promociones`);
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.deepEqual(cuerpo, [
            { id: 1, productoId: 5, descuentoPorcentaje: 15.5, activa: true }
        ]);
    });
});
