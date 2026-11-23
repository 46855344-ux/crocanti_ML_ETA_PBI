'use strict';

// ============================================================
// PRUEBA DE NEON OBJECT STORAGE
// ------------------------------------------------------------
// Uso: npm run probar-s3
// Requiere AWS_* y S3_BUCKET en .env.
// ============================================================

const {
    S3Client,
    ListBucketsCommand,
    PutObjectCommand,
    DeleteObjectCommand
} = require('@aws-sdk/client-s3');
const {
    configuracion,
    estaConfigurado,
    construirUrl
} = require('../almacenamiento');

async function main() {
    const c = configuracion();

    if (!c.endpoint || !c.accessKeyId || !c.secretAccessKey) {
        throw new Error(
            'Faltan AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID o AWS_SECRET_ACCESS_KEY en .env'
        );
    }

    const s3 = new S3Client({
        region: c.region,
        endpoint: c.endpoint,
        credentials: {
            accessKeyId: c.accessKeyId,
            secretAccessKey: c.secretAccessKey
        },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED'
    });

    console.log('Endpoint:', c.endpoint);
    console.log('Región:', c.region);

    const buckets = await s3.send(new ListBucketsCommand({}));
    const nombres = (buckets.Buckets || []).map((b) => b.Name);
    console.log('Buckets disponibles:', nombres.length ? nombres.join(', ') : '(ninguno)');

    if (!estaConfigurado()) {
        console.log(
            '\n⚠️  Define S3_BUCKET en .env para probar la subida. ' +
            'Ejemplo: S3_BUCKET=crocanti-entregas'
        );
        return;
    }

    if (!nombres.includes(c.bucket)) {
        console.log(
            `\n⚠️  El bucket "${c.bucket}" no aparece en la lista. ` +
            'Créalo en Neon Console o con: neon buckets create ' + c.bucket
        );
        return;
    }

    const key = `pruebas/s3-test-${Date.now()}.txt`;
    const contenido = 'Prueba de Crocanti Object Storage';

    await s3.send(new PutObjectCommand({
        Bucket: c.bucket,
        Key: key,
        Body: contenido,
        ContentType: 'text/plain'
    }));

    const url = construirUrl(key);
    console.log('\n✅ Archivo subido:', key);
    console.log('URL pública:', url);

    try {
        const respuesta = await fetch(url, { method: 'HEAD' });
        console.log(
            `Lectura pública: HTTP ${respuesta.status} ` +
            (respuesta.ok
                ? '(bucket public_read)'
                : '(bucket privado: usa S3_PUBLIC_BASE_URL o un endpoint firmado)')
        );
    } catch (error) {
        console.log('No se pudo comprobar la lectura pública:', error.message);
    }

    await s3.send(new DeleteObjectCommand({
        Bucket: c.bucket,
        Key: key
    }));
    console.log('🧹 Archivo de prueba eliminado.');
}

main().catch((error) => {
    console.error('\n❌ Error de Object Storage:', error.name || '', error.message);
    if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied/i.test(error.name || error.message)) {
        console.error(
            'La credencial S3 no es válida. Genera una nueva en Neon ' +
            '(storage:read + storage:write) y actualiza AWS_ACCESS_KEY_ID y ' +
            'AWS_SECRET_ACCESS_KEY.'
        );
    }
    process.exitCode = 1;
});
