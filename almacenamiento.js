'use strict';

// ============================================================
// ALMACENAMIENTO DE FOTOS
// ------------------------------------------------------------
// Usa Neon Object Storage (S3 compatible) cuando están definidas
// las variables AWS_* y S3_BUCKET. Si no está configurado,
// app.js conserva el respaldo local en uploads/.
// ============================================================

const crypto = require('crypto');
const {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand
} = require('@aws-sdk/client-s3');

function configuracion() {
    return {
        bucket: process.env.S3_BUCKET || process.env.AWS_S3_BUCKET || '',
        endpoint: process.env.AWS_ENDPOINT_URL_S3 || '',
        region: process.env.AWS_REGION || 'us-east-2',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
        publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || ''
    };
}

function estaConfigurado() {
    const c = configuracion();
    return Boolean(
        c.bucket &&
        c.endpoint &&
        c.accessKeyId &&
        c.secretAccessKey
    );
}

let cliente = null;

function obtenerCliente() {
    if (cliente) return cliente;
    if (!estaConfigurado()) return null;

    const c = configuracion();
    cliente = new S3Client({
        region: c.region,
        endpoint: c.endpoint,
        credentials: {
            accessKeyId: c.accessKeyId,
            secretAccessKey: c.secretAccessKey
        },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED'
    });
    return cliente;
}

function extensionDe(contentType) {
    if (/png/i.test(contentType)) return 'png';
    if (/webp/i.test(contentType)) return 'webp';
    return 'jpg';
}

/**
 * URL pública del objeto. Para Neon Object Storage el bucket debe
 * haberse creado como public_read. Si se usa un CDN o dominio propio,
 * definir S3_PUBLIC_BASE_URL.
 */
function construirUrl(key) {
    const c = configuracion();
    const base = (c.publicBaseUrl || `${c.endpoint}/${c.bucket}`)
        .replace(/\/+$/, '');
    return `${base}/${String(key).split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Sube una foto y devuelve { key, url }.
 * Lanza un error si Object Storage no está configurado o si falla la subida;
 * el llamador decide si usa el respaldo local.
 */
async function subirFoto(buffer, pedidoId, contentType = 'image/jpeg') {
    const s3 = obtenerCliente();
    if (!s3) {
        throw new Error('Object Storage no está configurado (falta S3_BUCKET o AWS_*)');
    }

    const c = configuracion();
    const extension = extensionDe(contentType);
    const key = `entregas/${pedidoId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`;

    await s3.send(new PutObjectCommand({
        Bucket: c.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
    }));

    return { key, url: construirUrl(key) };
}

async function eliminarFoto(key) {
    const s3 = obtenerCliente();
    if (!s3 || !key) return false;

    const c = configuracion();
    await s3.send(new DeleteObjectCommand({
        Bucket: c.bucket,
        Key: key
    }));
    return true;
}

module.exports = {
    configuracion,
    estaConfigurado,
    construirUrl,
    subirFoto,
    eliminarFoto
};
