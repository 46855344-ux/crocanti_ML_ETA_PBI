'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    estaConfigurado,
    construirUrl,
    subirFoto
} = require('../almacenamiento');

const CLAVES = [
    'AWS_ENDPOINT_URL_S3',
    'AWS_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'S3_BUCKET',
    'S3_PUBLIC_BASE_URL'
];

function limpiar() {
    for (const clave of CLAVES) delete process.env[clave];
}

test('Object Storage no está configurado sin bucket ni credenciales', () => {
    limpiar();
    assert.equal(estaConfigurado(), false);
});

test('Object Storage se configura con bucket, endpoint y credenciales', () => {
    limpiar();
    process.env.S3_BUCKET = 'crocanti-entregas';
    process.env.AWS_ENDPOINT_URL_S3 = 'https://ep-test.storage.c-7.us-east-2.aws.neon.tech';
    process.env.AWS_ACCESS_KEY_ID = 'access';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';

    assert.equal(estaConfigurado(), true);
    assert.equal(
        construirUrl('entregas/8/foto.jpg'),
        'https://ep-test.storage.c-7.us-east-2.aws.neon.tech/crocanti-entregas/entregas/8/foto.jpg'
    );
});

test('S3_PUBLIC_BASE_URL reemplaza la URL construida', () => {
    limpiar();
    process.env.S3_BUCKET = 'crocanti-entregas';
    process.env.AWS_ENDPOINT_URL_S3 = 'https://ep-test.storage.c-7.us-east-2.aws.neon.tech';
    process.env.AWS_ACCESS_KEY_ID = 'access';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret';
    process.env.S3_PUBLIC_BASE_URL = 'https://cdn.example.com/fotos/';

    assert.equal(
        construirUrl('entregas/8/foto.jpg'),
        'https://cdn.example.com/fotos/entregas/8/foto.jpg'
    );
});

test('subirFoto falla claro cuando Object Storage no está configurado', async () => {
    limpiar();
    await assert.rejects(
        () => subirFoto(Buffer.from('foto'), 8),
        /Object Storage no está configurado/
    );
});
