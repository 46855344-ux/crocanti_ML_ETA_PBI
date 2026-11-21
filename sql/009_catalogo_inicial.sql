-- ============================================================
-- 009 · CATÁLOGO INICIAL (30 PRODUCTOS)
-- ------------------------------------------------------------
-- Idempotente: solo inserta el producto si no existe otro con el
-- mismo nombre normalizado (trim + lower).
-- Ejecutar después de 001_sync_neon.sql y 002_dedupe_productos.sql.
-- ============================================================

WITH nuevos(nombre, categoria, precio, descripcion, imagen_emoji, disponible, en_promocion) AS (
    VALUES
        ('Pollo Entero',      'Pollo',       25.90, 'Pollo entero crocante',        '🍗', TRUE, FALSE),
        ('1/2 Pollo',         'Pollo',       14.50, 'Medio pollo crocante',         '🍗', TRUE, FALSE),
        ('Pechuga x2',        'Pollo',       12.00, 'Dos pechugas crocantes',       '🍗', TRUE, FALSE),
        ('Alitas x6',         'Pollo',       10.50, 'Seis alitas crocantes',        '🍗', TRUE, TRUE),
        ('Alitas x12',        'Pollo',       18.90, 'Doce alitas crocantes',        '🍗', TRUE, FALSE),
        ('Piernas x4',        'Pollo',       13.50, 'Cuatro piernas crocantes',     '🍗', TRUE, FALSE),
        ('Nuggets x10',       'Pollo',        9.90, 'Diez nuggets de pollo',        '🍗', TRUE, FALSE),
        ('Hamburguesa Pollo', 'Pollo',       11.50, 'Hamburguesa de pollo',         '🍗', TRUE, FALSE),
        ('Combo Familiar',    'Combos',      35.90, '1 pollo + 4 gaseosas',         '🍱', TRUE, TRUE),
        ('Combo Pareja',      'Combos',      22.50, '1/2 pollo + 2 gaseosas',       '🍱', TRUE, FALSE),
        ('Combo Individual',  'Combos',      16.90, '1/4 pollo + gaseosa + papas',  '🍱', TRUE, FALSE),
        ('Combo Alitas',      'Combos',      24.90, '12 alitas + 2 gaseosas',       '🍱', TRUE, FALSE),
        ('Combo Nuggets',     'Combos',      15.90, '20 nuggets + gaseosa',         '🍱', TRUE, FALSE),
        ('Gaseosa 500ml',     'Bebidas',      3.50, 'Gaseosa personal',             '🥤', TRUE, FALSE),
        ('Gaseosa 1.5L',      'Bebidas',      7.50, 'Gaseosa familiar',             '🥤', TRUE, FALSE),
        ('Gaseosa 3L',        'Bebidas',     12.00, 'Gaseosa gigante',              '🥤', TRUE, FALSE),
        ('Agua Mineral',      'Bebidas',      2.50, 'Agua mineral 500ml',           '💧', TRUE, FALSE),
        ('Jugo Natural',      'Bebidas',      5.50, 'Jugo de naranja',              '🧃', TRUE, FALSE),
        ('Helado Vainilla',   'Postres',      4.00, 'Helado de vainilla',           '🍦', TRUE, FALSE),
        ('Helado Chocolate',  'Postres',      4.00, 'Helado de chocolate',          '🍦', TRUE, FALSE),
        ('Brownie',           'Postres',      5.50, 'Brownie con chispas',          '🍫', TRUE, TRUE),
        ('Pie de Manzana',    'Postres',      6.00, 'Pie caliente de manzana',      '🥧', TRUE, FALSE),
        ('Papas Fritas',      'Adicionales',  5.50, 'Porción de papas fritas',      '🍟', TRUE, FALSE),
        ('Papas Grande',      'Adicionales',  8.50, 'Porción grande de papas',      '🍟', TRUE, FALSE),
        ('Ensalada',          'Adicionales',  6.50, 'Ensalada fresca',              '🥗', TRUE, FALSE),
        ('Salsa BBQ',         'Adicionales',  1.50, 'Salsa BBQ extra',              '🫙', TRUE, FALSE),
        ('Salsa Mayo',        'Adicionales',  1.50, 'Salsa mayonesa extra',         '🫙', TRUE, FALSE),
        ('Pan Adicional',     'Adicionales',  1.00, 'Pan extra',                    '🍞', TRUE, FALSE),
        ('Queso Extra',       'Adicionales',  2.50, 'Queso adicional',              '🧀', TRUE, FALSE),
        ('Tocino',            'Adicionales',  3.50, 'Tocino crocante',              '🥓', TRUE, FALSE)
)
INSERT INTO productos (
    nombre, categoria, precio, descripcion, imagen_emoji, disponible, en_promocion
)
SELECT
    n.nombre, n.categoria, n.precio, n.descripcion, n.imagen_emoji, n.disponible, n.en_promocion
FROM nuevos n
WHERE NOT EXISTS (
    SELECT 1
    FROM productos p
    WHERE lower(trim(p.nombre)) = lower(trim(n.nombre))
);

-- Verificación rápida
SELECT count(*) AS total_productos FROM productos;
