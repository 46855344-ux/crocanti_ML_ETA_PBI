-- ============================================================
-- 006 · PRODUCCIÓN SUGERIDA (ML-01 simplificado)
-- ============================================================

CREATE TABLE IF NOT EXISTS produccion (
    id             SERIAL PRIMARY KEY,
    fecha          DATE NOT NULL,
    franja         TEXT NOT NULL,
    sugerido       INTEGER NOT NULL DEFAULT 0,
    preparado      INTEGER NOT NULL DEFAULT 0,
    vendido        INTEGER NOT NULL DEFAULT 0,
    sobrante       INTEGER NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (fecha, franja)
);

CREATE INDEX IF NOT EXISTS ix_produccion_fecha
    ON produccion (fecha DESC);
