-- ============================================================
-- 007 · CALIFICACIONES DEL PEDIDO
-- ============================================================

CREATE TABLE IF NOT EXISTS calificaciones (
    id          SERIAL PRIMARY KEY,
    pedido_id   INTEGER NOT NULL UNIQUE REFERENCES pedidos(id) ON DELETE CASCADE,
    usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
    estrellas   INTEGER NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
    comentario  TEXT NOT NULL DEFAULT '',
    creado_en   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_calificaciones_creado
    ON calificaciones (creado_en DESC);
