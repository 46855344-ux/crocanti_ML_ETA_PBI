-- ============================================================
-- LIMPIEZA DE PRODUCTOS DUPLICADOS · CROCANTI · NEON
-- ------------------------------------------------------------
-- Ejecutar UNA sola vez en el SQL Editor de Neon.
-- Conserva el producto de menor id de cada nombre normalizado,
-- reasigna sus referencias y elimina las filas repetidas.
-- Es seguro ejecutarlo dentro de una transacción.
-- ============================================================


-- ------------------------------------------------------------
-- 0) DIAGNÓSTICO (ejecutar primero y revisar el resultado)
-- ------------------------------------------------------------
SELECT
    lower(trim(nombre))           AS nombre_normalizado,
    COUNT(*)                       AS repeticiones,
    array_agg(id ORDER BY id)      AS ids,
    array_agg(nombre ORDER BY id)  AS nombres
FROM productos
GROUP BY lower(trim(nombre))
HAVING COUNT(*) > 1
ORDER BY lower(trim(nombre));


-- ------------------------------------------------------------
-- 1) LIMPIEZA
-- ------------------------------------------------------------
BEGIN;

-- Mapa completo: cada producto -> id que se conserva (el menor).
CREATE TEMP TABLE productos_mapa ON COMMIT DROP AS
SELECT
    id,
    MIN(id) OVER (PARTITION BY lower(trim(nombre))) AS keep_id
FROM productos;

-- 1.1) Detalle de pedidos:
--      Si varias líneas del mismo pedido terminan apuntando al mismo
--      producto conservado, se deja solo la de menor id para no violar
--      la restricción UNIQUE (pedido_id, producto_id).
DELETE FROM detalle_pedido dp
USING productos_mapa m
WHERE dp.producto_id = m.id
  AND dp.id > (
      SELECT MIN(k.id)
      FROM detalle_pedido k
      JOIN productos_mapa m2 ON k.producto_id = m2.id
      WHERE k.pedido_id = dp.pedido_id
        AND m2.keep_id = m.keep_id
  );

-- 1.2) Reasignar las líneas restantes al producto conservado.
UPDATE detalle_pedido dp
SET producto_id = m.keep_id
FROM productos_mapa m
WHERE dp.producto_id = m.id
  AND m.id <> m.keep_id;

-- 1.3) Reasignar promociones al producto conservado.
UPDATE promociones p
SET producto_id = m.keep_id
FROM productos_mapa m
WHERE p.producto_id = m.id
  AND m.id <> m.keep_id;

-- 1.4) Quitar promociones exactamente repetidas (mismo producto,
--      descuento y estado) conservando la de menor id.
DELETE FROM promociones p
USING promociones q, productos_mapa m
WHERE p.producto_id = q.producto_id
  AND p.descuento_porcentaje = q.descuento_porcentaje
  AND p.activa = q.activa
  AND p.id > q.id
  AND p.producto_id = m.keep_id
  AND m.id <> m.keep_id;

-- 1.5) Eliminar los productos repetidos.
DELETE FROM productos p
USING productos_mapa m
WHERE p.id = m.id
  AND m.id <> m.keep_id;

-- 1.6) Normalizar espacios en los nombres que quedaron.
UPDATE productos SET nombre = trim(nombre);

COMMIT;


-- ------------------------------------------------------------
-- 2) BLINDAJE: impedir nuevos duplicados por nombre
-- ------------------------------------------------------------
-- Este índice es la garantía a nivel de base de datos. El backend
-- además busca por nombre antes de insertar.
CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_nombre_normalizado
    ON productos (lower(trim(nombre)));


-- ------------------------------------------------------------
-- 3) VERIFICACIÓN (debe devolver 0 filas)
-- ------------------------------------------------------------
SELECT
    lower(trim(nombre)) AS nombre_normalizado,
    COUNT(*)            AS repeticiones
FROM productos
GROUP BY lower(trim(nombre))
HAVING COUNT(*) > 1;
