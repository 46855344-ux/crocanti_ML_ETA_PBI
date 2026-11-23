'use strict';

const { Pool } = require('pg');
require('dotenv').config();

const { crearApp } = require('./app');
const { estaConfigurado: almacenamientoConfigurado } = require('./almacenamiento');

// ============================================================
// CONEXIÓN A NEON (PostgreSQL)
// ============================================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Requerido por Neon para conexiones SSL
    }
});

// Neon puede cerrar conexiones inactivas; sin este manejador el proceso
// se cae con "Unhandled 'error' event" y deja de responder a las apps.
pool.on('error', (err) => {
    console.error('⚠️  Conexión inactiva del pool de Neon cerrada:', err.message);
});

pool.connect((err, client, release) => {
    if (err) {
        return console.error('❌ Error al conectar a la base de datos Neon:', err.stack);
    }
    console.log('✅ Conectado exitosamente a la base de datos Neon (PostgreSQL)');
    release();
});

const app = crearApp(pool);

if (almacenamientoConfigurado()) {
    console.log('✅ Object Storage configurado: las fotos de entrega se guardarán en S3.');
} else {
    console.warn(
        '⚠️  Object Storage no configurado (falta S3_BUCKET o AWS_*): ' +
        'las fotos se guardarán en uploads/ y se perderán al reiniciar Render.'
    );
}

const PORT = process.env.PORT || 3000;
// Sin host explicito Node escucha en '::' (dual-stack IPv4/IPv6),
// necesario para que `adb reverse` funcione tambien por localhost.
app.listen(PORT, () => {
    console.log(`🚀 Servidor Backend corriendo en http://localhost:${PORT}`);
});
