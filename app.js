'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { crearServicioSync, normalizarProducto, normalizarPromocion } = require('./sync');
const { predecirEta, obtenerMetricasEta } = require('./ml/eta_model');
const {
    estaConfigurado: almacenamientoConfigurado,
    subirFoto
} = require('./almacenamiento');
const {
    hashearClave,
    verificarClave,
    esHashBcrypt,
    firmarToken,
    normalizarRol,
    grupoRol,
    autenticar,
    verificarToken,
    crearProteccion
} = require('./seguridad');

// ============================================================
// FÁBRICA DE LA API
// Se separa de index.js para poder probar los endpoints sin
// levantar el servidor ni conectarse a Neon.
// ============================================================

const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Transiciones permitidas del pedido. La app solo puede avanzar,
// nunca retroceder ni saltarse la cocina.
const TRANSICIONES = {
    PENDIENTE: ['RECIBIDO', 'EN_COCINA', 'CANCELADO'],
    RECIBIDO: ['EN_COCINA', 'CANCELADO'],
    EN_COCINA: ['LISTO', 'CANCELADO'],
    LISTO: ['EN_CAMINO', 'ENTREGADO', 'ENTREGADO_PAGADO', 'CANCELADO'],
    EN_CAMINO: ['ENTREGADO', 'ENTREGADO_PAGADO', 'NO_ENTREGADO'],
    ENTREGADO: ['ENTREGADO_PAGADO'],
    ENTREGADO_PAGADO: [],
    NO_ENTREGADO: ['EN_CAMINO', 'CANCELADO'],
    CANCELADO: []
};

const ESTADOS_ACTIVOS_COCINA = ['PENDIENTE', 'RECIBIDO', 'EN_COCINA', 'LISTO'];

// El cliente puede anular su pedido mientras cocina no lo haya marcado
// como listo. Después de LISTO la comida ya está preparada y solo el
// personal del local puede cancelar.
const ESTADOS_CANCELABLES_CLIENTE = ['PENDIENTE', 'RECIBIDO', 'EN_COCINA'];

function esRolAdministrativo(rol) {
    const r = normalizarRol(rol);
    return ['administrador', 'admin', 'dueno', 'dueño', 'cajero', 'cocina'].includes(r);
}

async function resolverUsuario(client, usuarioId, usuarioCorreo) {
    if (Number.isInteger(usuarioId) && usuarioId > 0) return usuarioId;
    if (!usuarioCorreo) return null;
    const resultado = await client.query(
        'SELECT id FROM usuarios WHERE lower(correo) = lower($1) LIMIT 1',
        [usuarioCorreo]
    );
    return resultado.rowCount > 0 ? resultado.rows[0].id : null;
}

async function resolverTienda(client, tiendaId, tiendaNombre) {
    if (Number.isInteger(tiendaId) && tiendaId > 0) return tiendaId;
    if (!tiendaNombre) return null;
    try {
        const resultado = await client.query(
            'SELECT id FROM tiendas WHERE lower(nombre) = lower($1) LIMIT 1',
            [tiendaNombre]
        );
        return resultado.rowCount > 0 ? resultado.rows[0].id : null;
    } catch (e) {
        // La tabla tiendas aún no existe: se conserva el texto libre.
        return null;
    }
}

async function obtenerUsuarioPorCorreo(client, correo) {
    if (!correo) return null;
    const resultado = await client.query(
        'SELECT * FROM usuarios WHERE lower(correo) = lower($1) LIMIT 1',
        [correo]
    );
    return resultado.rowCount > 0 ? resultado.rows[0] : null;
}

function mapearProducto(p) {
    return {
        id: p.id,
        nombre: p.nombre,
        categoria: p.categoria,
        precio: parseFloat(p.precio),
        descripcion: p.descripcion || '',
        imagenEmoji: p.imagen_emoji || '',
        imagenUrl: p.imagen_url || null,
        disponible: p.disponible,
        enPromocion: p.en_promocion
    };
}

function mapearPromocion(p) {
    return {
        id: p.id,
        productoId: p.producto_id,
        descuentoPorcentaje: parseFloat(p.descuento_porcentaje),
        activa: p.activa
    };
}

function mapearDetalle(linea) {
    return {
        id: linea.id,
        productoId: linea.producto_id,
        nombreProducto: linea.nombre_producto,
        cantidad: linea.cantidad,
        precioUnitario: parseFloat(linea.precio_unitario),
        subtotal: parseFloat(linea.subtotal)
    };
}

function mapearPedido(p, detalles = []) {
    return {
        id: p.id,
        numeroOrden: p.numero_orden,
        total: parseFloat(p.total),
        tienda: p.tienda,
        tiendaId: p.tienda_id,
        tiendaNombre: p.tienda_nombre,
        tiendaLatitud: p.tienda_latitud === null || p.tienda_latitud === undefined
            ? null
            : parseFloat(p.tienda_latitud),
        tiendaLongitud: p.tienda_longitud === null || p.tienda_longitud === undefined
            ? null
            : parseFloat(p.tienda_longitud),
        usuarioId: p.usuario_id,
        clienteNombre: p.cliente_nombre,
        clienteCorreo: p.cliente_correo,
        tipoPago: p.tipo_pago,
        codigoOperacion: p.codigo_operacion,
        direccionEntrega: p.direccion_entrega || '',
        telefonoEntrega: p.telefono_entrega || '',
        tipoEntrega: p.tipo_entrega || 'RECOJO',
        costoDelivery: parseFloat(p.costo_delivery || 0),
        latitudEntrega: p.latitud_entrega === null || p.latitud_entrega === undefined
            ? null
            : parseFloat(p.latitud_entrega),
        longitudEntrega: p.longitud_entrega === null || p.longitud_entrega === undefined
            ? null
            : parseFloat(p.longitud_entrega),
        estado: p.estado,
        fecha: p.fecha,
        uuidOperation: p.uuid_operation,
        repartidorId: p.repartidor_id || null,
        repartidorNombre: p.repartidor_nombre || null,
        repartidorCorreo: p.repartidor_correo || null,
        pagoEstado: p.pago_estado || null,
        pagoReferencia: p.pago_referencia || null,
        detalles
    };
}

async function cargarDetalles(pool, ids) {
    const detallesPorPedido = new Map();
    if (!ids.length) return detallesPorPedido;

    const detalle = await pool.query(
        'SELECT * FROM detalle_pedido WHERE pedido_id = ANY($1::int[]) ORDER BY id ASC',
        [ids]
    );
    for (const linea of detalle.rows) {
        const lista = detallesPorPedido.get(linea.pedido_id) || [];
        lista.push(mapearDetalle(linea));
        detallesPorPedido.set(linea.pedido_id, lista);
    }
    return detallesPorPedido;
}

function crearApp(pool, opciones = {}) {
    const app = express();
    app.use(express.json({ limit: '8mb' }));

    // Cabeceras básicas de seguridad para todas las respuestas.
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Cache-Control', 'no-store');
        next();
    });

    // Las pruebas unitarias pueden desactivar la autenticación para
    // enfocarse en la lógica de cada endpoint.
    const authActiva = opciones.auth !== false;
    const proteger = crearProteccion(authActiva);

    // --------------------------------------------------------
    // Roles administrativos específicos
    // administrador/admin/dueño = dueño; cajero; cocina/cocinero.
    // --------------------------------------------------------
    const ROLES_DUENO = new Set(['administrador', 'admin', 'dueno', 'dueño']);
    const ROLES_CAJERO = new Set(['cajero']);
    const ROLES_COCINA = new Set(['cocina', 'cocinero']);

    function rolAdmin(usuario) {
        const rol = normalizarRol(usuario && usuario.rol);
        if (ROLES_DUENO.has(rol)) return 'dueno';
        if (ROLES_CAJERO.has(rol)) return 'cajero';
        if (ROLES_COCINA.has(rol)) return 'cocina';
        return null;
    }

    const protegerAdmin = (...roles) => {
        if (!authActiva) return [];
        return [
            autenticar,
            (req, res, next) => {
                const rol = rolAdmin(req.usuario);
                if (rol && roles.includes(rol)) return next();
                return res.status(403).json({
                    error: 'No tienes permisos para esta acción'
                });
            }
        ];
    };

    const bloquearRolAdmin = (...roles) => (req, res, next) => {
        if (!authActiva) return next();
        const rol = rolAdmin(req.usuario);
        if (rol && roles.includes(rol)) {
            return res.status(403).json({
                error: 'No tienes permisos para esta acción'
            });
        }
        return next();
    };

    // Permite que un endpoint público cambie de comportamiento cuando
    // recibe un JWT de administrador (por ejemplo, para ver productos ocultos).
    // Un token inválido no bloquea la consulta pública: se ignora.
    const autenticacionOpcional = (req, res, next) => {
        if (!authActiva) return next();
        const cabecera = req.headers.authorization || '';
        const partes = cabecera.split(' ');
        if (partes.length === 2 && /^Bearer$/i.test(partes[0])) {
            const datos = verificarToken(partes[1].trim());
            if (datos) {
                req.usuario = {
                    id: Number(datos.sub),
                    correo: datos.correo,
                    nombre: datos.nombre,
                    rol: normalizarRol(datos.rol)
                };
            }
        }
        return next();
    };

    const esAdminDeLaSesion = (req) => Boolean(req.usuario && rolAdmin(req.usuario));

    // Con autenticación activa, el correo del repartidor sale del token y
    // no del cuerpo/consulta, para que no pueda operar por otros.
    const correoDeSesion = (req, solicitado) =>
        (authActiva && req.usuario ? req.usuario.correo : solicitado);

    // Servir las fotos de entrega guardadas localmente.
    app.use('/uploads', express.static(UPLOADS_DIR));

    const syncService = opciones.syncService || crearServicioSync(pool);

    // --------------------------------------------------------
    // 0. SALUD DEL SERVICIO
    // --------------------------------------------------------
    app.get('/api/health', async (req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({
                ok: true,
                servicio: 'crocanti-api',
                almacenamiento: almacenamientoConfigurado() ? 's3' : 'local'
            });
        } catch (err) {
            res.status(503).json({ ok: false, error: 'Base de datos no disponible' });
        }
    });

    // --------------------------------------------------------
    // 1. PRODUCTOS
    // --------------------------------------------------------
    app.get('/api/productos', autenticacionOpcional, async (req, res) => {
        try {
            // El catálogo público solo muestra productos disponibles.
            // Un administrador autenticado puede pedir todos para gestionar
            // también los que están ocultos.
            const incluirNoDisponibles =
                String(req.query.incluirNoDisponibles || '').toLowerCase() === 'true';
            const verTodos = incluirNoDisponibles && esAdminDeLaSesion(req);
            const filtro = verTodos ? '' : 'WHERE disponible = true';

            // DISTINCT ON evita devolver duplicados históricos por nombre.
            const result = await pool.query(
                `SELECT DISTINCT ON (lower(trim(nombre))) *
                 FROM productos
                 ${filtro}
                 ORDER BY lower(trim(nombre)) ASC, id ASC`
            );
            res.json(result.rows.map(mapearProducto));
        } catch (err) {
            console.error('Error al obtener productos:', err);
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    app.get('/api/productos/:id', autenticacionOpcional, async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Id de producto inválido' });
        }
        try {
            const result = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Producto no encontrado' });
            }
            const producto = result.rows[0];
            if (!producto.disponible && !esAdminDeLaSesion(req)) {
                return res.status(404).json({ error: 'Producto no encontrado' });
            }
            res.json(mapearProducto(producto));
        } catch (err) {
            console.error('Error al obtener el producto:', err);
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    app.post('/api/productos', ...protegerAdmin('dueno'), async (req, res) => {
        try {
            const p = normalizarProducto(req.body || {});
            const uuid = crypto.randomUUID();
            const result = await pool.query(
                `INSERT INTO productos
                    (uuid_operation, nombre, categoria, precio, descripcion,
                     imagen_emoji, imagen_url, disponible, en_promocion)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                 RETURNING *`,
                [
                    uuid, p.nombre, p.categoria, p.precio, p.descripcion,
                    p.imagenEmoji, p.imagenUrl, p.disponible, p.enPromocion
                ]
            );
            res.status(201).json(mapearProducto(result.rows[0]));
        } catch (err) {
            if (err && err.code === '23505') {
                return res.status(409).json({ error: 'Ya existe un producto con ese nombre' });
            }
            res.status(400).json({ error: err.message || 'No se pudo crear el producto' });
        }
    });

    app.put('/api/productos/:id', ...protegerAdmin('dueno'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Id de producto inválido' });
        }
        try {
            const actual = await pool.query('SELECT * FROM productos WHERE id = $1', [id]);
            if (actual.rowCount === 0) {
                return res.status(404).json({ error: 'Producto no encontrado' });
            }
            const p = normalizarProducto({
                ...mapearProducto(actual.rows[0]),
                ...(req.body || {})
            });
            const result = await pool.query(
                `UPDATE productos SET
                    nombre = $2, categoria = $3, precio = $4, descripcion = $5,
                    imagen_emoji = $6, imagen_url = $7, disponible = $8, en_promocion = $9
                 WHERE id = $1
                 RETURNING *`,
                [
                    id, p.nombre, p.categoria, p.precio, p.descripcion,
                    p.imagenEmoji, p.imagenUrl, p.disponible, p.enPromocion
                ]
            );
            res.json(mapearProducto(result.rows[0]));
        } catch (err) {
            if (err && err.code === '23505') {
                return res.status(409).json({ error: 'Ya existe un producto con ese nombre' });
            }
            res.status(400).json({ error: err.message || 'No se pudo actualizar el producto' });
        }
    });

    app.delete('/api/productos/:id', ...protegerAdmin('dueno'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Id de producto inválido' });
        }
        try {
            const result = await pool.query(
                'DELETE FROM productos WHERE id = $1 RETURNING id',
                [id]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Producto no encontrado' });
            }
            res.status(204).end();
        } catch (err) {
            console.error('Error al eliminar el producto:', err);
            res.status(500).json({ error: 'No se pudo eliminar el producto' });
        }
    });

    // --------------------------------------------------------
    // 2. PROMOCIONES
    // --------------------------------------------------------
    app.get('/api/promociones', async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT * FROM promociones ORDER BY id ASC'
            );
            res.json(result.rows.map(mapearPromocion));
        } catch (err) {
            console.error('Error al obtener promociones:', err);
            res.status(500).json({ error: 'Error al listar las promociones' });
        }
    });

    app.get('/api/promociones/:id', async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Id de promoción inválido' });
        }
        try {
            const result = await pool.query('SELECT * FROM promociones WHERE id = $1', [id]);
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Promoción no encontrada' });
            }
            res.json(mapearPromocion(result.rows[0]));
        } catch (err) {
            console.error('Error al obtener la promoción:', err);
            res.status(500).json({ error: 'Error interno del servidor' });
        }
    });

    app.post('/api/promociones', ...protegerAdmin('dueno'), async (req, res) => {
        try {
            const p = normalizarPromocion(req.body || {});
            const existe = await pool.query('SELECT id FROM productos WHERE id = $1', [p.productoId]);
            if (existe.rowCount === 0) {
                return res.status(404).json({ error: 'El producto de la promoción no existe' });
            }
            const uuid = crypto.randomUUID();
            const result = await pool.query(
                `INSERT INTO promociones
                    (uuid_operation, producto_id, descuento_porcentaje, activa)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [uuid, p.productoId, p.descuentoPorcentaje, p.activa]
            );
            res.status(201).json(mapearPromocion(result.rows[0]));
        } catch (err) {
            res.status(400).json({ error: err.message || 'No se pudo crear la promoción' });
        }
    });

    app.put('/api/promociones/:id', ...protegerAdmin('dueno'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Id de promoción inválido' });
        }
        try {
            const actual = await pool.query('SELECT * FROM promociones WHERE id = $1', [id]);
            if (actual.rowCount === 0) {
                return res.status(404).json({ error: 'Promoción no encontrada' });
            }
            const p = normalizarPromocion({
                ...mapearPromocion(actual.rows[0]),
                ...(req.body || {})
            });
            const existe = await pool.query('SELECT id FROM productos WHERE id = $1', [p.productoId]);
            if (existe.rowCount === 0) {
                return res.status(404).json({ error: 'El producto de la promoción no existe' });
            }
            const result = await pool.query(
                `UPDATE promociones SET
                    producto_id = $2, descuento_porcentaje = $3, activa = $4
                 WHERE id = $1
                 RETURNING *`,
                [id, p.productoId, p.descuentoPorcentaje, p.activa]
            );
            res.json(mapearPromocion(result.rows[0]));
        } catch (err) {
            res.status(400).json({ error: err.message || 'No se pudo actualizar la promoción' });
        }
    });

    app.delete('/api/promociones/:id', ...protegerAdmin('dueno'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'Id de promoción inválido' });
        }
        try {
            const result = await pool.query(
                'DELETE FROM promociones WHERE id = $1 RETURNING id',
                [id]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Promoción no encontrada' });
            }
            res.status(204).end();
        } catch (err) {
            console.error('Error al eliminar la promoción:', err);
            res.status(500).json({ error: 'No se pudo eliminar la promoción' });
        }
    });

    // --------------------------------------------------------
    // 3. TIENDAS
    // --------------------------------------------------------
    app.get('/api/tiendas', async (req, res) => {
        try {
            const result = await pool.query(
                'SELECT id, nombre, direccion, telefono, activa FROM tiendas WHERE activa = true ORDER BY id ASC'
            );
            res.json(result.rows.map((t) => ({
                id: t.id,
                nombre: t.nombre,
                direccion: t.direccion,
                telefono: t.telefono,
                activa: t.activa
            })));
        } catch (err) {
            console.error('Error al obtener tiendas:', err);
            res.status(500).json({ error: 'Error al listar las tiendas' });
        }
    });

    // --------------------------------------------------------
    // 4. SINCRONIZACIÓN POR LOTES (app ADMIN)
    // --------------------------------------------------------
    app.post('/api/sync', ...protegerAdmin('dueno'), async (req, res) => {
        const operaciones = req.body ? req.body.operaciones : null;

        if (!Array.isArray(operaciones) || operaciones.length === 0) {
            return res.status(400).json({ error: 'El campo operaciones es obligatorio' });
        }
        if (operaciones.length > 200) {
            return res.status(413).json({ error: 'Máximo 200 operaciones por lote' });
        }

        try {
            const resultados = await syncService.procesar(operaciones);
            res.json({ resultados });
        } catch (err) {
            console.error('Error al sincronizar:', err);
            res.status(500).json({ error: 'Error interno al sincronizar' });
        }
    });

    // --------------------------------------------------------
    // 5. AUTENTICACIÓN (bcrypt + JWT)
    // --------------------------------------------------------
    const CODIGO_ADMIN = process.env.ADMIN_INVITE_CODE || 'CROCANTI-ADMIN';
    const CODIGO_REPARTIDOR = process.env.REPARTIDOR_INVITE_CODE || 'CROCANTI-REPARTIDOR';

    app.post('/api/auth/login', async (req, res) => {
        const { correo, clave } = req.body || {};
        const correoLimpio = String(correo || '').trim();

        if (!correoLimpio || !clave) {
            return res.status(400).json({ error: 'Correo y contraseña son obligatorios' });
        }

        try {
            const result = await pool.query(
                'SELECT * FROM usuarios WHERE lower(correo) = lower($1) LIMIT 1',
                [correoLimpio]
            );

            const user = result.rowCount > 0 ? result.rows[0] : null;
            const valido = user ? await verificarClave(clave, user.clave) : false;

            if (!user || !valido) {
                return res.status(401).json({ error: 'Credenciales incorrectas' });
            }

            // Migración transparente: si la clave aún estaba en texto plano,
            // se reemplaza por un hash bcrypt en este primer inicio de sesión.
            if (!esHashBcrypt(user.clave)) {
                try {
                    const hash = await hashearClave(clave);
                    await pool.query('UPDATE usuarios SET clave = $1 WHERE id = $2', [hash, user.id]);
                } catch (e) {
                    console.warn('No se pudo actualizar la clave a bcrypt:', e.message);
                }
            }

            res.json({
                id: user.id,
                token: firmarToken(user),
                nombre: user.nombre,
                correo: user.correo,
                telefono: user.telefono || '',
                rol: user.rol
            });
        } catch (err) {
            console.error('Error en login:', err);
            res.status(500).json({ error: 'Error en el servidor' });
        }
    });

    app.post('/api/auth/register', async (req, res) => {
        const { nombre, correo, clave, rol, telefono, codigoInvitacion } = req.body || {};

        if (!nombre || !correo || !clave) {
            return res.status(400).json({ error: 'Nombre, correo y clave son obligatorios' });
        }

        const correoLimpio = String(correo).trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correoLimpio)) {
            return res.status(400).json({ error: 'El correo no tiene un formato válido' });
        }
        if (String(clave).length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
        }

        // El rol nunca se toma a ciegas del cuerpo: para crear cuentas
        // administrativas o de repartidor se exige un código de invitación.
        const rolSolicitado = normalizarRol(rol);
        let rolFinal = 'cliente';

        if (rolSolicitado && rolSolicitado !== 'cliente') {
            const codigo = String(codigoInvitacion || '').trim();
            if (esRolAdministrativo(rolSolicitado)) {
                if (codigo !== CODIGO_ADMIN) {
                    return res.status(403).json({
                        error: 'Código de invitación de administrador inválido'
                    });
                }
                rolFinal = 'administrador';
            } else if (['repartidor', 'delivery'].includes(rolSolicitado)) {
                if (codigo !== CODIGO_REPARTIDOR) {
                    return res.status(403).json({
                        error: 'Código de invitación de repartidor inválido'
                    });
                }
                rolFinal = 'repartidor';
            } else {
                return res.status(400).json({ error: 'Rol no válido' });
            }
        }

        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN');

            const hash = await hashearClave(clave);
            const result = await client.query(
                `INSERT INTO usuarios (nombre, correo, clave, rol, telefono)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (correo) DO NOTHING
                 RETURNING *`,
                [String(nombre).trim(), correoLimpio, hash, rolFinal, telefono || null]
            );

            if (!result.rowCount) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'El correo ya está registrado' });
            }

            const user = result.rows[0];

            // Un repartidor necesita su fila operativa desde el primer momento
            // (turno, disponibilidad y ubicación). Se crea en la misma
            // transacción para no dejar usuarios con rol sin perfil.
            if (normalizarRol(user.rol) === 'repartidor') {
                await client.query(
                    `INSERT INTO repartidores (usuario_id, turno_activo, disponible)
                     VALUES ($1, FALSE, TRUE)
                     ON CONFLICT (usuario_id) DO NOTHING`,
                    [user.id]
                );
            }

            await client.query('COMMIT');

            res.status(201).json({
                id: user.id,
                token: firmarToken(user),
                nombre: user.nombre,
                correo: user.correo,
                telefono: user.telefono || '',
                rol: user.rol
            });
        } catch (err) {
            if (client) {
                await client.query('ROLLBACK').catch(() => {});
            }
            console.error('Error en registro:', err);
            res.status(500).json({ error: 'No se pudo registrar el usuario' });
        } finally {
            if (client) client.release();
        }
    });

    // --------------------------------------------------------
    // 6. PEDIDOS (app CLIENTE)
    // --------------------------------------------------------
    app.post('/api/pedidos', ...proteger('cliente', 'admin'), async (req, res) => {
        const {
            numeroOrden, total, tienda, tiendaId, tipoPago, codigoOperacion,
            direccionEntrega, estado, fecha, uuidOperation,
            usuarioId, usuarioCorreo, detalles,
            tipoEntrega, costoDelivery, telefonoEntrega,
            latitudEntrega, longitudEntrega
        } = req.body || {};

        if (!numeroOrden) {
            return res.status(400).json({ error: 'El número de orden es obligatorio' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const usuarioFinal = await resolverUsuario(client, usuarioId, usuarioCorreo);
            const tiendaFinal = await resolverTienda(client, tiendaId, tienda);

            const fechaPedido = typeof fecha === 'string' && fecha.trim() !== ''
                ? fecha.trim()
                : new Date().toISOString();

            const query = `
                INSERT INTO pedidos
                    (numero_orden, total, tienda, tienda_id, usuario_id, tipo_pago,
                     codigo_operacion, direccion_entrega, estado, fecha, uuid_operation,
                     tipo_entrega, costo_delivery, telefono_entrega,
                     latitud_entrega, longitud_entrega)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                ON CONFLICT (uuid_operation) DO UPDATE
                SET estado = EXCLUDED.estado,
                    direccion_entrega = EXCLUDED.direccion_entrega,
                    telefono_entrega = EXCLUDED.telefono_entrega,
                    tipo_entrega = EXCLUDED.tipo_entrega,
                    costo_delivery = EXCLUDED.costo_delivery,
                    latitud_entrega = EXCLUDED.latitud_entrega,
                    longitud_entrega = EXCLUDED.longitud_entrega
                RETURNING *;
            `;

            const values = [
                numeroOrden,
                total,
                tienda || '',
                tiendaFinal,
                usuarioFinal,
                tipoPago || 'Efectivo',
                codigoOperacion || '',
                direccionEntrega || '',
                estado || 'PENDIENTE',
                fechaPedido,
                uuidOperation || null,
                (tipoEntrega || 'RECOJO').toUpperCase(),
                Number(costoDelivery) || 0,
                telefonoEntrega || '',
                Number.isFinite(Number(latitudEntrega)) ? Number(latitudEntrega) : null,
                Number.isFinite(Number(longitudEntrega)) ? Number(longitudEntrega) : null
            ];

            const result = await client.query(query, values);
            const pedidoGuardado = result.rows[0];

            const lineas = Array.isArray(detalles) ? detalles : [];

            // Se reemplaza el detalle completo para que el POST sea idempotente
            // y no duplique líneas si Android reintenta la operación.
            await client.query('DELETE FROM detalle_pedido WHERE pedido_id = $1', [pedidoGuardado.id]);

            for (const linea of lineas) {
                const cantidad = Number(linea.cantidad);
                const precioUnitario = Number(linea.precioUnitario);
                const productoId = Number(linea.productoId);

                if (!Number.isInteger(cantidad) || cantidad <= 0) continue;
                if (!Number.isFinite(precioUnitario) || precioUnitario < 0) continue;

                // Si el producto no existe en Neon, la línea se guarda con
                // producto_id = NULL para no perder la venta ni romper la FK.
                const productoIdFinal = Number.isInteger(productoId) && productoId > 0
                    ? productoId
                    : null;

                await client.query(
                    `INSERT INTO detalle_pedido
                        (pedido_id, producto_id, nombre_producto, cantidad, precio_unitario)
                     VALUES ($1, (SELECT id FROM productos WHERE id = $2), $3, $4, $5)`,
                    [
                        pedidoGuardado.id,
                        productoIdFinal,
                        String(linea.nombreProducto || ''),
                        cantidad,
                        precioUnitario
                    ]
                );
            }

            // Primer evento de la línea de tiempo.
            try {
                await client.query(
                    `INSERT INTO eventos_pedido (uuid_operation, pedido_id, estado, usuario_id, nota)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (uuid_operation) DO NOTHING`,
                    [
                        crypto.randomUUID(),
                        pedidoGuardado.id,
                        pedidoGuardado.estado || 'PENDIENTE',
                        usuarioFinal,
                        'Pedido registrado desde la app Cliente'
                    ]
                );
            } catch (e) {
                // Si el esquema 003 aún no se ejecutó, el pedido igual se guarda.
                console.warn('No se pudo registrar el evento inicial:', e.message);
            }

            // Si es un pedido con pago QR, se crea desde ya la intención de
            // pago para que el cliente y el repartidor vean el mismo registro
            // en Neon (y no solo un estado local en la app).
            const tipoPagoGuardado = String(pedidoGuardado.tipo_pago || '').toUpperCase();
            if (tipoPagoGuardado.includes('QR')) {
                const totalPago = Number(pedidoGuardado.total);
                try {
                    await client.query(
                        `INSERT INTO pagos
                            (uuid_operation, pedido_id, medio, monto, referencia, estado, expira_en)
                         VALUES ($1, $2, 'QR', $3, $4, 'PENDIENTE', NOW() + INTERVAL '1 day')
                         ON CONFLICT DO NOTHING`,
                        [
                            `pago-pedido-${pedidoGuardado.id}`,
                            pedidoGuardado.id,
                            Number.isFinite(totalPago) ? totalPago : 0,
                            `QR-${pedidoGuardado.id}`
                        ]
                    );
                } catch (e) {
                    console.warn('No se pudo registrar el pago QR inicial:', e.message);
                }
            }

            await client.query('COMMIT');

            console.log('✅ Pedido guardado en Neon con ID:', pedidoGuardado.id);
            res.status(201).json({
                id: pedidoGuardado.id,
                numeroOrden: pedidoGuardado.numero_orden,
                total: parseFloat(pedidoGuardado.total),
                tienda: pedidoGuardado.tienda,
                tiendaId: pedidoGuardado.tienda_id,
                usuarioId: pedidoGuardado.usuario_id,
                tipoPago: pedidoGuardado.tipo_pago,
                tipoEntrega: pedidoGuardado.tipo_entrega || 'RECOJO',
                costoDelivery: parseFloat(pedidoGuardado.costo_delivery || 0),
                direccionEntrega: pedidoGuardado.direccion_entrega || '',
                telefonoEntrega: pedidoGuardado.telefono_entrega || '',
                estado: pedidoGuardado.estado,
                fecha: pedidoGuardado.fecha,
                uuidOperation: pedidoGuardado.uuid_operation,
                detalles: lineas.map((l) => ({
                    productoId: Number.isInteger(Number(l.productoId)) && Number(l.productoId) > 0
                        ? Number(l.productoId)
                        : null,
                    nombreProducto: String(l.nombreProducto || ''),
                    cantidad: Number(l.cantidad),
                    precioUnitario: Number(l.precioUnitario),
                    subtotal: Number(l.cantidad) * Number(l.precioUnitario)
                }))
            });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('❌ Error al registrar pedido en Neon:', err);
            res.status(500).json({ error: 'Error al registrar el pedido' });
        } finally {
            client.release();
        }
    });

    app.get('/api/pedidos', ...proteger('cliente', 'admin', 'repartidor'), async (req, res) => {
        try {
            // Un cliente solo ve sus propios pedidos; admin y repartidor ven todos.
            const soloCliente = authActiva && req.usuario &&
                grupoRol(req.usuario.rol) === 'cliente';
            const filtroCliente = soloCliente ? 'WHERE lower(u.correo) = lower($1)' : '';
            const valores = soloCliente ? [req.usuario.correo] : [];

            const result = await pool.query(`
                SELECT p.*,
                       u.nombre AS cliente_nombre,
                       u.correo AS cliente_correo,
                       t.nombre AS tienda_nombre,
                       t.latitud AS tienda_latitud,
                       t.longitud AS tienda_longitud,
                       r.nombre AS repartidor_nombre,
                       r.correo AS repartidor_correo,
                       pg.estado AS pago_estado,
                       pg.referencia AS pago_referencia
                FROM pedidos p
                LEFT JOIN usuarios u ON u.id = p.usuario_id
                LEFT JOIN tiendas t ON t.id = p.tienda_id
                LEFT JOIN usuarios r ON r.id = p.repartidor_id
                LEFT JOIN LATERAL (
                    SELECT estado, referencia
                    FROM pagos
                    WHERE pedido_id = p.id
                    ORDER BY creado_en DESC
                    LIMIT 1
                ) pg ON TRUE
                ${filtroCliente}
                ORDER BY p.id DESC
            `, valores);

            const ids = result.rows.map((p) => p.id);
            const detallesPorPedido = await cargarDetalles(pool, ids);

            const pedidos = result.rows.map((p) => mapearPedido(p, detallesPorPedido.get(p.id) || []));

            res.json(pedidos);
        } catch (err) {
            console.error('Error al obtener pedidos:', err);
            res.status(500).json({ error: 'Error al listar los pedidos' });
        }
    });

    app.get('/api/pedidos/:id', ...proteger('cliente', 'admin', 'repartidor'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El id del pedido no es válido' });
        }
        try {
            const result = await pool.query(`
                SELECT p.*,
                       u.nombre AS cliente_nombre,
                       u.correo AS cliente_correo,
                       t.nombre AS tienda_nombre,
                       t.latitud AS tienda_latitud,
                       t.longitud AS tienda_longitud,
                       r.nombre AS repartidor_nombre,
                       r.correo AS repartidor_correo,
                       pg.estado AS pago_estado,
                       pg.referencia AS pago_referencia
                FROM pedidos p
                LEFT JOIN usuarios u ON u.id = p.usuario_id
                LEFT JOIN tiendas t ON t.id = p.tienda_id
                LEFT JOIN usuarios r ON r.id = p.repartidor_id
                LEFT JOIN LATERAL (
                    SELECT estado, referencia
                    FROM pagos
                    WHERE pedido_id = p.id
                    ORDER BY creado_en DESC
                    LIMIT 1
                ) pg ON TRUE
                WHERE p.id = $1
                LIMIT 1
            `, [id]);

            if (!result.rowCount) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            const pedido = result.rows[0];
            if (authActiva && req.usuario && grupoRol(req.usuario.rol) === 'cliente') {
                const dueno = String(pedido.cliente_correo || '').toLowerCase();
                if (dueno !== String(req.usuario.correo || '').toLowerCase()) {
                    return res.status(404).json({ error: 'Pedido no encontrado' });
                }
            }

            const detalles = await cargarDetalles(pool, [id]);
            res.json(mapearPedido(pedido, detalles.get(id) || []));
        } catch (err) {
            console.error('Error al obtener el pedido:', err);
            res.status(500).json({ error: 'Error al obtener el pedido' });
        }
    });

    // --------------------------------------------------------
    // 7. COCINA: COMANDAS Y CAMBIO DE ESTADO
    // --------------------------------------------------------
    app.get('/api/cocina/comandas', ...protegerAdmin('cocina', 'cajero', 'dueno'), async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT p.*,
                       u.nombre AS cliente_nombre,
                       u.correo AS cliente_correo,
                       t.nombre AS tienda_nombre,
                       r.nombre AS repartidor_nombre,
                       r.correo AS repartidor_correo
                FROM pedidos p
                LEFT JOIN usuarios u ON u.id = p.usuario_id
                LEFT JOIN tiendas t ON t.id = p.tienda_id
                LEFT JOIN usuarios r ON r.id = p.repartidor_id
                WHERE upper(p.estado) IN ('PENDIENTE', 'RECIBIDO', 'EN_COCINA', 'LISTO')
                   OR upper(p.estado) LIKE '%COCINA%'
                ORDER BY p.id ASC
            `);
            const ids = result.rows.map((p) => p.id);
            const detallesPorPedido = await cargarDetalles(pool, ids);
            res.json(result.rows.map((p) => mapearPedido(p, detallesPorPedido.get(p.id) || [])));
        } catch (err) {
            console.error('Error al obtener comandas:', err);
            res.status(500).json({ error: 'Error al listar las comandas' });
        }
    });

    app.put('/api/pedidos/:id/estado', ...proteger('admin', 'repartidor'), bloquearRolAdmin('cajero'), async (req, res) => {
        const id = Number(req.params.id);
        const { estado, usuarioCorreo, rol, nota } = req.body || {};
        const nuevoEstado = String(estado || '').trim().toUpperCase();

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El id del pedido no es válido' });
        }
        if (!nuevoEstado) {
            return res.status(400).json({ error: 'El estado es obligatorio' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const actual = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [id]);
            if (!actual.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            const pedido = actual.rows[0];
            const estadoActual = String(pedido.estado || 'PENDIENTE').toUpperCase();
            const permitidos = TRANSICIONES[estadoActual] || [];

            if (nuevoEstado === estadoActual) {
                await client.query('COMMIT');
                return res.json({ ok: true, estado: estadoActual, sinCambios: true });
            }
            if (!permitidos.includes(nuevoEstado)) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: `No se puede pasar de ${estadoActual} a ${nuevoEstado}`,
                    transicionesPermitidas: permitidos
                });
            }

            const usuarioId = await resolverUsuario(client, null, usuarioCorreo);
            await client.query('UPDATE pedidos SET estado = $1 WHERE id = $2', [nuevoEstado, id]);

            try {
                await client.query(
                    `INSERT INTO eventos_pedido (uuid_operation, pedido_id, estado, usuario_id, nota)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [
                        crypto.randomUUID(),
                        id,
                        nuevoEstado,
                        usuarioId,
                        String(nota || `Cambio a ${nuevoEstado}`)
                    ]
                );
            } catch (e) {
                console.warn('No se pudo registrar el evento de estado:', e.message);
            }

            await client.query('COMMIT');
            res.json({
                ok: true,
                id,
                estado: nuevoEstado,
                transicionesPermitidas: TRANSICIONES[nuevoEstado] || []
            });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('Error al cambiar el estado:', err);
            res.status(500).json({ error: 'Error al cambiar el estado del pedido' });
        } finally {
            client.release();
        }
    });

    // Cancelación desde la app CLIENTE. Solo el dueño del pedido puede usarla
    // y únicamente mientras el pedido no haya pasado a LISTO.
    app.post('/api/pedidos/:id/cancelar', ...proteger('cliente'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El id del pedido no es válido' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const actual = await client.query(
                `SELECT p.*,
                        (SELECT u.correo FROM usuarios u WHERE u.id = p.usuario_id) AS cliente_correo
                 FROM pedidos p
                 WHERE p.id = $1
                 FOR UPDATE`,
                [id]
            );

            if (!actual.rowCount) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            const pedido = actual.rows[0];
            if (authActiva && req.usuario) {
                const dueno = String(pedido.cliente_correo || '').toLowerCase();
                const correoSesion = String(req.usuario.correo || '').toLowerCase();
                if (!dueno || dueno !== correoSesion) {
                    await client.query('ROLLBACK');
                    return res.status(403).json({
                        error: 'No tienes permisos para cancelar este pedido'
                    });
                }
            }

            const estadoActual = String(pedido.estado || 'PENDIENTE').trim().toUpperCase();
            if (estadoActual === 'CANCELADO') {
                await client.query('COMMIT');
                return res.json({ ok: true, id, estado: 'CANCELADO', sinCambios: true });
            }

            if (!ESTADOS_CANCELABLES_CLIENTE.includes(estadoActual)) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    error: `El pedido ya no se puede cancelar porque está en estado ${estadoActual}`,
                    estado: estadoActual
                });
            }

            await client.query('UPDATE pedidos SET estado = $1 WHERE id = $2', ['CANCELADO', id]);

            try {
                await client.query(
                    `INSERT INTO eventos_pedido (uuid_operation, pedido_id, estado, usuario_id, nota)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [
                        crypto.randomUUID(),
                        id,
                        'CANCELADO',
                        req.usuario ? req.usuario.id : null,
                        'Pedido cancelado por el cliente'
                    ]
                );
            } catch (e) {
                console.warn('No se pudo registrar el evento de cancelación:', e.message);
            }

            await client.query('COMMIT');
            res.json({ ok: true, id, estado: 'CANCELADO' });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('Error al cancelar el pedido:', err);
            res.status(500).json({ error: 'Error al cancelar el pedido' });
        } finally {
            client.release();
        }
    });

    app.get('/api/pedidos/:id/eventos', ...proteger('cliente', 'admin', 'repartidor'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El id del pedido no es válido' });
        }
        try {
            const result = await pool.query(
                `SELECT e.*, u.nombre AS usuario_nombre
                 FROM eventos_pedido e
                 LEFT JOIN usuarios u ON u.id = e.usuario_id
                 WHERE e.pedido_id = $1
                 ORDER BY e.fecha_hora ASC, e.id ASC`,
                [id]
            );
            res.json(result.rows.map((e) => ({
                id: e.id,
                estado: e.estado,
                fechaHora: e.fecha_hora,
                usuarioId: e.usuario_id,
                usuarioNombre: e.usuario_nombre,
                nota: e.nota
            })));
        } catch (err) {
            console.error('Error al obtener eventos:', err);
            res.status(500).json({ error: 'Error al obtener la línea de tiempo' });
        }
    });

    // --------------------------------------------------------
    // 8. REPARTIDORES: ASIGNACIÓN, TURNO Y UBICACIÓN
    // --------------------------------------------------------
    app.get('/api/repartidores', ...protegerAdmin('cajero', 'dueno'), async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT u.id, u.nombre, u.correo, u.telefono,
                       COALESCE(r.turno_activo, FALSE) AS turno_activo,
                       COALESCE(r.disponible, TRUE) AS disponible,
                       r.latitud, r.longitud, r.actualizado_en,
                       (SELECT COUNT(*) FROM pedidos p
                        WHERE p.repartidor_id = u.id
                          AND upper(p.estado) IN ('EN_CAMINO', 'LISTO')) AS pedidos_activos
                FROM usuarios u
                LEFT JOIN repartidores r ON r.usuario_id = u.id
                WHERE lower(u.rol) IN ('repartidor', 'delivery')
                ORDER BY u.nombre ASC
            `);
            res.json(result.rows.map((r) => ({
                id: r.id,
                nombre: r.nombre,
                correo: r.correo,
                telefono: r.telefono || '',
                turnoActivo: r.turno_activo,
                disponible: r.disponible,
                latitud: r.latitud === null ? null : parseFloat(r.latitud),
                longitud: r.longitud === null ? null : parseFloat(r.longitud),
                actualizadoEn: r.actualizado_en,
                pedidosActivos: Number(r.pedidos_activos || 0)
            })));
        } catch (err) {
            console.error('Error al listar repartidores:', err);
            res.status(500).json({ error: 'Error al listar los repartidores' });
        }
    });

    app.put('/api/pedidos/:id/asignar', ...protegerAdmin('cajero', 'dueno'), async (req, res) => {
        const id = Number(req.params.id);
        const { repartidorCorreo, repartidorId } = req.body || {};

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El id del pedido no es válido' });
        }
        if (!repartidorCorreo && !Number.isInteger(repartidorId)) {
            return res.status(400).json({ error: 'Debes indicar el repartidor' });
        }

        try {
            const repartidor = await obtenerUsuarioPorCorreo(pool, repartidorCorreo);
            const idFinal = Number.isInteger(repartidorId) && repartidorId > 0
                ? repartidorId
                : repartidor && repartidor.id;

            if (!idFinal) {
                return res.status(404).json({ error: 'Repartidor no encontrado' });
            }

            const result = await pool.query(
                `UPDATE pedidos
                 SET repartidor_id = $1
                 WHERE id = $2
                 RETURNING id, numero_orden, estado, repartidor_id`,
                [idFinal, id]
            );

            if (!result.rowCount) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            // Asegurar la fila del repartidor para su turno.
            try {
                await pool.query(
                    `INSERT INTO repartidores (usuario_id)
                     VALUES ($1)
                     ON CONFLICT (usuario_id) DO NOTHING`,
                    [idFinal]
                );
            } catch (e) {
                console.warn('No se pudo preparar el repartidor:', e.message);
            }

            res.json({ ok: true, ...result.rows[0] });
        } catch (err) {
            console.error('Error al asignar repartidor:', err);
            res.status(500).json({ error: 'Error al asignar el repartidor' });
        }
    });

    app.get('/api/repartidor/pedidos', ...proteger('repartidor'), async (req, res) => {
        const correo = correoDeSesion(req, req.query.correo);
        if (!correo) {
            return res.status(400).json({ error: 'El correo del repartidor es obligatorio' });
        }

        try {
            const usuario = await obtenerUsuarioPorCorreo(pool, correo);
            if (!usuario) {
                return res.status(404).json({ error: 'Repartidor no encontrado' });
            }

            const result = await pool.query(`
                SELECT p.*,
                       u.nombre AS cliente_nombre,
                       u.correo AS cliente_correo,
                       t.nombre AS tienda_nombre,
                       r.nombre AS repartidor_nombre,
                       r.correo AS repartidor_correo,
                       pg.estado AS pago_estado,
                       pg.referencia AS pago_referencia
                FROM pedidos p
                LEFT JOIN usuarios u ON u.id = p.usuario_id
                LEFT JOIN tiendas t ON t.id = p.tienda_id
                LEFT JOIN usuarios r ON r.id = p.repartidor_id
                LEFT JOIN LATERAL (
                    SELECT estado, referencia
                    FROM pagos
                    WHERE pedido_id = p.id
                    ORDER BY creado_en DESC
                    LIMIT 1
                ) pg ON TRUE
                WHERE p.repartidor_id = $1
                ORDER BY p.id DESC
            `, [usuario.id]);

            const ids = result.rows.map((p) => p.id);
            const detallesPorPedido = await cargarDetalles(pool, ids);
            res.json(result.rows.map((p) => mapearPedido(p, detallesPorPedido.get(p.id) || [])));
        } catch (err) {
            console.error('Error al listar pedidos del repartidor:', err);
            res.status(500).json({ error: 'Error al listar los pedidos asignados' });
        }
    });

    app.get('/api/repartidor/perfil', ...proteger('repartidor'), async (req, res) => {
        const correo = correoDeSesion(req, req.query.correo);
        if (!correo) {
            return res.status(400).json({ error: 'El correo es obligatorio' });
        }
        try {
            const result = await pool.query(`
                SELECT u.id, u.nombre, u.correo, u.telefono, u.rol,
                       COALESCE(r.turno_activo, FALSE) AS turno_activo,
                       COALESCE(r.disponible, TRUE) AS disponible,
                       r.latitud, r.longitud, r.actualizado_en
                FROM usuarios u
                LEFT JOIN repartidores r ON r.usuario_id = u.id
                WHERE lower(u.correo) = lower($1)
                LIMIT 1
            `, [correo]);

            if (!result.rowCount) {
                return res.status(404).json({ error: 'Repartidor no encontrado' });
            }
            const r = result.rows[0];
            res.json({
                id: r.id,
                nombre: r.nombre,
                correo: r.correo,
                telefono: r.telefono || '',
                rol: r.rol,
                turnoActivo: r.turno_activo,
                disponible: r.disponible,
                latitud: r.latitud === null ? null : parseFloat(r.latitud),
                longitud: r.longitud === null ? null : parseFloat(r.longitud),
                actualizadoEn: r.actualizado_en
            });
        } catch (err) {
            console.error('Error al obtener perfil del repartidor:', err);
            res.status(500).json({ error: 'Error al obtener el perfil' });
        }
    });

    app.put('/api/repartidor/turno', ...proteger('repartidor'), async (req, res) => {
        const { activo, latitud, longitud } = req.body || {};
        const correo = correoDeSesion(req, (req.body || {}).correo);
        if (!correo) {
            return res.status(400).json({ error: 'El correo es obligatorio' });
        }

        try {
            const usuario = await obtenerUsuarioPorCorreo(pool, correo);
            if (!usuario) {
                return res.status(404).json({ error: 'Repartidor no encontrado' });
            }

            const lat = Number.isFinite(Number(latitud)) ? Number(latitud) : null;
            const lng = Number.isFinite(Number(longitud)) ? Number(longitud) : null;

            const result = await pool.query(
                `INSERT INTO repartidores (usuario_id, turno_activo, disponible, latitud, longitud, actualizado_en)
                 VALUES ($1, $2, $2, $3, $4, NOW())
                 ON CONFLICT (usuario_id) DO UPDATE SET
                    turno_activo = EXCLUDED.turno_activo,
                    disponible = EXCLUDED.turno_activo,
                    latitud = COALESCE(EXCLUDED.latitud, repartidores.latitud),
                    longitud = COALESCE(EXCLUDED.longitud, repartidores.longitud),
                    actualizado_en = NOW()
                 RETURNING *`,
                [usuario.id, Boolean(activo), lat, lng]
            );

            res.json({
                ok: true,
                turnoActivo: result.rows[0].turno_activo,
                disponible: result.rows[0].disponible,
                latitud: result.rows[0].latitud === null ? null : parseFloat(result.rows[0].latitud),
                longitud: result.rows[0].longitud === null ? null : parseFloat(result.rows[0].longitud)
            });
        } catch (err) {
            console.error('Error al cambiar turno:', err);
            res.status(500).json({ error: 'Error al cambiar el turno' });
        }
    });

    app.post('/api/repartidor/ubicacion', ...proteger('repartidor'), async (req, res) => {
        const { latitud, longitud } = req.body || {};
        const correo = correoDeSesion(req, (req.body || {}).correo);
        if (!correo) {
            return res.status(400).json({ error: 'El correo es obligatorio' });
        }
        if (!Number.isFinite(Number(latitud)) || !Number.isFinite(Number(longitud))) {
            return res.status(400).json({ error: 'La latitud y la longitud son obligatorias' });
        }

        try {
            const usuario = await obtenerUsuarioPorCorreo(pool, correo);
            if (!usuario) {
                return res.status(404).json({ error: 'Repartidor no encontrado' });
            }

            const lat = Number(latitud);
            const lng = Number(longitud);

            await pool.query(
                `INSERT INTO repartidores (usuario_id, latitud, longitud, actualizado_en)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (usuario_id) DO UPDATE SET
                    latitud = EXCLUDED.latitud,
                    longitud = EXCLUDED.longitud,
                    actualizado_en = NOW()`,
                [usuario.id, lat, lng]
            );

            await pool.query(
                `INSERT INTO ubicaciones_repartidor (repartidor_id, latitud, longitud)
                 VALUES ($1, $2, $3)`,
                [usuario.id, lat, lng]
            );

            res.json({ ok: true, latitud: lat, longitud: lng });
        } catch (err) {
            console.error('Error al registrar ubicación:', err);
            res.status(500).json({ error: 'Error al registrar la ubicación' });
        }
    });

    // --------------------------------------------------------
    // 9. ENTREGAS CON FOTO DE EVIDENCIA
    // --------------------------------------------------------
    app.post('/api/entregas', ...proteger('repartidor'), async (req, res) => {
        const {
            pedidoId, fotoBase64, fotoUrl,
            latitud, longitud
        } = req.body || {};
        const usuarioCorreo = correoDeSesion(req, (req.body || {}).usuarioCorreo);

        const id = Number(pedidoId);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pedido es obligatorio' });
        }

        try {
            let urlFinal = typeof fotoUrl === 'string' ? fotoUrl.trim() : '';

            if (!urlFinal && typeof fotoBase64 === 'string' && fotoBase64.trim() !== '') {
                const coincidencia = /^data:([^;]+);base64,/i.exec(fotoBase64.trim());
                const contentType = coincidencia ? coincidencia[1] : 'image/jpeg';
                const limpio = fotoBase64.includes(',')
                    ? fotoBase64.split(',').pop()
                    : fotoBase64;
                const buffer = Buffer.from(limpio, 'base64');
                if (buffer.length === 0) {
                    return res.status(400).json({ error: 'La foto está vacía' });
                }
                if (buffer.length > 6 * 1024 * 1024) {
                    return res.status(413).json({ error: 'La foto supera 6 MB' });
                }

                // Primero se intenta Object Storage (Neon S3). Si falla o no
                // está configurado, se conserva el respaldo local para que la
                // entrega no se pierda en el momento.
                let subida = null;
                if (almacenamientoConfigurado()) {
                    try {
                        subida = await subirFoto(buffer, id, contentType);
                    } catch (error) {
                        console.warn(
                            'No se pudo subir la foto a Object Storage; se guarda localmente:',
                            error.message
                        );
                    }
                }

                if (subida) {
                    console.log(
                        `✅ Foto de entrega ${id} subida a Object Storage: ${subida.key}`
                    );
                    urlFinal = subida.url;
                } else {
                    const extension = /png/i.test(contentType)
                        ? 'png'
                        : (/webp/i.test(contentType) ? 'webp' : 'jpg');
                    const nombre = `entrega-${id}-${Date.now()}.${extension}`;
                    fs.writeFileSync(path.join(UPLOADS_DIR, nombre), buffer);
                    urlFinal = `/uploads/${nombre}`;
                }
            }

            if (!urlFinal) {
                return res.status(400).json({ error: 'La foto de entrega es obligatoria' });
            }

            const usuarioId = await resolverUsuario(pool, null, usuarioCorreo);
            const lat = Number.isFinite(Number(latitud)) ? Number(latitud) : null;
            const lng = Number.isFinite(Number(longitud)) ? Number(longitud) : null;

            const result = await pool.query(
                `INSERT INTO entregas (pedido_id, foto_url, latitud, longitud)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (pedido_id) DO UPDATE SET
                    foto_url = EXCLUDED.foto_url,
                    latitud = EXCLUDED.latitud,
                    longitud = EXCLUDED.longitud,
                    fecha_hora = NOW()
                 RETURNING *`,
                [id, urlFinal, lat, lng]
            );

            try {
                await pool.query(
                    `INSERT INTO eventos_pedido (uuid_operation, pedido_id, estado, usuario_id, nota)
                     VALUES ($1, $2, 'EVIDENCIA', $3, 'Foto de entrega registrada')`,
                    [crypto.randomUUID(), id, usuarioId]
                );
            } catch (e) {
                console.warn('No se pudo registrar el evento de evidencia:', e.message);
            }

            res.status(201).json({
                ok: true,
                id: result.rows[0].id,
                pedidoId: id,
                fotoUrl: urlFinal,
                latitud: lat,
                longitud: lng
            });
        } catch (err) {
            console.error('Error al registrar entrega:', err);
            res.status(500).json({ error: 'Error al registrar la entrega' });
        }
    });

    // --------------------------------------------------------
    // 10. PAGOS QR (SIMULACIÓN DEL NÚCLEO BANCO ANDINO)
    // --------------------------------------------------------
    app.post('/api/pagos/qr', ...proteger('admin', 'repartidor'), bloquearRolAdmin('cocina'), async (req, res) => {
        const { pedidoId, monto, medio } = req.body || {};
        const id = Number(pedidoId);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pedido es obligatorio' });
        }

        try {
            const pedido = await pool.query(
                'SELECT id, numero_orden, total FROM pedidos WHERE id = $1 LIMIT 1',
                [id]
            );
            if (!pedido.rowCount) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            const montoFinal = Number.isFinite(Number(monto))
                ? Number(monto)
                : parseFloat(pedido.rows[0].total);
            // Si el pedido ya tiene una intención de pago QR pendiente
            // (creada al registrar el pedido), se reutiliza para no duplicar
            // filas en la tabla pagos.
            const existente = await pool.query(
                `SELECT * FROM pagos
                 WHERE pedido_id = $1 AND estado IN ('PENDIENTE', 'QR_GENERADO')
                 ORDER BY creado_en DESC
                 LIMIT 1`,
                [id]
            );

            let pago;
            if (existente.rowCount > 0) {
                pago = existente.rows[0];
                await pool.query(
                    `UPDATE pagos SET expira_en = NOW() + INTERVAL '10 minutes' WHERE id = $1`,
                    [pago.id]
                );
            } else {
                const referencia = `QR-${id}-${Date.now().toString(36).toUpperCase()}`;
                const expira = new Date(Date.now() + 10 * 60 * 1000);
                const result = await pool.query(
                    `INSERT INTO pagos
                        (uuid_operation, pedido_id, medio, monto, referencia, estado, expira_en)
                     VALUES ($1, $2, $3, $4, $5, 'QR_GENERADO', $6)
                     RETURNING *`,
                    [
                        crypto.randomUUID(),
                        id,
                        String(medio || 'QR').toUpperCase(),
                        montoFinal,
                        referencia,
                        expira.toISOString()
                    ]
                );
                pago = result.rows[0];
            }

            const montoPago = parseFloat(pago.monto);
            res.status(201).json({
                id: pago.id,
                pedidoId: pago.pedido_id,
                medio: pago.medio,
                monto: montoPago,
                referencia: pago.referencia,
                estado: pago.estado,
                expiraEn: pago.expira_en,
                // Payload que la app dibuja como QR simulado.
                qrPayload: `BANCO-ANDINO|${pago.referencia}|${montoPago.toFixed(2)}|${pedido.rows[0].numero_orden}`
            });
        } catch (err) {
            console.error('Error al generar QR:', err);
            res.status(500).json({ error: 'Error al generar el QR de cobro' });
        }
    });

    app.get('/api/pagos/:pedidoId', ...proteger('cliente', 'admin', 'repartidor'), async (req, res) => {
        const id = Number(req.params.pedidoId);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pedido no es válido' });
        }
        try {
            const result = await pool.query(
                `SELECT * FROM pagos
                 WHERE pedido_id = $1
                 ORDER BY creado_en DESC
                 LIMIT 1`,
                [id]
            );
            if (!result.rowCount) {
                return res.json(null);
            }
            const p = result.rows[0];
            res.json({
                id: p.id,
                pedidoId: p.pedido_id,
                medio: p.medio,
                monto: parseFloat(p.monto),
                referencia: p.referencia,
                nroOperacionBanco: p.nro_operacion_banco,
                estado: p.estado,
                expiraEn: p.expira_en,
                confirmadoEn: p.confirmado_en
            });
        } catch (err) {
            console.error('Error al consultar pago:', err);
            res.status(500).json({ error: 'Error al consultar el pago' });
        }
    });

    app.post('/api/pagos/:pagoId/confirmar', ...proteger('admin', 'repartidor'), bloquearRolAdmin('cocina'), async (req, res) => {
        const id = Number(req.params.pagoId);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pago no es válido' });
        }
        try {
            const nroOperacion = `BA-${Date.now().toString(36).toUpperCase()}`;
            const result = await pool.query(
                `UPDATE pagos
                 SET estado = 'CONFIRMADO',
                     nro_operacion_banco = $1,
                     confirmado_en = NOW()
                 WHERE id = $2
                 RETURNING *`,
                [nroOperacion, id]
            );
            if (!result.rowCount) {
                return res.status(404).json({ error: 'Pago no encontrado' });
            }
            const p = result.rows[0];
            res.json({
                ok: true,
                id: p.id,
                pedidoId: p.pedido_id,
                estado: p.estado,
                nroOperacionBanco: p.nro_operacion_banco,
                confirmadoEn: p.confirmado_en
            });
        } catch (err) {
            console.error('Error al confirmar pago:', err);
            res.status(500).json({ error: 'Error al confirmar el pago' });
        }
    });

    // --------------------------------------------------------
    // 11. CAJA, CRÉDITO Y ANALÍTICA
    // --------------------------------------------------------
    const round2 = (n) => Number((Number(n) || 0).toFixed(2));
    const fechaISO = (d) =>
        d instanceof Date ? d.toISOString().slice(0, 10) : String(d || '').slice(0, 10);
    const hoyISO = () => new Date().toISOString().slice(0, 10);
    const esFechaISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

    function mapCierre(r) {
        return {
            id: r.id,
            fecha: fechaISO(r.fecha),
            totalVentas: round2(r.total_ventas),
            totalEntregado: round2(r.total_entregado),
            totalEfectivo: round2(r.total_efectivo),
            totalQr: round2(r.total_qr),
            totalAbonos: round2(r.total_abonos),
            diferencia: round2(r.diferencia),
            estado: r.estado,
            justificacion: r.justificacion || '',
            cerradoEn: r.cerrado_en || null
        };
    }

    function mapSolicitud(r) {
        return {
            id: r.id,
            montoSolicitado: round2(r.monto_solicitado),
            ventasUltimoMes: round2(r.ventas_ultimo_mes),
            autorizaCompartir: r.autoriza_compartir,
            estado: r.estado,
            observacion: r.observacion || '',
            creadoEn: r.creado_en || null
        };
    }

    async function calcularCierre(fecha) {
        const ventas = await pool.query(`
            SELECT
                COUNT(*) AS pedidos,
                COALESCE(SUM(p.total), 0) AS total_ventas,
                COALESCE(SUM(CASE WHEN upper(p.estado) LIKE 'ENTREGADO%'
                                   THEN p.total ELSE 0 END), 0) AS total_entregado,
                COALESCE(SUM(CASE WHEN upper(p.estado) LIKE 'ENTREGADO%'
                                   AND upper(p.tipo_pago) LIKE '%QR%'
                                   THEN p.total ELSE 0 END), 0) AS total_qr,
                COALESCE(SUM(CASE WHEN upper(p.estado) LIKE 'ENTREGADO%'
                                   AND upper(p.tipo_pago) LIKE '%EFECTIVO%'
                                   THEN p.total ELSE 0 END), 0) AS total_efectivo
            FROM pedidos p
            WHERE p.creado_en::date = $1::date
        `, [fecha]);

        const abonos = await pool.query(`
            SELECT COALESCE(SUM(monto), 0) AS total_abonos
            FROM pagos
            WHERE estado = 'CONFIRMADO'
              AND creado_en::date = $1::date
        `, [fecha]);

        const cierre = await pool.query(
            `SELECT * FROM cierres_caja WHERE fecha = $1::date LIMIT 1`,
            [fecha]
        );

        const v = ventas.rows[0];
        const totalQr = round2(v.total_qr);
        const totalAbonos = round2(abonos.rows[0].total_abonos);
        const abonosBanco = cierre.rowCount
            ? round2(cierre.rows[0].total_abonos)
            : totalAbonos;
        return {
            fecha,
            pedidos: Number(v.pedidos || 0),
            totalVentas: round2(v.total_ventas),
            totalEntregado: round2(v.total_entregado),
            totalQr,
            totalEfectivo: round2(v.total_efectivo),
            totalAbonos,
            abonosBanco,
            diferencia: round2(totalQr - abonosBanco),
            cierre: cierre.rowCount ? mapCierre(cierre.rows[0]) : null
        };
    }

    app.get('/api/caja/cierre', ...protegerAdmin('cajero', 'dueno'), async (req, res) => {
        try {
            const fecha = req.query.fecha ? String(req.query.fecha) : hoyISO();
            if (!esFechaISO(fecha)) {
                return res.status(400).json({ error: 'La fecha debe tener formato YYYY-MM-DD' });
            }
            res.json(await calcularCierre(fecha));
        } catch (err) {
            console.error('Error al obtener cierre de caja:', err);
            res.status(500).json({ error: 'Error al obtener el cierre de caja' });
        }
    });

    app.get('/api/caja/cierres', ...protegerAdmin('cajero', 'dueno'), async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT * FROM cierres_caja ORDER BY fecha DESC LIMIT 30`
            );
            res.json(result.rows.map(mapCierre));
        } catch (err) {
            console.error('Error al listar cierres:', err);
            res.status(500).json({ error: 'Error al listar los cierres de caja' });
        }
    });

    app.post('/api/caja/cerrar', ...protegerAdmin('cajero', 'dueno'), async (req, res) => {
        const { fecha, abonosBanco, justificacion } = req.body || {};
        const fechaFinal = fecha ? String(fecha) : hoyISO();
        if (!esFechaISO(fechaFinal)) {
            return res.status(400).json({ error: 'La fecha debe tener formato YYYY-MM-DD' });
        }

        try {
            const resumen = await calcularCierre(fechaFinal);
            const abonos = Number.isFinite(Number(abonosBanco))
                ? round2(abonosBanco)
                : resumen.totalAbonos;
            const diferencia = round2(resumen.totalQr - abonos);
            const nota = String(justificacion || '').trim();

            if (Math.abs(diferencia) > 0.009 && nota === '') {
                return res.status(400).json({
                    error: 'Hay una diferencia entre ventas QR y abonos del banco. Escribe una justificación para cerrar.'
                });
            }

            const result = await pool.query(`
                INSERT INTO cierres_caja
                    (fecha, total_ventas, total_entregado, total_efectivo, total_qr,
                     total_abonos, diferencia, estado, justificacion, usuario_id, cerrado_en)
                VALUES ($1, $2, $3, $4, $5, $6, $7, 'CERRADO', $8, $9, NOW())
                ON CONFLICT (fecha) DO UPDATE SET
                    total_ventas = EXCLUDED.total_ventas,
                    total_entregado = EXCLUDED.total_entregado,
                    total_efectivo = EXCLUDED.total_efectivo,
                    total_qr = EXCLUDED.total_qr,
                    total_abonos = EXCLUDED.total_abonos,
                    diferencia = EXCLUDED.diferencia,
                    estado = EXCLUDED.estado,
                    justificacion = EXCLUDED.justificacion,
                    usuario_id = EXCLUDED.usuario_id,
                    cerrado_en = NOW()
                RETURNING *
            `, [
                fechaFinal,
                resumen.totalVentas,
                resumen.totalEntregado,
                resumen.totalEfectivo,
                resumen.totalQr,
                abonos,
                diferencia,
                nota || null,
                req.usuario ? req.usuario.id : null
            ]);

            res.status(201).json({ ok: true, cierre: mapCierre(result.rows[0]) });
        } catch (err) {
            console.error('Error al cerrar caja:', err);
            res.status(500).json({ error: 'Error al cerrar la caja' });
        }
    });

    app.get('/api/credito/resumen', ...protegerAdmin('dueno'), async (_req, res) => {
        try {
            const ventas = await pool.query(`
                SELECT
                    COUNT(*) AS pedidos,
                    COALESCE(SUM(total), 0) AS ventas,
                    COALESCE(AVG(total), 0) AS ticket
                FROM pedidos
                WHERE upper(estado) LIKE 'ENTREGADO%'
                  AND creado_en >= NOW() - INTERVAL '30 days'
            `);
            const solicitudes = await pool.query(
                `SELECT * FROM solicitudes_credito ORDER BY creado_en DESC LIMIT 20`
            );
            const v = ventas.rows[0];
            res.json({
                ventasUltimoMes: round2(v.ventas),
                pedidosUltimoMes: Number(v.pedidos || 0),
                ticketPromedio: round2(v.ticket),
                solicitudes: solicitudes.rows.map(mapSolicitud)
            });
        } catch (err) {
            console.error('Error al obtener resumen de crédito:', err);
            res.status(500).json({ error: 'Error al obtener el resumen de crédito' });
        }
    });

    app.get('/api/credito/solicitudes', ...protegerAdmin('dueno'), async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT * FROM solicitudes_credito ORDER BY creado_en DESC LIMIT 30`
            );
            res.json(result.rows.map(mapSolicitud));
        } catch (err) {
            console.error('Error al listar solicitudes de crédito:', err);
            res.status(500).json({ error: 'Error al listar las solicitudes de crédito' });
        }
    });

    app.post('/api/credito/solicitudes', ...protegerAdmin('dueno'), async (req, res) => {
        const { montoSolicitado, autorizaCompartir } = req.body || {};
        const monto = Number(montoSolicitado);

        if (!Number.isFinite(monto) || monto <= 0) {
            return res.status(400).json({ error: 'El monto solicitado debe ser mayor a 0' });
        }
        if (autorizaCompartir !== true) {
            return res.status(400).json({
                error: 'Debes autorizar el envío del resumen de ventas al banco.'
            });
        }

        try {
            const ventas = await pool.query(`
                SELECT COALESCE(SUM(total), 0) AS ventas
                FROM pedidos
                WHERE upper(estado) LIKE 'ENTREGADO%'
                  AND creado_en >= NOW() - INTERVAL '30 days'
            `);
            const ventasUltimoMes = round2(ventas.rows[0].ventas);

            const result = await pool.query(`
                INSERT INTO solicitudes_credito
                    (usuario_id, monto_solicitado, ventas_ultimo_mes,
                     autoriza_compartir, estado)
                VALUES ($1, $2, $3, TRUE, 'ENVIADO')
                RETURNING *
            `, [
                req.usuario ? req.usuario.id : null,
                round2(monto),
                ventasUltimoMes
            ]);

            res.status(201).json(mapSolicitud(result.rows[0]));
        } catch (err) {
            console.error('Error al solicitar crédito:', err);
            res.status(500).json({ error: 'Error al registrar la solicitud de crédito' });
        }
    });

    app.post('/api/credito/solicitudes/:id/simular', ...protegerAdmin('dueno'), async (req, res) => {
        const id = Number(req.params.id);
        const { estado, observacion } = req.body || {};
        const estadosValidos = new Set([
            'EN_EVALUACION', 'APROBADO', 'CONDICIONADO', 'RECHAZADO', 'DESEMBOLSADO'
        ]);
        const estadoFinal = String(estado || '').toUpperCase();

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'La solicitud no es válida' });
        }
        if (!estadosValidos.has(estadoFinal)) {
            return res.status(400).json({ error: 'Estado de crédito no válido' });
        }

        try {
            const result = await pool.query(`
                UPDATE solicitudes_credito
                SET estado = $1, observacion = $2, actualizado_en = NOW()
                WHERE id = $3
                RETURNING *
            `, [estadoFinal, String(observacion || ''), id]);

            if (!result.rowCount) {
                return res.status(404).json({ error: 'Solicitud no encontrada' });
            }
            res.json(mapSolicitud(result.rows[0]));
        } catch (err) {
            console.error('Error al simular crédito:', err);
            res.status(500).json({ error: 'Error al actualizar la solicitud' });
        }
    });

    app.get('/api/analitica/ventas', ...protegerAdmin('dueno'), async (_req, res) => {
        try {
            const resumen = await pool.query(`
                SELECT
                    COUNT(*) AS pedidos,
                    COALESCE(SUM(total), 0) AS ventas,
                    COALESCE(AVG(total), 0) AS ticket_promedio
                FROM pedidos
                WHERE upper(estado) LIKE 'ENTREGADO%'
            `);
            const productos = await pool.query(`
                SELECT nombre_producto, SUM(cantidad) AS unidades
                FROM detalle_pedido
                GROUP BY nombre_producto
                ORDER BY unidades DESC
                LIMIT 5
            `);
            const r = resumen.rows[0];
            res.json({
                pedidos: Number(r.pedidos || 0),
                ventas: parseFloat(r.ventas || 0),
                ticketPromedio: parseFloat(r.ticket_promedio || 0),
                topProductos: productos.rows.map((p) => ({
                    nombre: p.nombre_producto,
                    unidades: Number(p.unidades || 0)
                }))
            });
        } catch (err) {
            console.error('Error al obtener analítica:', err);
            res.status(500).json({ error: 'Error al obtener la analítica' });
        }
    });

    app.get('/api/analitica/tablero', ...protegerAdmin('dueno'), async (_req, res) => {
        try {
            const resumen = await pool.query(`
                SELECT
                    COUNT(*) AS pedidos,
                    COALESCE(SUM(total), 0) AS ventas,
                    COALESCE(AVG(total), 0) AS ticket_promedio,
                    COALESCE(SUM(CASE WHEN upper(tipo_pago) LIKE '%QR%'
                                       THEN total ELSE 0 END), 0) AS total_qr,
                    COALESCE(SUM(CASE WHEN upper(tipo_pago) LIKE '%EFECTIVO%'
                                       THEN total ELSE 0 END), 0) AS total_efectivo
                FROM pedidos
                WHERE upper(estado) LIKE 'ENTREGADO%'
            `);

            const productos = await pool.query(`
                SELECT nombre_producto, SUM(cantidad) AS unidades
                FROM detalle_pedido
                GROUP BY nombre_producto
                ORDER BY unidades DESC
                LIMIT 5
            `);

            const porDia = await pool.query(`
                SELECT to_char(creado_en::date, 'YYYY-MM-DD') AS fecha,
                       COUNT(*) AS pedidos,
                       COALESCE(SUM(total), 0) AS total
                FROM pedidos
                WHERE upper(estado) LIKE 'ENTREGADO%'
                  AND creado_en >= CURRENT_DATE - INTERVAL '6 days'
                GROUP BY creado_en::date
                ORDER BY creado_en::date
            `);

            const porEstado = await pool.query(`
                SELECT estado, COUNT(*) AS cantidad
                FROM pedidos
                GROUP BY estado
                ORDER BY cantidad DESC
            `);

            const calificaciones = await pool.query(`
                SELECT COALESCE(AVG(estrellas), 0) AS promedio,
                       COUNT(*)::int AS total
                FROM calificaciones
            `);

            const r = resumen.rows[0];
            const totalQr = parseFloat(r.total_qr || 0);
            const totalEfectivo = parseFloat(r.total_efectivo || 0);
            const totalPagos = totalQr + totalEfectivo;

            const dias = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setUTCDate(d.getUTCDate() - i);
                const key = d.toISOString().slice(0, 10);
                const fila = porDia.rows.find((x) => x.fecha === key);
                dias.push({
                    fecha: key,
                    pedidos: fila ? Number(fila.pedidos) : 0,
                    total: fila ? parseFloat(fila.total) : 0
                });
            }

            res.json({
                pedidos: Number(r.pedidos || 0),
                ventas: parseFloat(r.ventas || 0),
                ticketPromedio: parseFloat(r.ticket_promedio || 0),
                totalQr,
                totalEfectivo,
                pagosDigitalesPct: totalPagos > 0
                    ? Number(((totalQr / totalPagos) * 100).toFixed(1))
                    : 0,
                topProductos: productos.rows.map((p) => ({
                    nombre: p.nombre_producto,
                    unidades: Number(p.unidades || 0)
                })),
                ventasPorDia: dias,
                pedidosPorEstado: porEstado.rows.map((p) => ({
                    estado: p.estado,
                    cantidad: Number(p.cantidad || 0)
                })),
                calificacionPromedio: Number(parseFloat(calificaciones.rows[0].promedio || 0).toFixed(1)),
                calificacionesCount: Number(calificaciones.rows[0].total || 0)
            });
        } catch (err) {
            console.error('Error al obtener tablero:', err);
            res.status(500).json({ error: 'Error al obtener el tablero' });
        }
    });

    // --------------------------------------------------------
    // 12. PRODUCCIÓN SUGERIDA (ML-01 simplificado)
    // --------------------------------------------------------
    const FRANJAS_PRODUCCION = [
        { id: '11-13', label: '11:00 - 13:00', desde: 11, hasta: 12 },
        { id: '13-15', label: '13:00 - 15:00', desde: 13, hasta: 14 },
        { id: '15-17', label: '15:00 - 17:00', desde: 15, hasta: 16 },
        { id: '17-19', label: '17:00 - 19:00', desde: 17, hasta: 18 },
        { id: '19-21', label: '19:00 - 21:00', desde: 19, hasta: 20 },
        { id: '21-23', label: '21:00 - 23:00', desde: 21, hasta: 22 }
    ];
    const DIAS_SEMANA = [
        'Domingo', 'Lunes', 'Martes', 'Miércoles',
        'Jueves', 'Viernes', 'Sábado'
    ];
    const esPolloOCombo = `
        (upper(COALESCE(pr.categoria, '')) LIKE '%POLLO%'
         OR upper(COALESCE(pr.categoria, '')) LIKE '%COMBO%'
         OR lower(d.nombre_producto) LIKE '%pollo%'
         OR lower(d.nombre_producto) LIKE '%combo%')
    `;
    const franjaDeHora = (hora) => {
        const franja = FRANJAS_PRODUCCION.find(
            (f) => Number(hora) >= f.desde && Number(hora) <= f.hasta
        );
        return franja ? franja.id : null;
    };

    async function calcularProduccion(fecha) {
        const info = await pool.query(
            `SELECT EXTRACT(DOW FROM $1::date)::int AS dow`,
            [fecha]
        );
        const dow = info.rows[0].dow;

        const historico = await pool.query(`
            SELECT EXTRACT(HOUR FROM p.creado_en)::int AS hora,
                   SUM(d.cantidad)::int AS unidades
            FROM pedidos p
            JOIN detalle_pedido d ON d.pedido_id = p.id
            LEFT JOIN productos pr ON pr.id = d.producto_id
            WHERE upper(p.estado) LIKE 'ENTREGADO%'
              AND p.creado_en >= CURRENT_DATE - INTERVAL '28 days'
              AND EXTRACT(DOW FROM p.creado_en)::int = $1::int
              AND ${esPolloOCombo}
            GROUP BY 1
        `, [dow]);

        const vendido = await pool.query(`
            SELECT EXTRACT(HOUR FROM p.creado_en)::int AS hora,
                   SUM(d.cantidad)::int AS unidades
            FROM pedidos p
            JOIN detalle_pedido d ON d.pedido_id = p.id
            LEFT JOIN productos pr ON pr.id = d.producto_id
            WHERE p.creado_en::date = $1::date
              AND upper(p.estado) NOT LIKE 'CANCELADO%'
              AND ${esPolloOCombo}
            GROUP BY 1
        `, [fecha]);

        const preparado = await pool.query(
            `SELECT franja, preparado FROM produccion WHERE fecha = $1::date`,
            [fecha]
        );
        const preparadoMap = new Map(
            preparado.rows.map((r) => [r.franja, Number(r.preparado)])
        );

        const historicoPorFranja = new Map();
        for (const row of historico.rows) {
            const franja = franjaDeHora(row.hora);
            if (!franja) continue;
            historicoPorFranja.set(
                franja,
                (historicoPorFranja.get(franja) || 0) + Number(row.unidades || 0)
            );
        }

        const vendidoPorFranja = new Map();
        for (const row of vendido.rows) {
            const franja = franjaDeHora(row.hora);
            if (!franja) continue;
            vendidoPorFranja.set(
                franja,
                (vendidoPorFranja.get(franja) || 0) + Number(row.unidades || 0)
            );
        }

        const franjas = FRANJAS_PRODUCCION.map((f) => {
            const historicoUnidades = historicoPorFranja.get(f.id) || 0;
            const promedioSemanal = historicoUnidades / 4;
            const sugerido = Math.max(0, Math.ceil(promedioSemanal * 1.1));
            const preparadoCantidad = preparadoMap.get(f.id) || 0;
            const vendidoCantidad = vendidoPorFranja.get(f.id) || 0;
            return {
                franja: f.id,
                label: f.label,
                sugerido,
                preparado: preparadoCantidad,
                vendido: vendidoCantidad,
                sobrante: Math.max(0, preparadoCantidad - vendidoCantidad)
            };
        });

        return {
            fecha,
            diaSemana: DIAS_SEMANA[dow] || '',
            franjas,
            totalSugerido: franjas.reduce((a, x) => a + x.sugerido, 0),
            totalPreparado: franjas.reduce((a, x) => a + x.preparado, 0),
            totalVendido: franjas.reduce((a, x) => a + x.vendido, 0),
            totalSobrante: franjas.reduce((a, x) => a + x.sobrante, 0)
        };
    }

    app.get('/api/produccion/sugerida', ...protegerAdmin('cocina', 'dueno'), async (req, res) => {
        const fecha = req.query.fecha ? String(req.query.fecha) : hoyISO();
        if (!esFechaISO(fecha)) {
            return res.status(400).json({ error: 'La fecha debe tener formato YYYY-MM-DD' });
        }
        try {
            res.json(await calcularProduccion(fecha));
        } catch (err) {
            console.error('Error al calcular producción:', err);
            res.status(500).json({ error: 'Error al calcular la producción sugerida' });
        }
    });

    app.post('/api/produccion/preparado', ...protegerAdmin('cocina', 'dueno'), async (req, res) => {
        const { fecha, franja, preparado } = req.body || {};
        const fechaFinal = fecha ? String(fecha) : hoyISO();
        const franjaFinal = String(franja || '');
        const cantidad = Number(preparado);

        if (!esFechaISO(fechaFinal)) {
            return res.status(400).json({ error: 'La fecha debe tener formato YYYY-MM-DD' });
        }
        if (!FRANJAS_PRODUCCION.some((f) => f.id === franjaFinal)) {
            return res.status(400).json({ error: 'La franja horaria no es válida' });
        }
        if (!Number.isInteger(cantidad) || cantidad < 0) {
            return res.status(400).json({ error: 'La cantidad preparada debe ser un entero mayor o igual a 0' });
        }

        try {
            const calculo = await calcularProduccion(fechaFinal);
            const fila = calculo.franjas.find((f) => f.franja === franjaFinal);
            if (!fila) {
                return res.status(400).json({ error: 'No se pudo calcular la franja' });
            }

            const result = await pool.query(`
                INSERT INTO produccion
                    (fecha, franja, sugerido, preparado, vendido, sobrante, actualizado_en)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())
                ON CONFLICT (fecha, franja) DO UPDATE SET
                    sugerido = EXCLUDED.sugerido,
                    preparado = EXCLUDED.preparado,
                    vendido = EXCLUDED.vendido,
                    sobrante = EXCLUDED.sobrante,
                    actualizado_en = NOW()
                RETURNING *
            `, [
                fechaFinal,
                franjaFinal,
                fila.sugerido,
                cantidad,
                fila.vendido,
                Math.max(0, cantidad - fila.vendido)
            ]);

            const row = result.rows[0];
            res.status(201).json({
                ok: true,
                franja: {
                    franja: row.franja,
                    label: FRANJAS_PRODUCCION.find((f) => f.id === row.franja)?.label || row.franja,
                    sugerido: row.sugerido,
                    preparado: row.preparado,
                    vendido: row.vendido,
                    sobrante: row.sobrante
                }
            });
        } catch (err) {
            console.error('Error al guardar producción:', err);
            res.status(500).json({ error: 'Error al guardar la producción preparada' });
        }
    });

    // --------------------------------------------------------
    // 13. COMBOS SUGERIDOS (ML-02 simplificado)
    // --------------------------------------------------------
    app.get('/api/ml/combos', async (req, res) => {
        const raw = String(req.query.productoIds || req.query.productoId || '').trim();
        const ids = raw
            .split(',')
            .map((x) => Number(x))
            .filter((x) => Number.isInteger(x) && x > 0);

        if (!ids.length) return res.json([]);

        try {
            const totalPedidos = await pool.query(`
                SELECT COUNT(DISTINCT pedido_id)::int AS n
                FROM detalle_pedido
                WHERE producto_id IS NOT NULL
            `);
            const n = totalPedidos.rows[0].n || 0;
            if (!n) return res.json([]);

            const totales = await pool.query(`
                SELECT producto_id, COUNT(DISTINCT pedido_id)::int AS total
                FROM detalle_pedido
                WHERE producto_id IS NOT NULL
                GROUP BY producto_id
            `);
            const totalMap = new Map(
                totales.rows.map((r) => [Number(r.producto_id), Number(r.total)])
            );

            const pares = await pool.query(`
                SELECT d1.producto_id AS a,
                       d2.producto_id AS b,
                       COUNT(DISTINCT d1.pedido_id)::int AS juntos
                FROM detalle_pedido d1
                JOIN detalle_pedido d2
                  ON d1.pedido_id = d2.pedido_id
                 AND d1.producto_id <> d2.producto_id
                WHERE d1.producto_id = ANY($1::int[])
                GROUP BY d1.producto_id, d2.producto_id
            `, [ids]);

            const sugerencias = new Map();
            for (const row of pares.rows) {
                const a = Number(row.a);
                const b = Number(row.b);
                const juntos = Number(row.juntos);
                if (ids.includes(b)) continue;

                const totalA = totalMap.get(a) || 0;
                const totalB = totalMap.get(b) || 0;
                if (!totalA || !totalB) continue;

                const confianza = juntos / totalA;
                const lift = (juntos * n) / (totalA * totalB);
                if (confianza < 0.4 || lift <= 1) continue;

                const previa = sugerencias.get(b);
                if (!previa || confianza > previa.confianza) {
                    sugerencias.set(b, { id: b, confianza, lift });
                }
            }

            const top = [...sugerencias.values()]
                .sort((x, y) => y.confianza - x.confianza)
                .slice(0, 5);

            if (!top.length) {
                // Si todavía no hay suficientes pedidos para reglas de
                // asociación, se ofrecen productos populares como respaldo.
                const populares = await pool.query(`
                    SELECT id, nombre, precio, imagen_emoji
                    FROM productos
                    WHERE disponible = TRUE
                      AND id <> ALL($1::int[])
                    ORDER BY en_promocion DESC, id DESC
                    LIMIT 3
                `, [ids]);
                return res.json(populares.rows.map((p) => ({
                    id: Number(p.id),
                    nombre: p.nombre,
                    precio: parseFloat(p.precio),
                    imagenEmoji: p.imagen_emoji || '🍗',
                    confianza: 0,
                    lift: 0
                })));
            }

            const productos = await pool.query(`
                SELECT id, nombre, precio, imagen_emoji
                FROM productos
                WHERE id = ANY($1::int[]) AND disponible = TRUE
            `, [top.map((x) => x.id)]);
            const productoMap = new Map(
                productos.rows.map((p) => [Number(p.id), p])
            );

            res.json(
                top
                    .map((x) => {
                        const p = productoMap.get(x.id);
                        return {
                            id: x.id,
                            nombre: p ? p.nombre : '',
                            precio: p ? parseFloat(p.precio) : 0,
                            imagenEmoji: p ? (p.imagen_emoji || '🍗') : '🍗',
                            confianza: Number((x.confianza * 100).toFixed(1)),
                            lift: Number(x.lift.toFixed(2))
                        };
                    })
                    .filter((x) => x.nombre)
            );
        } catch (err) {
            console.error('Error al calcular combos:', err);
            res.status(500).json({ error: 'Error al calcular los combos sugeridos' });
        }
    });

    // --------------------------------------------------------
    // 13.1 METRICAS DEL MODELO PREDICTIVO DE ETA
    // --------------------------------------------------------
    app.get('/api/ml/eta/modelo', (_req, res) => {
        try {
            res.json(obtenerMetricasEta());
        } catch (err) {
            console.error('Error al leer el modelo de ETA:', err);
            res.status(500).json({ error: 'El modelo predictivo no está disponible' });
        }
    });

    // --------------------------------------------------------
    // 14. CALIFICACIONES DEL PEDIDO
    // --------------------------------------------------------
    function mapCalificacion(r) {
        return {
            id: r.id,
            pedidoId: r.pedido_id,
            estrellas: r.estrellas,
            comentario: r.comentario || '',
            creadoEn: r.creado_en || null
        };
    }

    async function pedidoDelCliente(id, req) {
        const result = await pool.query(`
            SELECT p.id, p.estado, p.usuario_id, u.correo AS cliente_correo
            FROM pedidos p
            LEFT JOIN usuarios u ON u.id = p.usuario_id
            WHERE p.id = $1
            LIMIT 1
        `, [id]);
        if (!result.rowCount) return { error: 'Pedido no encontrado', status: 404 };

        const pedido = result.rows[0];
        if (grupoRol(req.usuario.rol) === 'cliente') {
            const correoPedido = String(pedido.cliente_correo || '').toLowerCase();
            const correoSesion = String(req.usuario.correo || '').toLowerCase();
            if (!correoPedido || correoPedido !== correoSesion) {
                return { error: 'No tienes permisos sobre este pedido', status: 403 };
            }
        }
        return { pedido };
    }

    app.get('/api/pedidos/:id/calificacion', ...proteger('cliente', 'admin', 'repartidor'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pedido no es válido' });
        }
        try {
            const permiso = await pedidoDelCliente(id, req);
            if (permiso.error) {
                return res.status(permiso.status).json({ error: permiso.error });
            }
            const result = await pool.query(
                `SELECT * FROM calificaciones WHERE pedido_id = $1 LIMIT 1`,
                [id]
            );
            if (!result.rowCount) return res.json(null);
            res.json(mapCalificacion(result.rows[0]));
        } catch (err) {
            console.error('Error al consultar calificación:', err);
            res.status(500).json({ error: 'Error al consultar la calificación' });
        }
    });

    app.post('/api/pedidos/:id/calificar', ...proteger('cliente'), async (req, res) => {
        const id = Number(req.params.id);
        const { estrellas, comentario } = req.body || {};
        const valor = Number(estrellas);

        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pedido no es válido' });
        }
        if (!Number.isInteger(valor) || valor < 1 || valor > 5) {
            return res.status(400).json({ error: 'La calificación debe estar entre 1 y 5 estrellas' });
        }
        const texto = String(comentario || '').trim();
        if (texto.length > 500) {
            return res.status(400).json({ error: 'El comentario es demasiado largo' });
        }

        try {
            const permiso = await pedidoDelCliente(id, req);
            if (permiso.error) {
                return res.status(permiso.status).json({ error: permiso.error });
            }
            if (!String(permiso.pedido.estado || '').toUpperCase().startsWith('ENTREGADO')) {
                return res.status(400).json({ error: 'Solo puedes calificar un pedido entregado' });
            }

            const result = await pool.query(`
                INSERT INTO calificaciones
                    (pedido_id, usuario_id, estrellas, comentario, creado_en)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (pedido_id) DO UPDATE SET
                    estrellas = EXCLUDED.estrellas,
                    comentario = EXCLUDED.comentario,
                    creado_en = NOW()
                RETURNING *
            `, [id, permiso.pedido.usuario_id, valor, texto]);

            res.status(201).json(mapCalificacion(result.rows[0]));
        } catch (err) {
            console.error('Error al calificar pedido:', err);
            res.status(500).json({ error: 'Error al guardar la calificación' });
        }
    });

    app.get('/api/calificaciones/resumen', ...protegerAdmin('dueno'), async (_req, res) => {
        try {
            const resumen = await pool.query(`
                SELECT COALESCE(AVG(estrellas), 0) AS promedio,
                       COUNT(*)::int AS total
                FROM calificaciones
            `);
            const recientes = await pool.query(`
                SELECT c.*, p.numero_orden
                FROM calificaciones c
                JOIN pedidos p ON p.id = c.pedido_id
                ORDER BY c.creado_en DESC
                LIMIT 10
            `);
            res.json({
                promedio: Number(parseFloat(resumen.rows[0].promedio || 0).toFixed(1)),
                total: Number(resumen.rows[0].total || 0),
                recientes: recientes.rows.map((r) => ({
                    ...mapCalificacion(r),
                    numeroOrden: r.numero_orden
                }))
            });
        } catch (err) {
            console.error('Error al obtener resumen de calificaciones:', err);
            res.status(500).json({ error: 'Error al obtener las calificaciones' });
        }
    });

    // --------------------------------------------------------
    // 15. ETA DEL PEDIDO (ML-03 simplificado)
    // --------------------------------------------------------
    function distanciaKm(lat1, lon1, lat2, lon2) {
        const radio = 6371;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) *
                Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) *
                Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return Number((radio * c).toFixed(2));
    }

    app.get('/api/pedidos/:id/eta', ...proteger('cliente', 'admin', 'repartidor'), async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
            return res.status(400).json({ error: 'El pedido no es válido' });
        }

        try {
            const result = await pool.query(`
                SELECT p.id, p.tipo_entrega, p.tienda_id, p.total, p.creado_en,
                       p.latitud_entrega, p.longitud_entrega,
                       t.nombre AS tienda_nombre,
                       t.latitud AS tienda_latitud,
                       t.longitud AS tienda_longitud,
                       u.correo AS cliente_correo
                FROM pedidos p
                LEFT JOIN tiendas t ON t.id = p.tienda_id
                LEFT JOIN usuarios u ON u.id = p.usuario_id
                WHERE p.id = $1
                LIMIT 1
            `, [id]);

            if (!result.rowCount) {
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }

            const pedido = result.rows[0];
            if (authActiva && req.usuario && grupoRol(req.usuario.rol) === 'cliente') {
                const dueno = String(pedido.cliente_correo || '').toLowerCase();
                if (dueno !== String(req.usuario.correo || '').toLowerCase()) {
                    return res.status(404).json({ error: 'Pedido no encontrado' });
                }
            }

            const tipoEntrega = String(pedido.tipo_entrega || 'RECOJO').toUpperCase();
            const origenLat = pedido.tienda_latitud === null
                ? -6.7714000
                : parseFloat(pedido.tienda_latitud);
            const origenLng = pedido.tienda_longitud === null
                ? -79.8409000
                : parseFloat(pedido.tienda_longitud);
            const destinoLat = pedido.latitud_entrega === null
                ? null
                : parseFloat(pedido.latitud_entrega);
            const destinoLng = pedido.longitud_entrega === null
                ? null
                : parseFloat(pedido.longitud_entrega);

            const enCocina = await pool.query(`
                SELECT COUNT(*)::int AS n
                FROM pedidos
                WHERE upper(estado) IN ('EN_COCINA', 'LISTO')
                  AND ($1::int IS NULL OR tienda_id = $1::int)
            `, [pedido.tienda_id]);

            const repartidores = await pool.query(`
                SELECT COUNT(*)::int AS n
                FROM repartidores
                WHERE turno_activo = TRUE
            `);

            let distancia = 0;
            if (tipoEntrega === 'DELIVERY' && destinoLat !== null && destinoLng !== null) {
                distancia = distanciaKm(origenLat, origenLng, destinoLat, destinoLng);
            } else if (tipoEntrega === 'DELIVERY') {
                distancia = 5;
            }

            const cargaCocina = Number(enCocina.rows[0].n || 0);
            const disponibles = Number(repartidores.rows[0].n || 0);
            const items = await pool.query(`
                SELECT COALESCE(SUM(cantidad), 0)::int AS unidades
                FROM detalle_pedido
                WHERE pedido_id = $1
            `, [id]);
            const cantidadItems = Number(items.rows[0].unidades || 0);

            const fechaPedido = pedido.creado_en ? new Date(pedido.creado_en) : new Date();
            const fechaValida = !Number.isNaN(fechaPedido.getTime());
            const hora = fechaValida ? fechaPedido.getHours() : new Date().getHours();
            const diaSemana = fechaValida ? fechaPedido.getDay() : new Date().getDay();
            const esDelivery = tipoEntrega === 'DELIVERY';

            const prediccion = predecirEta({
                distancia_km: distancia,
                carga_cocina: cargaCocina,
                repartidores_disponibles: disponibles,
                hora_sin: hora,
                dia_semana: diaSemana,
                es_fin_semana: diaSemana === 0 || diaSemana === 6 ? 1 : 0,
                cantidad_items: cantidadItems,
                total: Number(pedido.total || 0),
                es_delivery: esDelivery ? 1 : 0
            });

            // Respaldo: fórmula anterior si el modelo no está disponible.
            let etaHeuristico = esDelivery
                ? 10 + (distancia / 22) * 60 + cargaCocina * 2 - disponibles * 1.5
                : 10 + cargaCocina * 2;
            etaHeuristico = Math.max(10, Math.min(90, Math.round(etaHeuristico)));

            const etaMinutos = prediccion ? prediccion.etaMinutos : etaHeuristico;
            const margen = Math.max(3, Math.round(etaMinutos * 0.15));
            const etaMinimo = prediccion ? prediccion.etaMinimo : Math.max(8, etaMinutos - margen);
            const etaMaximo = prediccion ? prediccion.etaMaximo : Math.min(120, etaMinutos + margen);

            // Se guarda la última predicción para comparar ETA vs. tiempo real
            // en Power BI. Si la migración 011 aún no se aplicó, se ignora.
            try {
                await pool.query(`
                    INSERT INTO eta_predicciones
                        (pedido_id, eta_minutos, eta_minimo, eta_maximo, modelo,
                         distancia_km, carga_cocina, repartidores_disponibles,
                         hora_sin, dia_semana, cantidad_items, total, actualizado_en)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
                    ON CONFLICT (pedido_id) DO UPDATE SET
                        eta_minutos = EXCLUDED.eta_minutos,
                        eta_minimo = EXCLUDED.eta_minimo,
                        eta_maximo = EXCLUDED.eta_maximo,
                        modelo = EXCLUDED.modelo,
                        distancia_km = EXCLUDED.distancia_km,
                        carga_cocina = EXCLUDED.carga_cocina,
                        repartidores_disponibles = EXCLUDED.repartidores_disponibles,
                        hora_sin = EXCLUDED.hora_sin,
                        dia_semana = EXCLUDED.dia_semana,
                        cantidad_items = EXCLUDED.cantidad_items,
                        total = EXCLUDED.total,
                        actualizado_en = NOW()
                `, [
                    id,
                    etaMinutos,
                    etaMinimo,
                    etaMaximo,
                    prediccion ? prediccion.modelo : 'heuristico_v1',
                    distancia,
                    cargaCocina,
                    disponibles,
                    hora,
                    diaSemana,
                    cantidadItems,
                    Number(pedido.total || 0)
                ]);
            } catch (_) {
                // La tabla es opcional para no bloquear el ETA.
            }

            res.json({
                pedidoId: id,
                tipoEntrega,
                etaMinutos,
                etaMinimo,
                etaMaximo,
                modelo: prediccion ? prediccion.modelo : 'heuristico_v1',
                desviacionMinutos: prediccion ? prediccion.desviacionMinutos : null,
                distanciaKm: distancia,
                origen: {
                    nombre: pedido.tienda_nombre || 'Tienda Crocanti',
                    latitud: origenLat,
                    longitud: origenLng
                },
                destino: destinoLat !== null && destinoLng !== null
                    ? { latitud: destinoLat, longitud: destinoLng }
                    : null
            });
        } catch (err) {
            console.error('Error al calcular ETA:', err);
            res.status(500).json({ error: 'Error al calcular el tiempo estimado' });
        }
    });

    return app;
}

module.exports = { crearApp };
