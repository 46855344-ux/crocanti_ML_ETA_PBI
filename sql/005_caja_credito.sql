-- ============================================================
-- 005 · CIERRE DE CAJA Y SOLICITUDES DE CRÉDITO
-- Caso Crocanti Chicken · integración con Banco Andino (simulada)
-- ============================================================

-- Fecha real de creación del pedido (la columna `fecha` es texto y
-- puede venir como dd/MM/yyyy HH:mm o ISO). Se usa para caja y tablero.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS creado_en TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE pedidos
SET creado_en = CASE
    WHEN fecha ~ '^\d{2}/\d{2}/\d{4}' THEN to_timestamp(fecha, 'DD/MM/YYYY HH24:MI')
    WHEN fecha ~ '^\d{4}-\d{2}-\d{2}' THEN fecha::timestamptz
    ELSE creado_en
END
WHERE fecha <> '';

CREATE TABLE IF NOT EXISTS cierres_caja (
    id                SERIAL PRIMARY KEY,
    fecha             DATE NOT NULL UNIQUE,
    total_ventas      NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_entregado   NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_efectivo    NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_qr          NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_abonos      NUMERIC(10,2) NOT NULL DEFAULT 0,
    diferencia        NUMERIC(10,2) NOT NULL DEFAULT 0,
    estado            TEXT NOT NULL DEFAULT 'CERRADO',
    justificacion     TEXT,
    usuario_id        INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    creado_en         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cerrado_en        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_cierres_caja_fecha
    ON cierres_caja (fecha DESC);

CREATE TABLE IF NOT EXISTS solicitudes_credito (
    id                 SERIAL PRIMARY KEY,
    usuario_id         INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    monto_solicitado   NUMERIC(10,2) NOT NULL CHECK (monto_solicitado > 0),
    ventas_ultimo_mes  NUMERIC(10,2) NOT NULL DEFAULT 0,
    autoriza_compartir BOOLEAN NOT NULL DEFAULT FALSE,
    estado             TEXT NOT NULL DEFAULT 'ENVIADO',
    observacion        TEXT,
    creado_en          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_solicitudes_credito_creado
    ON solicitudes_credito (creado_en DESC);
