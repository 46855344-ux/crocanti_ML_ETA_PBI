'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crearApp } = require('../app');
const { hashearClave, firmarToken } = require('../seguridad');

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

function crearPoolSeguridad(usuario, consultas = []) {
    async function responder(text, values = []) {
        const sql = String(text).trim();
        consultas.push({ sql, values });

        if (/SELECT \* FROM usuarios WHERE lower\(correo\)/i.test(sql)) {
            return { rows: usuario ? [usuario] : [], rowCount: usuario ? 1 : 0 };
        }

        if (/UPDATE usuarios SET clave/i.test(sql)) {
            return { rows: [], rowCount: 1 };
        }

        if (/INSERT INTO usuarios/i.test(sql)) {
            return {
                rows: [{
                    id: 20,
                    nombre: values[0],
                    correo: values[1],
                    clave: values[2],
                    rol: values[3],
                    telefono: values[4]
                }],
                rowCount: 1
            };
        }

        if (/INSERT INTO repartidores/i.test(sql)) {
            return {
                rows: [{
                    usuario_id: values[0],
                    turno_activo: false,
                    disponible: true
                }],
                rowCount: 1
            };
        }

        if (/FROM pedidos p/i.test(sql)) {
            return {
                rows: [{
                    pedidos: '2',
                    total_ventas: '50.00',
                    total_entregado: '50.00',
                    total_qr: '20.00',
                    total_efectivo: '30.00'
                }],
                rowCount: 1
            };
        }

        if (/FROM pagos/i.test(sql)) {
            return { rows: [{ total_abonos: '20.00' }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
    }

    return {
        consultas,
        async query(text, values = []) {
            return responder(text, values);
        },
        async connect() {
            return {
                query: (text, values = []) => responder(text, values),
                release: () => {}
            };
        }
    };
}

test('login devuelve un JWT y actualiza una clave antigua a bcrypt', async () => {
    const usuario = {
        id: 6,
        nombre: 'Repartidor Demo',
        correo: 'repartidor@crocanti.pe',
        telefono: '999888777',
        rol: 'repartidor',
        clave: 'repartidor123'
    };
    const app = crearApp(crearPoolSeguridad(usuario));

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correo: 'repartidor@crocanti.pe', clave: 'repartidor123' })
        });

        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.rol, 'repartidor');
        assert.match(cuerpo.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    });
});

test('login rechaza una clave incorrecta sin revelar el motivo', async () => {
    const claveHash = await hashearClave('correcta123');
    const usuario = {
        id: 4,
        nombre: 'Cliente',
        correo: 'cliente@crocanti.com',
        telefono: '',
        rol: 'cliente',
        clave: claveHash
    };
    const app = crearApp(crearPoolSeguridad(usuario));

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ correo: 'cliente@crocanti.com', clave: 'incorrecta' })
        });

        assert.equal(respuesta.status, 401);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.error, 'Credenciales incorrectas');
    });
});

test('un endpoint protegido responde 401 sin token y 403 si el rol no alcanza', async () => {
    const app = crearApp(crearPoolSeguridad(null));

    await conServidor(app, async (url) => {
        const sinToken = await fetch(`${url}/api/caja/cierre`);
        assert.equal(sinToken.status, 401);

        const tokenCliente = firmarToken({
            id: 4,
            nombre: 'Cliente',
            correo: 'cliente@crocanti.com',
            rol: 'cliente'
        });
        const conCliente = await fetch(`${url}/api/caja/cierre`, {
            headers: { Authorization: `Bearer ${tokenCliente}` }
        });
        assert.equal(conCliente.status, 403);

        const tokenAdmin = firmarToken({
            id: 2,
            nombre: 'admin',
            correo: 'admin@crocanti.com',
            rol: 'administrador'
        });
        const conAdmin = await fetch(`${url}/api/caja/cierre`, {
            headers: { Authorization: `Bearer ${tokenAdmin}` }
        });
        assert.equal(conAdmin.status, 200);
    });
});

test('el registro no permite crear un administrador sin código de invitación', async () => {
    const app = crearApp(crearPoolSeguridad(null));

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Intruso',
                correo: 'intruso@crocanti.com',
                clave: 'clave123',
                rol: 'administrador'
            })
        });

        assert.equal(respuesta.status, 403);
    });
});

test('el registro con código de administrador crea el rol correcto', async () => {
    const app = crearApp(crearPoolSeguridad(null));

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Nuevo Admin',
                correo: 'nuevo@crocanti.com',
                clave: 'clave123',
                rol: 'administrador',
                codigoInvitacion: process.env.ADMIN_INVITE_CODE || 'CROCANTI-ADMIN'
            })
        });

        assert.equal(respuesta.status, 201);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.rol, 'administrador');
        assert.match(cuerpo.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    });
});

test('el registro de repartidor exige el código de invitación correcto', async () => {
    const app = crearApp(crearPoolSeguridad(null));

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Repartidor Intruso',
                correo: 'intruso.reparto@crocanti.com',
                clave: 'clave123',
                rol: 'repartidor',
                codigoInvitacion: 'CODIGO-INCORRECTO'
            })
        });

        assert.equal(respuesta.status, 403);
    });
});

test('el registro con código de repartidor crea usuario y fila en repartidores', async () => {
    const pool = crearPoolSeguridad(null);
    const app = crearApp(pool);

    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Nuevo Repartidor',
                correo: 'nuevo.reparto@crocanti.com',
                clave: 'clave123',
                telefono: '987654321',
                rol: 'repartidor',
                codigoInvitacion: process.env.REPARTIDOR_INVITE_CODE || 'CROCANTI-REPARTIDOR'
            })
        });

        assert.equal(respuesta.status, 201);
        const cuerpo = await respuesta.json();
        assert.equal(cuerpo.rol, 'repartidor');
        assert.match(cuerpo.token, /^[\w-]+\.[\w-]+\.[\w-]+$/);

        const altaRepartidor = pool.consultas.find((c) => /INSERT INTO repartidores/i.test(c.sql));
        assert.ok(altaRepartidor, 'debe crear la fila operativa del repartidor');
        assert.equal(altaRepartidor.values[0], 20);
    });
});
