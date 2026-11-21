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

function productoFila(id, nombre, disponible = true) {
    return {
        id,
        nombre,
        categoria: 'Pollo',
        precio: '12.50',
        descripcion: 'Producto de prueba',
        imagen_emoji: '🍗',
        imagen_url: null,
        disponible,
        en_promocion: false,
        uuid_operation: `uuid-producto-${id}`
    };
}

function crearPoolCrud() {
    const productos = [
        productoFila(1, 'Pollo Entero', true),
        productoFila(2, 'Producto Oculto', false)
    ];
    const promociones = [{
        id: 1,
        producto_id: 1,
        descuento_porcentaje: '10.00',
        activa: true,
        uuid_operation: 'uuid-promo-1'
    }];
    let siguienteProducto = 3;
    let siguientePromocion = 2;

    async function query(text, values = []) {
        const sql = String(text).replace(/\s+/g, ' ').trim();

        if (/SELECT DISTINCT ON .* FROM productos/i.test(sql)) {
            let filas = [...productos];
            if (/WHERE disponible = true/i.test(sql)) {
                filas = filas.filter((p) => p.disponible);
            }
            return { rows: filas, rowCount: filas.length };
        }

        if (/SELECT \* FROM productos WHERE id = \$1/i.test(sql)) {
            const fila = productos.find((p) => p.id === Number(values[0]));
            return fila ? { rows: [fila], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        if (/SELECT id FROM productos WHERE id = \$1/i.test(sql)) {
            const fila = productos.find((p) => p.id === Number(values[0]));
            return fila ? { rows: [{ id: fila.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        if (/INSERT INTO productos/i.test(sql)) {
            const fila = {
                id: siguienteProducto++,
                uuid_operation: values[0],
                nombre: values[1],
                categoria: values[2],
                precio: String(values[3]),
                descripcion: values[4],
                imagen_emoji: values[5],
                imagen_url: values[6],
                disponible: values[7],
                en_promocion: values[8]
            };
            productos.push(fila);
            return { rows: [fila], rowCount: 1 };
        }

        if (/UPDATE productos SET/i.test(sql)) {
            const fila = productos.find((p) => p.id === Number(values[0]));
            if (!fila) return { rows: [], rowCount: 0 };
            Object.assign(fila, {
                nombre: values[1],
                categoria: values[2],
                precio: String(values[3]),
                descripcion: values[4],
                imagen_emoji: values[5],
                imagen_url: values[6],
                disponible: values[7],
                en_promocion: values[8]
            });
            return { rows: [fila], rowCount: 1 };
        }

        if (/DELETE FROM productos WHERE id = \$1 RETURNING id/i.test(sql)) {
            const indice = productos.findIndex((p) => p.id === Number(values[0]));
            if (indice < 0) return { rows: [], rowCount: 0 };
            const [fila] = productos.splice(indice, 1);
            return { rows: [{ id: fila.id }], rowCount: 1 };
        }

        if (/SELECT \* FROM promociones ORDER BY id ASC/i.test(sql)) {
            return { rows: [...promociones], rowCount: promociones.length };
        }

        if (/SELECT \* FROM promociones WHERE id = \$1/i.test(sql)) {
            const fila = promociones.find((p) => p.id === Number(values[0]));
            return fila ? { rows: [fila], rowCount: 1 } : { rows: [], rowCount: 0 };
        }

        if (/INSERT INTO promociones/i.test(sql)) {
            const fila = {
                id: siguientePromocion++,
                uuid_operation: values[0],
                producto_id: Number(values[1]),
                descuento_porcentaje: String(values[2]),
                activa: values[3]
            };
            promociones.push(fila);
            return { rows: [fila], rowCount: 1 };
        }

        if (/UPDATE promociones SET/i.test(sql)) {
            const fila = promociones.find((p) => p.id === Number(values[0]));
            if (!fila) return { rows: [], rowCount: 0 };
            Object.assign(fila, {
                producto_id: Number(values[1]),
                descuento_porcentaje: String(values[2]),
                activa: values[3]
            });
            return { rows: [fila], rowCount: 1 };
        }

        if (/DELETE FROM promociones WHERE id = \$1 RETURNING id/i.test(sql)) {
            const indice = promociones.findIndex((p) => p.id === Number(values[0]));
            if (indice < 0) return { rows: [], rowCount: 0 };
            const [fila] = promociones.splice(indice, 1);
            return { rows: [{ id: fila.id }], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
    }

    return { query, productos, promociones };
}

test('POST /api/productos exige rol dueño', async () => {
    const pool = crearPoolCrud();
    const app = crearApp(pool);
    const tokenCliente = firmarToken({
        id: 2,
        nombre: 'Cliente',
        correo: 'cliente@crocanti.com',
        rol: 'cliente'
    });
    const tokenDueno = firmarToken({
        id: 1,
        nombre: 'Admin',
        correo: 'admin@crocanti.com',
        rol: 'dueno'
    });
    const cuerpo = JSON.stringify({
        nombre: 'Producto Seguro',
        categoria: 'Pollo',
        precio: 8.5
    });

    await conServidor(app, async (url) => {
        const sinToken = await fetch(`${url}/api/productos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: cuerpo
        });
        assert.equal(sinToken.status, 401);

        const cliente = await fetch(`${url}/api/productos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tokenCliente}`
            },
            body: cuerpo
        });
        assert.equal(cliente.status, 403);

        const dueno = await fetch(`${url}/api/productos`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${tokenDueno}`
            },
            body: cuerpo
        });
        assert.equal(dueno.status, 201);
    });
});

test('GET /api/productos público no devuelve productos ocultos', async () => {
    const app = crearApp(crearPoolCrud(), { auth: false });
    await conServidor(app, async (url) => {
        const respuesta = await fetch(`${url}/api/productos`);
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.deepEqual(cuerpo.map((p) => p.id), [1]);
    });
});

test('GET /api/productos con admin autenticado incluye productos ocultos', async () => {
    const pool = crearPoolCrud();
    const app = crearApp(pool);
    const token = firmarToken({
        id: 1,
        nombre: 'Admin',
        correo: 'admin@crocanti.com',
        rol: 'dueno'
    });

    await conServidor(app, async (url) => {
        const respuesta = await fetch(
            `${url}/api/productos?incluirNoDisponibles=true`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        assert.equal(respuesta.status, 200);
        const cuerpo = await respuesta.json();
        assert.deepEqual(cuerpo.map((p) => p.id), [1, 2]);
    });
});

test('GET /api/productos/:id respeta la visibilidad por rol', async () => {
    const pool = crearPoolCrud();
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const publico = await fetch(`${url}/api/productos/2`);
        assert.equal(publico.status, 404);

        const inexistente = await fetch(`${url}/api/productos/999`);
        assert.equal(inexistente.status, 404);
    });
});

test('POST /api/productos crea un producto y valida el precio', async () => {
    const pool = crearPoolCrud();
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const creado = await fetch(`${url}/api/productos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Combo Nuevo',
                categoria: 'Combos',
                precio: 19.9,
                descripcion: 'Combo de prueba',
                imagenEmoji: '🍱',
                disponible: true,
                enPromocion: false
            })
        });
        assert.equal(creado.status, 201);
        const cuerpo = await creado.json();
        assert.equal(cuerpo.nombre, 'Combo Nuevo');
        assert.equal(cuerpo.precio, 19.9);

        const invalido = await fetch(`${url}/api/productos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nombre: 'Precio Cero',
                categoria: 'Pollo',
                precio: 0
            })
        });
        assert.equal(invalido.status, 400);
    });
});

test('PUT y DELETE de productos actualizan y eliminan', async () => {
    const pool = crearPoolCrud();
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const actualizado = await fetch(`${url}/api/productos/1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ precio: 15.75, disponible: false })
        });
        assert.equal(actualizado.status, 200);
        const cuerpo = await actualizado.json();
        assert.equal(cuerpo.precio, 15.75);
        assert.equal(cuerpo.disponible, false);

        const eliminado = await fetch(`${url}/api/productos/2`, { method: 'DELETE' });
        assert.equal(eliminado.status, 204);

        const faltante = await fetch(`${url}/api/productos/2`, { method: 'DELETE' });
        assert.equal(faltante.status, 404);
    });
});

test('CRUD de promociones valida producto y descuento', async () => {
    const pool = crearPoolCrud();
    const app = crearApp(pool, { auth: false });

    await conServidor(app, async (url) => {
        const creada = await fetch(`${url}/api/promociones`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productoId: 1,
                descuentoPorcentaje: 20,
                activa: true
            })
        });
        assert.equal(creada.status, 201);
        const cuerpo = await creada.json();
        assert.equal(cuerpo.descuentoPorcentaje, 20);

        const sinProducto = await fetch(`${url}/api/promociones`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productoId: 999,
                descuentoPorcentaje: 20
            })
        });
        assert.equal(sinProducto.status, 404);

        const invalida = await fetch(`${url}/api/promociones`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                productoId: 1,
                descuentoPorcentaje: 0
            })
        });
        assert.equal(invalida.status, 400);

        const actualizada = await fetch(`${url}/api/promociones/1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ descuentoPorcentaje: 15 })
        });
        assert.equal(actualizada.status, 200);

        const eliminada = await fetch(`${url}/api/promociones/1`, { method: 'DELETE' });
        assert.equal(eliminada.status, 204);
    });
});
