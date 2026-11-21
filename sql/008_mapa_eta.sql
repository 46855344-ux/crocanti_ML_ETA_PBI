-- ============================================================
-- 008 · COORDENADAS DE TIENDAS + ETA (ML-03 simplificado)
-- ============================================================

ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS latitud NUMERIC(10,7);
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS longitud NUMERIC(10,7);

UPDATE tiendas
SET latitud = -6.7714000, longitud = -79.8409000
WHERE lower(nombre) LIKE '%centro%'
  AND (latitud IS NULL OR longitud IS NULL);

UPDATE tiendas
SET latitud = -6.7500000, longitud = -79.8400000
WHERE lower(nombre) LIKE '%norte%'
  AND (latitud IS NULL OR longitud IS NULL);

UPDATE tiendas
SET latitud = -6.7900000, longitud = -79.8400000
WHERE lower(nombre) LIKE '%sur%'
  AND (latitud IS NULL OR longitud IS NULL);
