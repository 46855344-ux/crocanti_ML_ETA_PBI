-- ============================================================
-- SEGURIDAD DE USUARIOS · CROCANTI · NEON
-- ------------------------------------------------------------
-- Ejecutar UNA sola vez en el SQL Editor de Neon DESPUÉS de
-- 001, 002 y 003. No crea tablas nuevas.
--
-- Las contraseñas se migran a bcrypt con el script:
--   npm run hashear-claves
-- (o de forma automática en el primer inicio de sesión).
-- ============================================================

-- 1) Normalizar los roles históricos a los tres perfiles del sistema.
UPDATE usuarios SET rol = 'administrador'
WHERE lower(rol) IN ('admin', 'dueño', 'dueno');

UPDATE usuarios SET rol = 'repartidor'
WHERE lower(rol) IN ('delivery');

-- 2) Evitar correos duplicados ignorando mayúsculas/minúsculas.
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_correo_lower
    ON usuarios (lower(correo));

-- 3) Restringir los roles válidos.
ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check
    CHECK (lower(rol) IN (
        'administrador', 'admin', 'cliente',
        'repartidor', 'delivery', 'cajero', 'cocina',
        'dueno', 'dueño'
    ));

-- 4) Diagnóstico final.
SELECT id, nombre, correo, rol,
       CASE WHEN clave LIKE '$2%' THEN 'bcrypt' ELSE 'texto plano' END AS formato_clave
FROM usuarios
ORDER BY id;
