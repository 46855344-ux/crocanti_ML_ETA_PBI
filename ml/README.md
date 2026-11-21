# Modelo predictivo de ETA · Crocanti Chicken

## Qué hace

Predice los minutos de entrega de un pedido usando un **RandomForestRegressor**
entrenado con variables operativas:

| Variable | Descripción |
|---|---|
| `distancia_km` | Distancia tienda → entrega |
| `carga_cocina` | Pedidos en cocina/listos al calcular el ETA |
| `repartidores_disponibles` | Repartidores con turno activo |
| `hora_sin` | Hora del pedido (0–23) |
| `dia_semana` | Día de la semana (0 = domingo) |
| `es_fin_semana` | 1 si sábado/domingo |
| `cantidad_items` | Unidades totales del pedido |
| `total` | Monto del pedido |
| `es_delivery` | 1 delivery / 0 recojo |

La variable objetivo es `minutos_entrega`.

## Archivos

| Archivo | Función |
|---|---|
| `entrenar_eta.py` | Genera/entrena el modelo y exporta JSON + métricas |
| `modelo_eta.json` | Bosque exportado para inferencia en Node.js |
| `metricas_eta.json` | Métricas, features e importancia |
| `datos_eta_sinteticos.csv` | Dataset académico de 3,200 registros |
| `eta_model.js` | Inferencia en Node.js (sin Python en producción) |
| `exportar_datos_reales.js` | Exporta pedidos reales desde `vw_bi_eta` |

## Métricas del modelo actual

| Métrica | Modelo ML | Heurístico anterior |
|---|---:|---:|
| MAE | **3.38 min** | 8.51 min |
| RMSE | **4.27 min** | 10.45 min |
| R² | **0.940** | — |
| Mejora MAE | **60.3 %** | — |

## Cómo se integró

El endpoint `GET /api/pedidos/:id/eta`:

1. Calcula distancia, carga de cocina, repartidores, hora, día, ítems y total.
2. Llama a `predecirEta()` del modelo.
3. Devuelve `etaMinutos`, `etaMinimo`, `etaMaximo`, `modelo` y `desviacionMinutos`.
4. Guarda la predicción en `eta_predicciones`.
5. Si el modelo falla, usa la fórmula heurística anterior como respaldo.

Las apps CLIENTE y REPARTIDOR muestran el rango estimado (`mín–máx min`).

## Reentrenar con datos reales

1. Exporta los pedidos entregados:

```powershell
cd crocanti-backend
npm run exportar-datos-eta
```

2. Verifica que haya al menos 100 filas. Si hay menos, el modelo sintético sigue
   siendo la mejor opción para la demo.

3. Reentrena:

```powershell
python ml/entrenar_eta.py --datos real
```

El script sobrescribe `ml/modelo_eta.json`; reinicia el backend para que cargue
el nuevo modelo.

## Requisitos de Python

```powershell
python -m pip install -r ml/requirements.txt
```

## Limitación académica

Neon tiene muy pocos pedidos entregados. El modelo actual se entrenó con datos
sintéticos generados a partir de una lógica operativa realista (distancia, carga
de cocina, tráfico por hora, fines de semana y ruido). **No presentes estos
datos como pedidos reales**; explica que es una simulación académica y que el
pipeline queda listo para reentrenar con datos reales.
