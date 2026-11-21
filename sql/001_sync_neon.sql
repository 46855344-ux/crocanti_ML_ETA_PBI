-- ============================================================
-- ESQUEMA COMPLETO + SINCRONIZACIÓN · CROCANTI · NEON (PostgreSQL)
-- ------------------------------------------------------------
-- Ejecutar en el SQL Editor de Neon o pgAdmin, bloque por bloque.
-- Es idempotente: puede ejecutarse más de una vez sin duplicar datos.
-- No borra información (la limpieza de duplicados está comentada).
-- ============================================================


-- ------------------------------------------------------------
-- 0) USUARIOS
--    Roles usados por las apps: 'administrador' y 'cliente'
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usuarios (
    id      SERIAL PRIMARY KEY,
    nombre  TEXT NOT NULL,
    correo  TEXT NOT NULL UNIQUE,
    clave   TEXT NOT NULL,
    rol     TEXT NOT NULL DEFAULT 'cliente'
);


-- ------------------------------------------------------------
-- 1) PRODUCTOS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS productos (
    id            SERIAL PRIMARY KEY,
    nombre        TEXT NOT NULL,
    categoria     TEXT NOT NULL,
    precio        NUMERIC(10,2) NOT NULL CHECK (precio >= 0),
    descripcion   TEXT NOT NULL DEFAULT '',
    imagen_emoji  TEXT NOT NULL DEFAULT '',
    disponible    BOOLEAN NOT NULL DEFAULT TRUE,
    en_promocion  BOOLEAN NOT NULL DEFAULT FALSE
);

-- Columnas de sincronización
ALTER TABLE productos ADD COLUMN IF NOT EXISTS uuid_operation TEXT;
ALTER TABLE productos ADD COLUMN IF NOT EXISTS imagen_url TEXT;

-- Si tu tabla ya tiene productos repetidos por nombre, ejecuta después
-- 002_dedupe_productos.sql. Ese script limpia los duplicados y crea el
-- índice único ux_productos_nombre_normalizado.

-- DIAGNÓSTICO: debe devolver 0 filas antes del índice único.
-- Si devuelve filas, resuélvelas antes de continuar.
SELECT uuid_operation, COUNT(*) AS repeticiones
FROM productos
WHERE uuid_operation IS NOT NULL
GROUP BY uuid_operation
HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_uuid_operation
    ON productos (uuid_operation);


-- ------------------------------------------------------------
-- 2) PROMOCIONES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promociones (
    id                    SERIAL PRIMARY KEY,
    producto_id           INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
    descuento_porcentaje  NUMERIC(5,2) NOT NULL CHECK (descuento_porcentaje BETWEEN 0 AND 100),
    activa                BOOLEAN NOT NULL DEFAULT TRUE,
    uuid_operation        TEXT
);

ALTER TABLE promociones ADD COLUMN IF NOT EXISTS uuid_operation TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_promociones_uuid_operation
    ON promociones (uuid_operation);

CREATE INDEX IF NOT EXISTS ix_promociones_producto_id
    ON promociones (producto_id);


-- ------------------------------------------------------------
-- 3) PEDIDOS (cabecera)
--    fecha es TEXT porque Android envía "dd/MM/yyyy HH:mm".
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pedidos (
    id                 SERIAL PRIMARY KEY,
    numero_orden       TEXT NOT NULL,
    total              NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    tienda             TEXT NOT NULL DEFAULT '',
    tipo_pago          TEXT NOT NULL DEFAULT 'Efectivo',
    codigo_operacion   TEXT NOT NULL DEFAULT '',
    direccion_entrega  TEXT NOT NULL DEFAULT '',
    estado             TEXT NOT NULL DEFAULT 'PENDIENTE',
    fecha              TEXT NOT NULL DEFAULT ''
);

-- Columnas de sincronización, dueño y tienda normalizada
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS uuid_operation TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS usuario_id INTEGER;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tienda_id INTEGER;

-- DIAGNÓSTICO: duplicados que impedirían el índice único.
SELECT uuid_operation, COUNT(*) AS repeticiones
FROM pedidos
WHERE uuid_operation IS NOT NULL
GROUP BY uuid_operation
HAVING COUNT(*) > 1;

-- LIMPIEZA OPCIONAL: ejecutar SOLO si el diagnóstico anterior devolvió filas.
-- Conserva el pedido de mayor id de cada uuid.
-- DELETE FROM pedidos p
-- USING pedidos q
-- WHERE p.uuid_operation IS NOT NULL
--   AND p.uuid_operation = q.uuid_operation
--   AND p.id < q.id;

CREATE UNIQUE INDEX IF NOT EXISTS ux_pedidos_uuid_operation
    ON pedidos (uuid_operation);


-- ------------------------------------------------------------
-- 4) BITÁCORA DE SINCRONIZACIÓN
--    Idempotencia del POST /api/sync y traducción id local → id remoto.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_operaciones (
    uuid_operation   TEXT PRIMARY KEY,
    entidad          TEXT NOT NULL,
    tipo_operacion   TEXT NOT NULL,
    id_remoto        INTEGER,
    id_local         INTEGER,
    procesado_en     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sync_operaciones ADD COLUMN IF NOT EXISTS id_local INTEGER;

CREATE INDEX IF NOT EXISTS ix_sync_operaciones_entidad
    ON sync_operaciones (entidad);

CREATE INDEX IF NOT EXISTS ix_sync_operaciones_local
    ON sync_operaciones (entidad, id_local);


-- ------------------------------------------------------------
-- 5) TIENDAS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tiendas (
    id         SERIAL PRIMARY KEY,
    nombre     TEXT NOT NULL,
    direccion  TEXT,
    telefono   TEXT,
    activa     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tiendas_nombre
    ON tiendas (lower(nombre));

-- Si la tabla ya existía de una versión anterior:
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS direccion TEXT;
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS telefono TEXT;
ALTER TABLE tiendas ADD COLUMN IF NOT EXISTS activa BOOLEAN NOT NULL DEFAULT TRUE;

-- Tiendas que usa la app CLIENTE
INSERT INTO tiendas (nombre, activa)
VALUES
    ('Tienda Chiclayo Centro', TRUE),
    ('Tienda Chiclayo Norte', TRUE),
    ('Tienda Chiclayo Sur', TRUE)
ON CONFLICT DO NOTHING;


-- ------------------------------------------------------------
-- 6) PEDIDOS: claves foráneas de dueño y tienda
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_pedidos_usuario'
          AND conrelid = 'pedidos'::regclass
    ) THEN
        ALTER TABLE pedidos
            ADD CONSTRAINT fk_pedidos_usuario
            FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_pedidos_tienda'
          AND conrelid = 'pedidos'::regclass
    ) THEN
        ALTER TABLE pedidos
            ADD CONSTRAINT fk_pedidos_tienda
            FOREIGN KEY (tienda_id) REFERENCES tiendas(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS ix_pedidos_usuario_id ON pedidos (usuario_id);
CREATE INDEX IF NOT EXISTS ix_pedidos_tienda_id ON pedidos (tienda_id);

-- Backfill: empareja el texto libre con la tienda normalizada
UPDATE pedidos p
SET tienda_id = t.id
FROM tiendas t
WHERE p.tienda_id IS NULL
  AND lower(trim(p.tienda)) = lower(t.nombre);


-- ------------------------------------------------------------
-- 7) DETALLE DEL PEDIDO (líneas)
--    subtotal es columna generada: NO se inserta desde la API.
--    producto_id pasa a NULL si se borra el producto, para no
--    perder la línea histórica (nombre y precio quedan guardados).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS detalle_pedido (
    id               SERIAL PRIMARY KEY,
    pedido_id        INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
    producto_id      INTEGER REFERENCES productos(id) ON DELETE SET NULL,
    nombre_producto  TEXT NOT NULL DEFAULT '',
    cantidad         INTEGER NOT NULL CHECK (cantidad > 0),
    precio_unitario  NUMERIC(10,2) NOT NULL CHECK (precio_unitario >= 0),
    subtotal         NUMERIC(12,2) GENERATED ALWAYS AS (cantidad * precio_unitario) STORED,
    CONSTRAINT ux_detalle_pedido_pedido_producto UNIQUE (pedido_id, producto_id)
);

CREATE INDEX IF NOT EXISTS ix_detalle_pedido_pedido
    ON detalle_pedido (pedido_id);

CREATE INDEX IF NOT EXISTS ix_detalle_pedido_producto
    ON detalle_pedido (producto_id);

-- Si la tabla ya existía de una versión anterior:
ALTER TABLE detalle_pedido ALTER COLUMN producto_id DROP NOT NULL;
ALTER TABLE detalle_pedido ADD COLUMN IF NOT EXISTS nombre_producto TEXT NOT NULL DEFAULT '';
ALTER TABLE detalle_pedido ADD COLUMN IF NOT EXISTS cantidad INTEGER NOT NULL DEFAULT 1;
ALTER TABLE detalle_pedido ADD COLUMN IF NOT EXISTS precio_unitario NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE detalle_pedido
    ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2)
    GENERATED ALWAYS AS (cantidad * precio_unitario) STORED;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ux_detalle_pedido_pedido_producto'
          AND conrelid = 'detalle_pedido'::regclass
    ) THEN
        ALTER TABLE detalle_pedido
            ADD CONSTRAINT ux_detalle_pedido_pedido_producto
            UNIQUE (pedido_id, producto_id);
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'detalle_pedido_producto_id_fkey'
          AND conrelid = 'detalle_pedido'::regclass
          AND confdeltype <> 'n'
    ) THEN
        ALTER TABLE detalle_pedido DROP CONSTRAINT detalle_pedido_producto_id_fkey;
        ALTER TABLE detalle_pedido
            ADD CONSTRAINT detalle_pedido_producto_id_fkey
            FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
    END IF;
END $$;


-- ------------------------------------------------------------
-- 8) VERIFICACIÓN DEL ESQUEMA
-- ------------------------------------------------------------
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
      'usuarios', 'productos', 'promociones', 'pedidos',
      'detalle_pedido', 'tiendas', 'sync_operaciones'
  )
ORDER BY table_name, ordinal_position;

-- Conteo rápido de filas por tabla
SELECT 'usuarios' AS tabla, COUNT(*) FROM usuarios
UNION ALL SELECT 'productos', COUNT(*) FROM productos
UNION ALL SELECT 'promociones', COUNT(*) FROM promociones
UNION ALL SELECT 'pedidos', COUNT(*) FROM pedidos
UNION ALL SELECT 'detalle_pedido', COUNT(*) FROM detalle_pedido
UNION ALL SELECT 'tiendas', COUNT(*) FROM tiendas
UNION ALL SELECT 'sync_operaciones', COUNT(*) FROM sync_operaciones;
