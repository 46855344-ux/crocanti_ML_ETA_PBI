-- ============================================================
-- 003 · REPARTIDOR, PAGOS, COCINA Y ENTREGAS · CROCANTI · NEON
-- ------------------------------------------------------------
-- Ejecutar después de 001 y 002.
-- Es idempotente: puede ejecutarse varias veces.
-- ============================================================

-- ------------------------------------------------------------
-- 0) DATOS DE CONTACTO DEL USUARIO
-- ------------------------------------------------------------
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefono TEXT;

-- ------------------------------------------------------------
-- 1) PEDIDOS: DELIVERY, REPARTIDOR Y UBICACIÓN
-- ------------------------------------------------------------
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tipo_entrega TEXT NOT NULL DEFAULT 'RECOJO';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS repartidor_id INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_delivery NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS telefono_entrega TEXT NOT NULL DEFAULT '';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS latitud_entrega NUMERIC(10,7);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS longitud_entrega NUMERIC(10,7);

-- Los pedidos históricos con dirección se consideran delivery.
UPDATE pedidos
SET tipo_entrega = 'DELIVERY'
WHERE tipo_entrega = 'RECOJO'
  AND trim(direccion_entrega) <> '';

CREATE INDEX IF NOT EXISTS ix_pedidos_repartidor_id ON pedidos (repartidor_id);
CREATE INDEX IF NOT EXISTS ix_pedidos_estado ON pedidos (estado);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_pedidos_repartidor'
          AND conrelid = 'pedidos'::regclass
    ) THEN
        ALTER TABLE pedidos
            ADD CONSTRAINT fk_pedidos_repartidor
            FOREIGN KEY (repartidor_id) REFERENCES usuarios(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ------------------------------------------------------------
-- 2) REPARTIDORES: TURNO Y ÚLTIMA UBICACIÓN
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repartidores (
    id              SERIAL PRIMARY KEY,
    usuario_id      INTEGER NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
    turno_activo    BOOLEAN NOT NULL DEFAULT FALSE,
    disponible      BOOLEAN NOT NULL DEFAULT TRUE,
    latitud         NUMERIC(10,7),
    longitud        NUMERIC(10,7),
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_repartidores_turno ON repartidores (turno_activo);

CREATE TABLE IF NOT EXISTS ubicaciones_repartidor (
    id             BIGSERIAL PRIMARY KEY,
    repartidor_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    latitud        NUMERIC(10,7) NOT NULL,
    longitud       NUMERIC(10,7) NOT NULL,
    fecha_hora     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_ubicaciones_repartidor
    ON ubicaciones_repartidor (repartidor_id, fecha_hora DESC);

-- ------------------------------------------------------------
-- 3) PAGOS (QR SIMULADO DEL NÚCLEO BANCO ANDINO)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pagos (
    id                    SERIAL PRIMARY KEY,
    uuid_operation        TEXT NOT NULL UNIQUE,
    pedido_id             INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    medio                 TEXT NOT NULL DEFAULT 'QR',
    monto                 NUMERIC(10,2) NOT NULL CHECK (monto >= 0),
    referencia            TEXT NOT NULL UNIQUE,
    nro_operacion_banco   TEXT,
    estado                TEXT NOT NULL DEFAULT 'PENDIENTE',
    expira_en             TIMESTAMPTZ,
    confirmado_en         TIMESTAMPTZ,
    creado_en             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_pagos_pedido ON pagos (pedido_id, creado_en DESC);

-- ------------------------------------------------------------
-- 4) EVENTOS DEL PEDIDO (LÍNEA DE TIEMPO)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eventos_pedido (
    id             BIGSERIAL PRIMARY KEY,
    uuid_operation TEXT NOT NULL UNIQUE,
    pedido_id      INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    estado         TEXT NOT NULL,
    fecha_hora     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    usuario_id     INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    nota           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS ix_eventos_pedido
    ON eventos_pedido (pedido_id, fecha_hora ASC);

-- ------------------------------------------------------------
-- 5) EVIDENCIA DE ENTREGA
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entregas (
    id            SERIAL PRIMARY KEY,
    pedido_id     INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
    foto_url      TEXT NOT NULL,
    latitud       NUMERIC(10,7),
    longitud      NUMERIC(10,7),
    fecha_hora    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ------------------------------------------------------------
-- 6) USUARIO DEMO DE REPARTIDOR
-- ------------------------------------------------------------
INSERT INTO usuarios (nombre, correo, clave, rol, telefono)
VALUES ('Repartidor Demo', 'repartidor@crocanti.pe', 'repartidor123', 'repartidor', '999888777')
ON CONFLICT (correo) DO UPDATE SET
    rol = 'repartidor',
    telefono = COALESCE(usuarios.telefono, EXCLUDED.telefono);

INSERT INTO repartidores (usuario_id, turno_activo, disponible)
SELECT id, FALSE, TRUE FROM usuarios WHERE correo = 'repartidor@crocanti.pe'
ON CONFLICT (usuario_id) DO NOTHING;

-- ------------------------------------------------------------
-- 7) VERIFICACIÓN
-- ------------------------------------------------------------
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('repartidores', 'ubicaciones_repartidor', 'pagos', 'eventos_pedido', 'entregas')
ORDER BY table_name;
