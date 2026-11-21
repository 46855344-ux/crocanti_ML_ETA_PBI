'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearApp } = require('../app');

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

function crearPoolPedidos() {
    const consultas = [];

    const client = {
        async query(text, values = []) {
            const sql = String(text).trim();
            consultas.push({ sql, values });

            if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

            if (/SELECT id FROM usuarios/i.test(sql)) return { rows: [{ id: 9 }], rowCount: 1 };
            if (/SELECT id FROM tiendas/i.test(sql)) return { rows: [{ id: 2 }], rowCount: 1 };

            if (/INSERT INTO pedidos/i.test(sql)) {
                return {
                    rows: [{
                        id: 100,
                        numero_orden: values[0],
                        total: values[1],
                        tienda: values[2],
                        tienda_id: values[3],
                        usuario_id: values[4],
                        tipo_pago: values[5],
                        codigo_operacion: values[6],
                        direccion_entrega: values[7],
                        estado: values[8],
                        fecha: values[9],
                        uuid_operation: values[10]
                    }],
                    rowCount: 1
                };
            }

            if (/INSERT INTO detalle_pedido/i.test(sql)) return { rows: [], rowCount: 1 };

            return { rows: [], rowCount: 0 };
        },
        release() {}
    };

    return {
        consultas,
        async connect() { return client; },
        async query(text, values) { return client.query(text, values); }
    };
}

test('POST /api/auth/login devuelve el id del usuario', async () => {
    const pool = {
        async query() {
            return {
                rows: [{
                    id: 4,
                    nombre: 'Ana',
                    correo: 'ana@crocanti.pe',
                    rol: 'cliente',
                    telefono: '',
                    clave: '123456'
                }],
                rowCount: 1
            };
        }
    };
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correo: 'ana@crocanti.pe', clave: '123456' })
        });
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.id, 4);
    });
});

test('GET /api/tiendas traduce snake_case a camelCase', async () => {
    const pool = {
        async query() {
            return {
                rows: [{ id: 2, nombre: 'Tienda Chiclayo Centro', direccion: 'Av. 1', telefono: '123', activa: true }],
                rowCount: 1
            };
        }
    };
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/tiendas`);
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.deepEqual(cuerpo, [{
            id: 2,
            nombre: 'Tienda Chiclayo Centro',
            direccion: 'Av. 1',
            telefono: '123',
            activa: true
        }]);
    });
});

test('POST /api/pedidos guarda cabecera, resuelve cliente/tienda y detalle', async () => {
    const pool = crearPoolPedidos();
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                numeroOrden: 'ORD-000001',
                total: 20.5,
                tienda: 'Tienda Chiclayo Centro',
                tipoPago: 'Efectivo',
                usuarioCorreo: 'ana@crocanti.pe',
                detalles: [
                    { productoId: 3, nombreProducto: 'Pollo Entero', cantidad: 2, precioUnitario: 10.25 }
                ]
            })
        });

        assert.equal(respuesta.status, 201);
        const cuerpo = await respuesta.json();

        assert.equal(cuerpo.id, 100);
        assert.equal(cuerpo.usuarioId, 9);
        assert.equal(cuerpo.tiendaId, 2);
        assert.equal(cuerpo.detalles.length, 1);
        assert.equal(cuerpo.detalles[0].subtotal, 20.5);
        assert.ok(pool.consultas.some((c) => /INSERT INTO detalle_pedido/i.test(c.sql)));
        assert.ok(pool.consultas.some((c) => /DELETE FROM detalle_pedido/i.test(c.sql)));
        assert.ok(pool.consultas.some((c) => /\(SELECT id FROM productos WHERE id = \$2\)/i.test(c.sql)));
        assert.ok(pool.consultas.some((c) => /COMMIT/i.test(c.sql)));
    });
});

test('POST /api/pedidos responde 400 sin número de orden', async () => {
    const app = crearApp(crearPoolPedidos(), { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ total: 10 })
        });
        assert.equal(respuesta.status, 400);
    });
});
