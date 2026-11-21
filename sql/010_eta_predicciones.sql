-- ============================================================
-- 010 · PREDICCIONES DE ETA
-- ------------------------------------------------------------
-- Guarda la última predicción de ETA por pedido, junto con las
-- variables usadas por el modelo, para comparar ETA vs. tiempo
-- real y reentrenar con datos reales en el futuro.
-- ============================================================

CREATE TABLE IF NOT EXISTS eta_predicciones (
    pedido_id                 INTEGER PRIMARY KEY REFERENCES pedidos(id) ON DELETE CASCADE,
    eta_minutos               INTEGER NOT NULL,
    eta_minimo                INTEGER,
    eta_maximo                INTEGER,
    modelo                    TEXT NOT NULL DEFAULT 'eta_rf_v1',
    distancia_km              NUMERIC(10,2),
    carga_cocina              INTEGER,
    repartidores_disponibles  INTEGER,
    hora_sin                  INTEGER,
    dia_semana                INTEGER,
    cantidad_items            INTEGER,
    total                     NUMERIC(10,2),
    creado_en                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actualizado_en            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_eta_predicciones_modelo
    ON eta_predicciones (modelo, actualizado_en DESC);

-- Verificación
SELECT count(*) AS predicciones_guardadas FROM eta_predicciones;
