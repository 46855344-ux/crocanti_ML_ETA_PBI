# Nota: pedidos históricos sin dueño, tienda ni detalle

Los pedidos creados antes de este cambio quedaron así:

- `usuario_id = NULL` → no se guardaba quién compró.
- `tienda_id = NULL` → solo existía el texto libre `tienda`.
- Sin filas en `detalle_pedido` → nunca se guardaron las líneas.

El código nuevo ya escribe esos tres datos. Esta nota explica cómo se
reparan los pedidos antiguos **sin inventar información**.

---

## 1. Diagnóstico

```sql
-- Pedidos huérfanos de cliente y/o tienda
SELECT id, numero_orden, tienda, usuario_id, tienda_id, total, fecha
FROM pedidos
WHERE usuario_id IS NULL
   OR tienda_id IS NULL
ORDER BY id;

-- Pedidos sin líneas de detalle
SELECT p.id, p.numero_orden, p.total
FROM pedidos p
LEFT JOIN detalle_pedido d ON d.pedido_id = p.id
WHERE d.id IS NULL
ORDER BY p.id;
```

---

## 2. Tienda: sí se puede recuperar

El nombre de la tienda sí quedó guardado en el texto `tienda`, así que se
empareja con la tabla normalizada. Este bloque ya está incluido en
`001_sync_neon.sql`:

```sql
UPDATE pedidos p
SET tienda_id = t.id
FROM tiendas t
WHERE p.tienda_id IS NULL
  AND lower(trim(p.tienda)) = lower(t.nombre);
```

Si alguna fila queda en `NULL`, es porque el texto no coincide con ninguna
tienda registrada. Revísala manualmente:

```sql
SELECT DISTINCT tienda
FROM pedidos
WHERE tienda_id IS NULL
ORDER BY tienda;
```

---

## 3. Cliente: no se puede recuperar el comprador real

No existe ningún dato que relacione esos pedidos con un usuario. Hay dos
salidas honestas:

### Opción A (recomendada): dejarlos sin dueño

`usuario_id` queda `NULL` y la app ADMIN muestra
**"Cliente no identificado"**. No se falsea la información.

### Opción B: usuario histórico de relleno

Solo si se necesita que ningún pedido quede sin cliente. Se crea un usuario
técnico y se le asignan únicamente los pedidos huérfanos:

```sql
-- Crear el usuario técnico (una sola vez)
INSERT INTO usuarios (nombre, correo, clave, rol)
VALUES ('Cliente Histórico', 'historico@crocanti.pe', 'no-login', 'cliente')
ON CONFLICT (correo) DO NOTHING;

-- Asignar SOLO a pedidos sin dueño
UPDATE pedidos
SET usuario_id = (SELECT id FROM usuarios WHERE correo = 'historico@crocanti.pe')
WHERE usuario_id IS NULL;
```

> Este usuario no debe poder iniciar sesión. Si la tabla `usuarios` tiene
> restricciones extra (por ejemplo `clave` obligatoria), usa una clave
> aleatoria larga. El objetivo es solo cerrar la relación, no suplantar al
> comprador.

### Si en tu versión antigua existe una columna con el correo

Si la tabla `pedidos` llegó a tener `correo`, `usuario_correo` o similar,
primero compruébalo y luego mapea:

```sql
-- Ver columnas disponibles
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'pedidos'
ORDER BY ordinal_position;

-- Ejemplo SOLO si existe la columna usuario_correo
UPDATE pedidos p
SET usuario_id = u.id
FROM usuarios u
WHERE p.usuario_id IS NULL
  AND p.usuario_correo IS NOT NULL
  AND lower(p.usuario_correo) = lower(u.correo);
```

---

## 4. Detalle: no se puede reconstruir

Las líneas (producto, cantidad, precio unitario) nunca se guardaron, por lo
que **no hay forma de recuperarlas**. El total del pedido sí se conserva.

Recomendación: dejar `detalle_pedido` vacío para esos pedidos. La app ADMIN
ya contempla ese caso y muestra la tarjeta sin la sección "Detalle del
pedido". No conviene inventar una línea con el total, porque falsearía
precios y cantidades.

Si por política necesitas que ningún pedido quede sin líneas, puedes crear
una línea genérica marcada como tal:

```sql
-- OPCIONAL Y SOLO COMO MARCADOR, no representa la compra real
INSERT INTO detalle_pedido
    (pedido_id, producto_id, nombre_producto, cantidad, precio_unitario)
SELECT p.id,
       (SELECT id FROM productos ORDER BY id LIMIT 1),
       'Detalle histórico no disponible',
       1,
       p.total
FROM pedidos p
LEFT JOIN detalle_pedido d ON d.pedido_id = p.id
WHERE d.id IS NULL
ON CONFLICT (pedido_id, producto_id) DO NOTHING;
```

> Requiere que exista al menos un producto. Si no existe, este bloque falla
> y no debe ejecutarse.

---

## 5. Verificación final

```sql
SELECT
    COUNT(*) FILTER (WHERE usuario_id IS NULL) AS sin_cliente,
    COUNT(*) FILTER (WHERE tienda_id IS NULL)  AS sin_tienda,
    COUNT(*) FILTER (
        WHERE NOT EXISTS (
            SELECT 1 FROM detalle_pedido d WHERE d.pedido_id = pedidos.id
        )
    ) AS sin_detalle
FROM pedidos;
```

Los pedidos nuevos deben quedar en `0` para `sin_cliente` y `sin_tienda`
siempre que el cliente haya iniciado sesión con conexión al menos una vez.
`sin_detalle` solo debería contar pedidos históricos.
