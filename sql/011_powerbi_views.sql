-- ============================================================
-- 011 · MODELO DE DATOS PARA POWER BI
-- ------------------------------------------------------------
-- Vistas de solo lectura. Ejecutar después de 001–010.
-- Power BI puede conectarse a Neon y usar estas vistas, o
-- importar los CSV generados por `npm run exportar-powerbi`.
-- ============================================================

-- Se recrean para permitir cambios de columnas sin conflictos.
DROP VIEW IF EXISTS vw_bi_eta CASCADE;
DROP VIEW IF EXISTS vw_bi_ventas_diarias CASCADE;
DROP VIEW IF EXISTS vw_bi_detalle CASCADE;
DROP VIEW IF EXISTS vw_bi_repartidores CASCADE;
DROP VIEW IF EXISTS vw_bi_productos CASCADE;
DROP VIEW IF EXISTS vw_bi_pedidos CASCADE;

-- ------------------------------------------------------------
-- 1) PEDIDOS (tabla de hechos principal)
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bi_pedidos AS
WITH eventos AS (
    SELECT
        pedido_id,
        MIN(fecha_hora) FILTER (WHERE upper(estado) = 'EN_CAMINO') AS en_camino_en,
        MAX(fecha_hora) FILTER (WHERE upper(estado) LIKE 'ENTREGADO%') AS entregado_en
    FROM eventos_pedido
    GROUP BY pedido_id
),
ultimo_pago AS (
    SELECT DISTINCT ON (pedido_id)
        pedido_id, medio, estado, confirmado_en
    FROM pagos
    ORDER BY pedido_id, creado_en DESC
)
SELECT
    p.id AS pedido_id,
    p.numero_orden,
    p.creado_en,
    p.creado_en::date AS fecha,
    EXTRACT(HOUR FROM p.creado_en)::int AS hora,
    EXTRACT(DOW FROM p.creado_en)::int AS dia_semana,
    CASE WHEN EXTRACT(DOW FROM p.creado_en) IN (0, 6) THEN 1 ELSE 0 END AS es_fin_semana,
    p.estado,
    p.tienda,
    p.tipo_entrega,
    p.tipo_pago,
    p.total,
    p.costo_delivery,
    u.nombre AS cliente_nombre,
    u.correo AS cliente_correo,
    p.repartidor_id,
    r.nombre AS repartidor_nombre,
    r.correo AS repartidor_correo,
    pa.medio AS pago_medio,
    pa.estado AS pago_estado,
    ev.en_camino_en,
    ev.entregado_en,
    CASE
        WHEN ev.entregado_en IS NOT NULL
        THEN ROUND((EXTRACT(EPOCH FROM (ev.entregado_en - p.creado_en)) / 60.0)::numeric, 2)
        ELSE NULL
    END AS minutos_entrega,
    COALESCE(
        CASE
            WHEN p.latitud_entrega IS NOT NULL
                 AND p.longitud_entrega IS NOT NULL
                 AND t.latitud IS NOT NULL
                 AND t.longitud IS NOT NULL
            THEN ROUND((
                6371 * 2 * ASIN(SQRT(
                    POWER(SIN(RADIANS(t.latitud - p.latitud_entrega) / 2), 2) +
                    COS(RADIANS(t.latitud)) *
                    COS(RADIANS(p.latitud_entrega)) *
                    POWER(SIN(RADIANS(t.longitud - p.longitud_entrega) / 2), 2)
                ))
            )::numeric, 2)
            ELSE NULL
        END,
        ep.distancia_km
    ) AS distancia_km,
    ep.eta_minutos,
    ep.eta_minimo,
    ep.eta_maximo,
    ep.modelo AS modelo_eta,
    ep.carga_cocina,
    ep.repartidores_disponibles,
    ep.cantidad_items,
    ep.hora_sin,
    ep.dia_semana AS dia_semana_prediccion
FROM pedidos p
LEFT JOIN usuarios u ON u.id = p.usuario_id
LEFT JOIN usuarios r ON r.id = p.repartidor_id
LEFT JOIN tiendas t ON t.id = p.tienda_id
LEFT JOIN eventos ev ON ev.pedido_id = p.id
LEFT JOIN ultimo_pago pa ON pa.pedido_id = p.id
LEFT JOIN eta_predicciones ep ON ep.pedido_id = p.id;

-- ------------------------------------------------------------
-- 2) DETALLE DE PEDIDOS
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bi_detalle AS
SELECT
    d.id AS detalle_id,
    d.pedido_id,
    p.numero_orden,
    p.creado_en::date AS fecha,
    p.estado,
    p.tienda,
    p.tipo_entrega,
    p.tipo_pago,
    d.producto_id,
    d.nombre_producto,
    COALESCE(pr.categoria, 'Sin categoría') AS categoria,
    d.cantidad,
    d.precio_unitario,
    d.subtotal,
    (upper(p.estado) LIKE 'ENTREGADO%') AS es_venta
FROM detalle_pedido d
JOIN pedidos p ON p.id = d.pedido_id
LEFT JOIN productos pr ON pr.id = d.producto_id;

-- ------------------------------------------------------------
-- 3) DIMENSIÓN PRODUCTOS
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bi_productos AS
SELECT
    id AS producto_id,
    nombre,
    categoria,
    precio,
    disponible,
    en_promocion,
    uuid_operation,
    imagen_url
FROM productos;

-- ------------------------------------------------------------
-- 4) DIMENSIÓN REPARTIDORES
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bi_repartidores AS
SELECT
    r.id AS repartidor_id,
    r.usuario_id,
    u.nombre,
    u.correo,
    u.telefono,
    r.turno_activo,
    r.disponible,
    r.latitud,
    r.longitud,
    r.actualizado_en
FROM repartidores r
JOIN usuarios u ON u.id = r.usuario_id;

-- ------------------------------------------------------------
-- 5) VENTAS DIARIAS
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bi_ventas_diarias AS
SELECT
    fecha,
    COUNT(*)::int AS pedidos,
    COALESCE(SUM(total), 0) AS ventas,
    COALESCE(ROUND(AVG(total), 2), 0) AS ticket_promedio,
    COALESCE(SUM(CASE WHEN upper(tipo_pago) LIKE '%QR%' THEN total ELSE 0 END), 0) AS ventas_qr,
    COALESCE(SUM(CASE WHEN upper(tipo_pago) LIKE '%EFECTIVO%' THEN total ELSE 0 END), 0) AS ventas_efectivo,
    COUNT(*) FILTER (WHERE upper(tipo_entrega) = 'DELIVERY')::int AS pedidos_delivery,
    COUNT(*) FILTER (WHERE upper(tipo_entrega) = 'RECOJO')::int AS pedidos_recojo
FROM vw_bi_pedidos
WHERE upper(estado) LIKE 'ENTREGADO%'
GROUP BY fecha
ORDER BY fecha;

-- ------------------------------------------------------------
-- 6) ETA: PREDICHO VS. REAL
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW vw_bi_eta AS
SELECT
    pedido_id,
    numero_orden,
    fecha,
    hora,
    dia_semana,
    es_fin_semana,
    tipo_entrega,
    tienda,
    distancia_km,
    carga_cocina,
    repartidores_disponibles,
    cantidad_items,
    total,
    eta_minutos AS eta_predicho,
    eta_minimo,
    eta_maximo,
    modelo_eta,
    minutos_entrega AS minutos_reales,
    ROUND(minutos_entrega - eta_minutos, 2) AS error_minutos,
    ROUND(ABS(minutos_entrega - eta_minutos), 2) AS error_absoluto,
    CASE
        WHEN eta_minimo IS NOT NULL AND eta_maximo IS NOT NULL
        THEN (minutos_entrega BETWEEN eta_minimo AND eta_maximo)
        ELSE NULL
    END AS dentro_intervalo,
    ROUND(GREATEST(10, LEAST(90,
        CASE
            WHEN upper(tipo_entrega) = 'DELIVERY'
            THEN 10 + (COALESCE(distancia_km, 5) / 22.0) * 60
                 + COALESCE(carga_cocina, 0) * 2
                 - COALESCE(repartidores_disponibles, 0) * 1.5
            ELSE 10 + COALESCE(carga_cocina, 0) * 2
        END
    )), 2) AS eta_heuristico
FROM vw_bi_pedidos
WHERE minutos_entrega IS NOT NULL;

-- Verificación rápida
SELECT 'vw_bi_pedidos' AS vista, count(*) FROM vw_bi_pedidos
UNION ALL
SELECT 'vw_bi_detalle', count(*) FROM vw_bi_detalle
UNION ALL
SELECT 'vw_bi_productos', count(*) FROM vw_bi_productos
UNION ALL
SELECT 'vw_bi_repartidores', count(*) FROM vw_bi_repartidores
UNION ALL
SELECT 'vw_bi_ventas_diarias', count(*) FROM vw_bi_ventas_diarias
UNION ALL
SELECT 'vw_bi_eta', count(*) FROM vw_bi_eta;
