'use strict';

// ============================================================
// MOTOR DE SINCRONIZACIÓN (POST /api/sync)
// Contrato: ver SyncRequestDto / SyncResponseDto de la app ADMIN.
// Idempotencia: tabla sync_operaciones (uuid_operation es la clave).
// ============================================================

const ENTIDADES_VALIDAS = new Set(['PRODUCTO', 'PROMOCION']);
const TIPOS_VALIDOS = new Set(['INSERT', 'UPDATE', 'DELETE']);

function parsearDatos(datosJson) {
    if (datosJson && typeof datosJson === 'object' && !Array.isArray(datosJson)) {
        return datosJson;
    }
    if (typeof datosJson !== 'string' || datosJson.trim() === '') {
        throw new Error('El campo datosJson es obligatorio');
    }
    let datos;
    try {
        datos = JSON.parse(datosJson);
    } catch (e) {
        throw new Error('datosJson no contiene un JSON válido');
    }
    if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
        throw new Error('datosJson debe ser un objeto JSON');
    }
    return datos;
}

function aEnteroPositivo(valor) {
    const numero = Number(valor);
    return Number.isInteger(numero) && numero > 0 ? numero : null;
}

function normalizarOperacion(op) {
    if (!op || typeof op !== 'object') {
        throw new Error('Operación inválida');
    }

    const uuidOperation = String(op.uuidOperation || '').trim();
    if (uuidOperation === '') {
        throw new Error('uuidOperation es obligatorio');
    }

    const entidad = String(op.entidad || '').toUpperCase();
    if (!ENTIDADES_VALIDAS.has(entidad)) {
        throw new Error(`Entidad no soportada: ${op.entidad}`);
    }

    const tipoOperacion = String(op.tipoOperacion || '').toUpperCase();
    if (!TIPOS_VALIDOS.has(tipoOperacion)) {
        throw new Error(`Tipo de operación no soportado: ${op.tipoOperacion}`);
    }

    const datos = parsearDatos(op.datosJson);
    const idRemoto = aEnteroPositivo(op.idRemoto) || aEnteroPositivo(datos.id);
    const idLocal = Number.isInteger(Number(op.idLocal)) && Number(op.idLocal) > 0
        ? Number(op.idLocal)
        : null;

    return { uuidOperation, entidad, tipoOperacion, datos, idRemoto, idLocal };
}

function normalizarProducto(datos) {
    const nombre = String(datos.nombre ?? '').trim();
    const categoria = String(datos.categoria ?? '').trim();
    const precio = Number(datos.precio);

    if (nombre === '') throw new Error('El nombre del producto es obligatorio');
    if (categoria === '') throw new Error('La categoría del producto es obligatoria');
    if (!Number.isFinite(precio) || precio <= 0) {
        throw new Error('El precio del producto debe ser mayor a 0');
    }

    return {
        nombre,
        categoria,
        precio,
        descripcion: String(datos.descripcion ?? ''),
        imagenEmoji: String(datos.imagenEmoji ?? ''),
        imagenUrl: datos.imagenUrl ? String(datos.imagenUrl) : null,
        disponible: datos.disponible !== false,
        enPromocion: datos.enPromocion === true
    };
}

function normalizarPromocion(datos) {
    const productoId = aEnteroPositivo(datos.productoIdRemoto) || aEnteroPositivo(datos.productoId);
    const descuento = Number(datos.descuentoPorcentaje);

    if (productoId === null) throw new Error('La promoción no tiene un producto remoto válido');
    if (!Number.isFinite(descuento) || descuento <= 0 || descuento > 100) {
        throw new Error('El descuento debe estar entre 1 y 100');
    }

    return {
        productoId,
        descuentoPorcentaje: descuento,
        activa: datos.activa !== false
    };
}

function sentenciaInsertarProducto(op, p) {
    return {
        text: `
            INSERT INTO productos
                (uuid_operation, nombre, categoria, precio, descripcion,
                 imagen_emoji, imagen_url, disponible, en_promocion)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (uuid_operation) DO UPDATE SET
                nombre = EXCLUDED.nombre,
                categoria = EXCLUDED.categoria,
                precio = EXCLUDED.precio,
                descripcion = EXCLUDED.descripcion,
                imagen_emoji = EXCLUDED.imagen_emoji,
                imagen_url = EXCLUDED.imagen_url,
                disponible = EXCLUDED.disponible,
                en_promocion = EXCLUDED.en_promocion
            RETURNING id
        `,
        values: [
            op.uuidOperation, p.nombre, p.categoria, p.precio, p.descripcion,
            p.imagenEmoji, p.imagenUrl, p.disponible, p.enPromocion
        ]
    };
}

function sentenciaActualizarProducto(id, p) {
    return {
        text: `
            UPDATE productos SET
                nombre = $2, categoria = $3, precio = $4, descripcion = $5,
                imagen_emoji = $6, imagen_url = $7, disponible = $8, en_promocion = $9
            WHERE id = $1
            RETURNING id
        `,
        values: [
            id, p.nombre, p.categoria, p.precio, p.descripcion,
            p.imagenEmoji, p.imagenUrl, p.disponible, p.enPromocion
        ]
    };
}

// Busca un producto por nombre para que la subida completa del catálogo
// desde ADMIN no duplique filas que ya existen en Neon.
async function buscarProductoPorNombre(client, nombre) {
    const resultado = await client.query(
        `SELECT id FROM productos
         WHERE lower(trim(nombre)) = lower(trim($1))
         ORDER BY id ASC
         LIMIT 1`,
        [nombre]
    );
    return resultado.rowCount > 0 ? resultado.rows[0].id : null;
}

function sentenciaInsertarPromocion(op, p) {
    return {
        text: `
            INSERT INTO promociones
                (uuid_operation, producto_id, descuento_porcentaje, activa)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (uuid_operation) DO UPDATE SET
                producto_id = EXCLUDED.producto_id,
                descuento_porcentaje = EXCLUDED.descuento_porcentaje,
                activa = EXCLUDED.activa
            RETURNING id
        `,
        values: [op.uuidOperation, p.productoId, p.descuentoPorcentaje, p.activa]
    };
}

function construirSentencia(op) {
    if (op.entidad === 'PRODUCTO') {
        const p = normalizarProducto(op.datos);

        if (op.tipoOperacion === 'DELETE') {
            if (op.idRemoto === null) {
                return { text: 'SELECT NULL::integer AS id', values: [] };
            }
            return { text: 'DELETE FROM productos WHERE id = $1 RETURNING id', values: [op.idRemoto] };
        }

        if (op.tipoOperacion === 'UPDATE' && op.idRemoto !== null) {
            return {
                text: `
                    UPDATE productos SET
                        nombre = $2, categoria = $3, precio = $4, descripcion = $5,
                        imagen_emoji = $6, imagen_url = $7, disponible = $8, en_promocion = $9
                    WHERE id = $1
                    RETURNING id
                `,
                values: [
                    op.idRemoto, p.nombre, p.categoria, p.precio, p.descripcion,
                    p.imagenEmoji, p.imagenUrl, p.disponible, p.enPromocion
                ]
            };
        }

        return sentenciaInsertarProducto(op, p);
    }

    const p = normalizarPromocion(op.datos);

    if (op.tipoOperacion === 'DELETE') {
        if (op.idRemoto === null) {
            return { text: 'SELECT NULL::integer AS id', values: [] };
        }
        return { text: 'DELETE FROM promociones WHERE id = $1 RETURNING id', values: [op.idRemoto] };
    }

    if (op.tipoOperacion === 'UPDATE' && op.idRemoto !== null) {
        return {
            text: `
                UPDATE promociones SET
                    producto_id = $2, descuento_porcentaje = $3, activa = $4
                WHERE id = $1
                RETURNING id
            `,
            values: [op.idRemoto, p.productoId, p.descuentoPorcentaje, p.activa]
        };
    }

    return sentenciaInsertarPromocion(op, p);
}

async function aplicarOperacion(client, op) {
    // Productos: se resuelve primero el id remoto y luego el nombre para
    // evitar duplicados cuando el catálogo completo se sube desde ADMIN.
    if (op.entidad === 'PRODUCTO' && op.tipoOperacion !== 'DELETE') {
        const p = normalizarProducto(op.datos);

        if (op.tipoOperacion === 'UPDATE' && op.idRemoto !== null) {
            const sentencia = sentenciaActualizarProducto(op.idRemoto, p);
            const resultado = await client.query(sentencia.text, sentencia.values);
            if (resultado.rowCount > 0) {
                return resultado.rows[0] ? resultado.rows[0].id : op.idRemoto;
            }
        }

        const existente = await buscarProductoPorNombre(client, p.nombre);
        if (existente !== null) {
            const sentencia = sentenciaActualizarProducto(existente, p);
            await client.query(sentencia.text, sentencia.values);
            return existente;
        }

        const insercion = sentenciaInsertarProducto(op, p);
        const resultadoInsercion = await client.query(insercion.text, insercion.values);
        return resultadoInsercion.rows[0] ? resultadoInsercion.rows[0].id : null;
    }

    const sentencia = construirSentencia(op);
    const resultado = await client.query(sentencia.text, sentencia.values);

    if (resultado.rowCount > 0) {
        return resultado.rows[0] ? resultado.rows[0].id : null;
    }

    // UPDATE sobre una fila que aún no existe en Neon: se crea.
    if (op.tipoOperacion === 'UPDATE') {
        const insercion = sentenciaInsertarPromocion(op, normalizarPromocion(op.datos));
        const resultadoInsercion = await client.query(insercion.text, insercion.values);
        return resultadoInsercion.rows[0] ? resultadoInsercion.rows[0].id : null;
    }

    return null;
}

// Los productos se aplican antes que las promociones (dependencia por FK).
// Para los borrados el orden se invierte: primero promociones y luego
// productos, porque la promoción referencia al producto.
function ordenarOperaciones(operaciones) {
    const prioridad = { PRODUCTO: 0, PROMOCION: 1 };
    return operaciones
        .map((op, indice) => ({ op, indice }))
        .sort((a, b) => {
            const entidadA = String(a.op?.entidad || '').toUpperCase();
            const entidadB = String(b.op?.entidad || '').toUpperCase();
            const tipoA = String(a.op?.tipoOperacion || '').toUpperCase();
            const tipoB = String(b.op?.tipoOperacion || '').toUpperCase();
            const borradoA = tipoA === 'DELETE';
            const borradoB = tipoB === 'DELETE';

            if (borradoA && borradoB) {
                const diferencia = (prioridad[entidadB] ?? 9) - (prioridad[entidadA] ?? 9);
                return diferencia !== 0 ? diferencia : a.indice - b.indice;
            }
            if (borradoA !== borradoB) {
                return borradoA ? -1 : 1;
            }

            const diferencia = (prioridad[entidadA] ?? 9) - (prioridad[entidadB] ?? 9);
            return diferencia !== 0 ? diferencia : a.indice - b.indice;
        })
        .map((item) => item.op);
}

// Traduce el id local de un producto al id real de Neon usando la bitácora
// de operaciones ya aplicadas. Necesario cuando la promoción se creó antes
// de que su producto existiera en el servidor.
async function resolverProductoRemoto(client, op) {
    if (op.entidad !== 'PROMOCION') return null;
    if (aEnteroPositivo(op.datos.productoIdRemoto) !== null) return null;

    const idLocalProducto = aEnteroPositivo(op.datos.productoId);
    if (idLocalProducto === null) return null;

    const resultado = await client.query(
        `SELECT id_remoto
         FROM sync_operaciones
         WHERE entidad = 'PRODUCTO' AND id_local = $1 AND id_remoto IS NOT NULL
         ORDER BY procesado_en DESC
         LIMIT 1`,
        [idLocalProducto]
    );

    return resultado.rowCount > 0 ? resultado.rows[0].id_remoto : null;
}

function crearServicioSync(pool) {
    return {
        async procesar(operaciones) {
            const resultados = [];

            for (const operacion of ordenarOperaciones(operaciones)) {
                let op;
                try {
                    op = normalizarOperacion(operacion);
                } catch (e) {
                    resultados.push({
                        uuidOperation: String(operacion?.uuidOperation || ''),
                        idRemoto: null,
                        exito: false,
                        mensajeError: e.message
                    });
                    continue;
                }

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');

                    const previa = await client.query(
                        'SELECT id_remoto FROM sync_operaciones WHERE uuid_operation = $1',
                        [op.uuidOperation]
                    );

                    if (previa.rowCount > 0) {
                        await client.query('COMMIT');
                        resultados.push({
                            uuidOperation: op.uuidOperation,
                            idRemoto: previa.rows[0].id_remoto,
                            exito: true,
                            mensajeError: null
                        });
                        continue;
                    }

                    const productoRemoto = await resolverProductoRemoto(client, op);
                    if (productoRemoto !== null) {
                        op.datos = { ...op.datos, productoIdRemoto: productoRemoto };
                    }

                    const idRemoto = await aplicarOperacion(client, op);

                    await client.query(
                        `INSERT INTO sync_operaciones
                            (uuid_operation, entidad, tipo_operacion, id_remoto, id_local)
                         VALUES ($1, $2, $3, $4, $5)
                         ON CONFLICT (uuid_operation) DO NOTHING`,
                        [op.uuidOperation, op.entidad, op.tipoOperacion, idRemoto, op.idLocal]
                    );

                    await client.query('COMMIT');
                    resultados.push({
                        uuidOperation: op.uuidOperation,
                        idRemoto,
                        exito: true,
                        mensajeError: null
                    });
                } catch (e) {
                    await client.query('ROLLBACK').catch(() => {});
                    resultados.push({
                        uuidOperation: op.uuidOperation,
                        idRemoto: null,
                        exito: false,
                        mensajeError: e.message
                    });
                } finally {
                    client.release();
                }
            }

            return resultados;
        }
    };
}

module.exports = {
    crearServicioSync,
    normalizarOperacion,
    normalizarProducto,
    normalizarPromocion,
    construirSentencia,
    ordenarOperaciones
};
