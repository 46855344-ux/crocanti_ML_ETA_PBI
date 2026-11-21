'use strict';

// ============================================================
// SEGURIDAD · CROCANTI
// ------------------------------------------------------------
// Contraseñas con bcrypt, sesiones con JWT y control de roles.
// El token se envía en la cabecera: Authorization: Bearer <token>
// ============================================================

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const RONDAS_BCRYPT = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'crocanti-clave-de-desarrollo-cambiar';
const JWT_EXPIRA = process.env.JWT_EXPIRA || '30d';

if (!process.env.JWT_SECRET) {
    console.warn(
        '⚠️  JWT_SECRET no está definido: se usa la clave de desarrollo. ' +
        'Configura una clave segura en producción.'
    );
}

function normalizarRol(rol) {
    return String(rol || '').trim().toLowerCase();
}

/**
 * Agrupa los roles históricos en tres perfiles para autorizar rutas.
 */
function grupoRol(rol) {
    const r = normalizarRol(rol);
    if (['admin', 'administrador', 'dueno', 'dueño', 'cajero', 'cocina'].includes(r)) {
        return 'admin';
    }
    if (['repartidor', 'delivery'].includes(r)) {
        return 'repartidor';
    }
    return 'cliente';
}

function esHashBcrypt(valor) {
    return typeof valor === 'string' && /^\$2[aby]\$\d{2}\$/.test(valor);
}

async function hashearClave(clave) {
    return bcrypt.hash(String(clave), RONDAS_BCRYPT);
}

/**
 * Compara una clave en texto plano contra el valor almacenado.
 * Acepta hashes bcrypt y, temporalmente, claves antiguas en texto plano
 * para poder migrarlas en el primer inicio de sesión.
 */
async function verificarClave(clave, almacenada) {
    if (!almacenada) return false;
    if (esHashBcrypt(almacenada)) {
        return bcrypt.compare(String(clave), almacenada);
    }
    return String(clave) === String(almacenada);
}

function firmarToken(usuario) {
    return jwt.sign(
        {
            sub: usuario.id,
            correo: usuario.correo,
            nombre: usuario.nombre,
            rol: normalizarRol(usuario.rol)
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRA }
    );
}

function verificarToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (_) {
        return null;
    }
}

function extraerToken(req) {
    const cabecera = req.headers.authorization || '';
    const partes = cabecera.split(' ');
    if (partes.length === 2 && /^Bearer$/i.test(partes[0])) {
        return partes[1].trim();
    }
    return null;
}

/**
 * Middleware: exige un JWT válido y deja los datos en req.usuario.
 */
function autenticar(req, res, next) {
    const token = extraerToken(req);
    if (!token) {
        return res.status(401).json({ error: 'Falta el token de sesión' });
    }

    const datos = verificarToken(token);
    if (!datos) {
        return res.status(401).json({ error: 'Sesión expirada o token inválido' });
    }

    req.usuario = {
        id: Number(datos.sub),
        correo: datos.correo,
        nombre: datos.nombre,
        rol: normalizarRol(datos.rol)
    };
    return next();
}

/**
 * Middleware: autoriza solo a los grupos indicados.
 * Uso: requiereRol('admin') o requiereRol('admin', 'repartidor').
 */
function requiereRol(...roles) {
    const permitidos = new Set();
    for (const rol of roles.flat()) {
        permitidos.add(normalizarRol(rol));
        permitidos.add(grupoRol(rol));
    }

    return (req, res, next) => {
        if (!req.usuario) {
            return res.status(401).json({ error: 'Debes iniciar sesión' });
        }
        const grupo = grupoRol(req.usuario.rol);
        if (permitidos.has(grupo) || permitidos.has(req.usuario.rol)) {
            return next();
        }
        return res.status(403).json({ error: 'No tienes permisos para esta acción' });
    };
}

/**
 * Devuelve la lista de middlewares de una ruta.
 * Cuando auth está desactivada (pruebas unitarias), no agrega nada.
 */
function crearProteccion(authActiva) {
    return (...roles) => (authActiva ? [autenticar, requiereRol(...roles)] : []);
}

module.exports = {
    JWT_SECRET,
    JWT_EXPIRA,
    normalizarRol,
    grupoRol,
    esHashBcrypt,
    hashearClave,
    verificarClave,
    firmarToken,
    verificarToken,
    autenticar,
    requiereRol,
    crearProteccion
};
