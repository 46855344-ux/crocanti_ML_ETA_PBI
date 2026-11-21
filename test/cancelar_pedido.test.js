'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearApp } = require('../app');
const { firmarToken } = require('../seguridad');

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

function crearPoolCancelar({
    estado = 'EN_COCINA',
    correo = 'ana@crocanti.pe',
    existe = true
} = {}) {
    const consultas = [];

    const client = {
        async query(text, values = []) {
            const sql = String(text).trim();
            consultas.push({ sql, values });

            if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) {
                return { rows: [], rowCount: 0 };
            }

            if (/FROM pedidos p/i.test(sql) && /FOR UPDATE/i.test(sql)) {
                if (!existe) return { rows: [], rowCount: 0 };
                return {
                    rows: [{
                        id: Number(values[0]),
                        estado,
                        usuario_id: 9,
                        cliente_correo: correo
                    }],
                    rowCount: 1
                };
            }

            return { rows: [], rowCount: 1 };
        },
        release() {}
    };

    return {
        consultas,
        async connect() { return client; },
        async query(text, values) { return client.query(text, values); }
    };
}

function tokenCliente(correo = 'ana@crocanti.pe') {
    return firmarToken({
        id: 9,
        correo,
        nombre: 'Ana',
        rol: 'cliente'
    });
}

test('POST /api/pedidos/:id/cancelar cancela un pedido en cocina y registra el evento', async () => {
    const pool = crearPoolCancelar({ estado: 'EN_COCINA' });
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos/55/cancelar`, { method: 'POST' });
        assert.equal(respuesta.status, 200);

        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.ok, true);
        assert.equal(cuerpo.id, 55);
        assert.equal(cuerpo.estado, 'CANCELADO');

        const update = pool.consultas.find((c) => /UPDATE pedidos SET estado/i.test(c.sql));
        assert.deepEqual(update.values, ['CANCELADO', 55]);

        const evento = pool.consultas.find((c) => /INSERT INTO eventos_pedido/i.test(c.sql));
        assert.equal(evento.values[2], 'CANCELADO');
        assert.match(String(evento.values[4]), /cliente/i);
        assert.ok(pool.consultas.some((c) => /^COMMIT$/i.test(c.sql)));
    });
});

test('POST /api/pedidos/:id/cancelar responde 409 cuando el pedido ya está listo', async () => {
    const pool = crearPoolCancelar({ estado: 'LISTO' });
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos/55/cancelar`, { method: 'POST' });
        assert.equal(respuesta.status, 409);

        const cuerpo = await respuesta.json();
        assert.match(cuerpo.error, /ya no se puede cancelar/i);
        assert.equal(cuerpo.estado, 'LISTO');

        assert.ok(!pool.consultas.some((c) => /UPDATE pedidos SET estado/i.test(c.sql)));
        assert.ok(pool.consultas.some((c) => /^ROLLBACK$/i.test(c.sql)));
    });
});

test('POST /api/pedidos/:id/cancelar solo permite el dueño del pedido', async () => {
    const pool = crearPoolCancelar({
        estado: 'PENDIENTE',
        correo: 'otro@crocanti.pe'
    });
    const app = crearApp(pool);

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos/55/cancelar`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${tokenCliente('ana@crocanti.pe')}` }
        });
        assert.equal(respuesta.status, 403);

        const cuerpo = await respuesta.json();
        assert.match(cuerpo.error, /permisos/i);
        assert.ok(!pool.consultas.some((c) => /UPDATE pedidos SET estado/i.test(c.sql)));
    });
});

test('POST /api/pedidos/:id/cancelar es idempotente si el pedido ya está cancelado', async () => {
    const pool = crearPoolCancelar({ estado: 'CANCELADO' });
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos/55/cancelar`, { method: 'POST' });
        assert.equal(respuesta.status, 200);

        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.estado, 'CANCELADO');
        assert.equal(cuerpo.sinCambios, true);

        assert.ok(!pool.consultas.some((c) => /UPDATE pedidos SET estado/i.test(c.sql)));
    });
});
