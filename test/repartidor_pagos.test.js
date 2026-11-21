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

function crearPoolTurno() {
    const consultas = [];
    return {
        consultas,
        async query(text, values = []) {
            const sql = String(text).trim();
            consultas.push({ sql, values });

            if (/SELECT \* FROM usuarios WHERE lower\(correo\)/i.test(sql)) {
                return {
                    rows: [{
                        id: 6,
                        nombre: 'Repartidor Demo',
                        correo: 'repartidor@crocanti.pe',
                        telefono: '999888777',
                        rol: 'repartidor'
                    }],
                    rowCount: 1
                };
            }

            if (/INSERT INTO repartidores/i.test(sql) && /RETURNING/i.test(sql)) {
                return {
                    rows: [{
                        usuario_id: values[0],
                        turno_activo: values[1],
                        disponible: values[1],
                        latitud: values[2],
                        longitud: values[3]
                    }],
                    rowCount: 1
                };
            }

            return { rows: [], rowCount: 0 };
        }
    };
}

function crearPoolEstado(estadoActual) {
    const consultas = [];

    const client = {
        async query(text, values = []) {
            const sql = String(text).trim();
            consultas.push({ sql, values });

            if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [], rowCount: 0 };

            if (/SELECT \* FROM pedidos WHERE id = \$1 FOR UPDATE/i.test(sql)) {
                return {
                    rows: [{ id: values[0], estado: estadoActual, tipo_pago: 'Efectivo' }],
                    rowCount: 1
                };
            }
            if (/UPDATE pedidos SET estado/i.test(sql)) return { rows: [], rowCount: 1 };
            if (/INSERT INTO eventos_pedido/i.test(sql)) return { rows: [], rowCount: 1 };

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

test('PUT /api/repartidor/turno activa el turno y devuelve la ubicación', async () => {
    const pool = crearPoolTurno();
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/repartidor/turno`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                correo: 'repartidor@crocanti.pe',
                activo: true,
                latitud: -6.77137,
                longitud: -79.84088
            })
        });

        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.ok, true);
        assert.equal(cuerpo.turnoActivo, true);
        assert.equal(cuerpo.disponible, true);
        assert.equal(cuerpo.latitud, -6.77137);
    });
});

test('PUT /api/pedidos/:id/estado rechaza una transición inválida', async () => {
    const pool = crearPoolEstado('PENDIENTE');
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos/5/estado`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: 'ENTREGADO' })
        });

        assert.equal(respuesta.status, 409);
        const cuerpo = await respuesta.json();
        assert.match(cuerpo.error, /No se puede pasar de PENDIENTE a ENTREGADO/);
        assert.deepEqual(cuerpo.transicionesPermitidas, ['RECIBIDO', 'EN_COCINA', 'CANCELADO']);
        assert.ok(pool.consultas.some((c) => /^ROLLBACK$/i.test(c.sql)));
    });
});

test('PUT /api/pedidos/:id/estado permite pasar a EN_COCINA', async () => {
    const pool = crearPoolEstado('PENDIENTE');
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/pedidos/5/estado`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                estado: 'EN_COCINA',
                usuarioCorreo: 'repartidor@crocanti.pe',
                nota: 'Pedido en preparación'
            })
        });

        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.ok, true);
        assert.equal(cuerpo.estado, 'EN_COCINA');
        assert.ok(cuerpo.transicionesPermitidas.includes('LISTO'));
        assert.ok(pool.consultas.some((c) => /^COMMIT$/i.test(c.sql)));
    });
});

test('POST /api/pagos/qr genera el payload y la confirmación cambia el estado', async () => {
    const consultas = [];
    const pool = {
        async query(text, values = []) {
            const sql = String(text).trim();
            consultas.push({ sql, values });

            if (/SELECT id, numero_orden, total FROM pedidos/i.test(sql)) {
                return {
                    rows: [{ id: 5, numero_orden: 'ORD-000005', total: '25.50' }],
                    rowCount: 1
                };
            }

            if (/INSERT INTO pagos/i.test(sql) && /RETURNING/i.test(sql)) {
                return {
                    rows: [{
                        id: 11,
                        pedido_id: values[1],
                        medio: values[2],
                        monto: values[3],
                        referencia: values[4],
                        estado: 'QR_GENERADO',
                        expira_en: values[5]
                    }],
                    rowCount: 1
                };
            }

            if (/UPDATE pagos/i.test(sql) && /RETURNING/i.test(sql)) {
                return {
                    rows: [{
                        id: values[1],
                        pedido_id: 5,
                        estado: 'CONFIRMADO',
                        nro_operacion_banco: values[0],
                        confirmado_en: '2026-11-06T00:00:00.000Z'
                    }],
                    rowCount: 1
                };
            }

            return { rows: [], rowCount: 0 };
        }
    };

    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const generado = await fetch(`${url}/api/pagos/qr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pedidoId: 5, monto: 25.5, medio: 'QR' })
        });

        assert.equal(generado.status, 201);
        const pago = await generado.json();
        assert.equal(pago.pedidoId, 5);
        assert.match(pago.qrPayload, /^BANCO-ANDINO\|QR-5-/);
        assert.match(pago.qrPayload, /25\.50\|ORD-000005$/);

        const confirmado = await fetch(`${url}/api/pagos/11/confirmar`, {
            method: 'POST'
        });
        assert.equal(confirmado.status, 200);
        const confirmacion = await confirmado.json();
        assert.equal(confirmacion.ok, true);
        assert.equal(confirmacion.estado, 'CONFIRMADO');
        assert.match(confirmacion.nroOperacionBanco, /^BA-/);
    });
});
