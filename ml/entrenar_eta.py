"""
Entrenamiento del modelo predictivo de ETA · Crocanti Chicken
=============================================================

Genera un dataset sintético realista (porque Neon todavía no tiene
suficientes pedidos entregados), entrena un RandomForestRegressor,
lo evalúa contra la fórmula heurística actual y exporta el modelo a
JSON para que Node.js lo use sin depender de Python en producción.

Uso:
    python ml/entrenar_eta.py

Salidas:
    ml/modelo_eta.json
    ml/metricas_eta.json
    ml/datos_eta_sinteticos.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import train_test_split

BASE_DIR = Path(__file__).resolve().parent
SEMILLA = 42
N_REGISTROS = 3200

FEATURES = [
    "distancia_km",
    "carga_cocina",
    "repartidores_disponibles",
    "hora_sin",
    "dia_semana",
    "es_fin_semana",
    "cantidad_items",
    "total",
    "es_delivery",
]


def limitar(valor: float, minimo: float = 8.0, maximo: float = 90.0) -> float:
    return max(minimo, min(maximo, valor))


def generar_dataset(n: int = N_REGISTROS) -> list[dict]:
    rng = random.Random(SEMILLA)
    filas: list[dict] = []

    for _ in range(n):
        es_delivery = 1 if rng.random() < 0.72 else 0
        distancia = round(rng.uniform(0.4, 13.0), 2) if es_delivery else 0.0
        carga = rng.randint(0, 12)
        repartidores = rng.randint(0, 8)
        hora = rng.randint(10, 22)
        dia = rng.randint(0, 6)
        fin_semana = 1 if dia in (5, 6) else 0
        items = rng.randint(1, 12)
        total = round(rng.uniform(8, 160), 2)

        peak = 1 if hora in (12, 13, 14, 19, 20, 21) else 0
        traffic = 1.0 + 0.30 * peak + 0.10 * fin_semana + 0.015 * max(0, hora - 18)

        if es_delivery:
            viaje = (distancia / 20.0) * 60.0 * traffic
            cocina = (carga ** 1.12) * 1.9
            conductor = -min(repartidores, 5) * 1.3
            base = 7.0 + viaje + cocina + conductor + items * 0.35 + total * 0.008
            sigma = 1.2 + 0.06 * distancia + 0.15 * carga
        else:
            base = 7.0 + (carga ** 1.08) * 2.1 + peak * 3.5 + items * 0.30
            sigma = 1.1 + 0.12 * carga

        target = limitar(base + rng.gauss(0, sigma))
        filas.append({
            "distancia_km": distancia,
            "carga_cocina": carga,
            "repartidores_disponibles": repartidores,
            "hora_sin": hora,
            "dia_semana": dia,
            "es_fin_semana": fin_semana,
            "cantidad_items": items,
            "total": total,
            "es_delivery": es_delivery,
            "minutos_entrega": round(target, 2),
        })

    return filas


def cargar_dataset_real(ruta: Path) -> list[dict]:
    if not ruta.exists():
        raise FileNotFoundError(f"No existe el dataset real: {ruta}")
    filas: list[dict] = []
    with ruta.open("r", encoding="utf-8-sig", newline="") as f:
        lector = csv.DictReader(f)
        for crudo in lector:
            try:
                fila = {
                    "distancia_km": float(crudo["distancia_km"]),
                    "carga_cocina": int(float(crudo["carga_cocina"])),
                    "repartidores_disponibles": int(float(crudo["repartidores_disponibles"])),
                    "hora_sin": int(float(crudo["hora_sin"])),
                    "dia_semana": int(float(crudo["dia_semana"])),
                    "es_fin_semana": int(float(crudo["es_fin_semana"])),
                    "cantidad_items": int(float(crudo["cantidad_items"])),
                    "total": float(crudo["total"]),
                    "es_delivery": int(float(crudo["es_delivery"])),
                    "minutos_entrega": float(crudo["minutos_entrega"]),
                }
                if fila["minutos_entrega"] > 0:
                    filas.append(fila)
            except (KeyError, TypeError, ValueError):
                continue
    return filas


def heuristica_actual(fila: dict) -> float:
    """Réplica de la fórmula anterior del backend (sin tráfico)."""
    if fila["es_delivery"]:
        eta = (
            10
            + (fila["distancia_km"] / 22.0) * 60.0
            + fila["carga_cocina"] * 2.0
            - fila["repartidores_disponibles"] * 1.5
        )
    else:
        eta = 10 + fila["carga_cocina"] * 2.0
    return limitar(round(eta), 10, 90)


def exportar_arbol(arbol) -> list[dict]:
    nodos: list[dict] = []
    for i in range(arbol.node_count):
        izquierda = int(arbol.children_left[i])
        derecha = int(arbol.children_right[i])
        if izquierda == -1 and derecha == -1:
            nodos.append({"v": round(float(arbol.value[i][0][0]), 4)})
        else:
            nodos.append({
                "f": int(arbol.feature[i]),
                "t": round(float(arbol.threshold[i]), 6),
                "l": izquierda,
                "r": derecha,
            })
    return nodos


def main() -> None:
    parser = argparse.ArgumentParser(description="Entrena el modelo de ETA de Crocanti")
    parser.add_argument(
        "--datos",
        choices=["sintetico", "real"],
        default="sintetico",
        help="Origen del dataset de entrenamiento"
    )
    parser.add_argument(
        "--archivo",
        default="datos_eta_reales.csv",
        help="CSV real (solo para --datos real)"
    )
    args = parser.parse_args()

    if args.datos == "real":
        ruta = BASE_DIR / args.archivo
        filas = cargar_dataset_real(ruta)
        if len(filas) < 100:
            raise SystemExit(
                f"El dataset real tiene {len(filas)} filas. Se necesitan al menos 100 "
                "pedidos entregados para entrenar un modelo mínimamente útil."
            )
        dataset_nombre = "real_v1"
        print(f"Usando dataset real: {ruta} ({len(filas)} filas)")
    else:
        filas = generar_dataset()
        dataset_nombre = "sintetico_v1"
        print(f"Usando dataset sintético: {len(filas)} filas")

    X = np.array([[f[n] for n in FEATURES] for f in filas], dtype=float)
    y = np.array([f["minutos_entrega"] for f in filas], dtype=float)

    X_train, X_test, y_train, y_test, idx_train, idx_test = train_test_split(
        X, y, list(range(len(filas))), test_size=0.20, random_state=SEMILLA
    )

    modelo = RandomForestRegressor(
        n_estimators=60,
        max_depth=7,
        min_samples_leaf=4,
        max_features=1.0,
        random_state=SEMILLA,
        n_jobs=-1,
    )
    modelo.fit(X_train, y_train)

    prediccion = modelo.predict(X_test)
    mae_modelo = float(mean_absolute_error(y_test, prediccion))
    rmse_modelo = float(math.sqrt(mean_squared_error(y_test, prediccion)))
    r2_modelo = float(r2_score(y_test, prediccion))

    heuristico = np.array([heuristica_actual(filas[i]) for i in idx_test], dtype=float)
    mae_heuristico = float(mean_absolute_error(y_test, heuristico))
    rmse_heuristico = float(math.sqrt(mean_squared_error(y_test, heuristico)))
    mejora = ((mae_heuristico - mae_modelo) / mae_heuristico) * 100.0

    importancias = {
        nombre: round(float(valor), 4)
        for nombre, valor in zip(FEATURES, modelo.feature_importances_)
    }

    payload = {
        "version": "eta_rf_v1",
        "algoritmo": "RandomForestRegressor",
        "dataset": dataset_nombre,
        "entrenado_en": datetime.now(timezone.utc).isoformat(),
        "features": FEATURES,
        "target": "minutos_entrega",
        "rango": [8, 90],
        "n_estimators": int(modelo.n_estimators),
        "max_depth": int(modelo.max_depth),
        "metricas": {
            "n_entrenamiento": int(len(X_train)),
            "n_prueba": int(len(X_test)),
            "mae_modelo": round(mae_modelo, 4),
            "rmse_modelo": round(rmse_modelo, 4),
            "r2_modelo": round(r2_modelo, 4),
            "mae_heuristico": round(mae_heuristico, 4),
            "rmse_heuristico": round(rmse_heuristico, 4),
            "mejora_mae_porcentaje": round(mejora, 2),
        },
        "importancia_features": importancias,
        "arboles": [{"nodos": exportar_arbol(estimador.tree_)} for estimador in modelo.estimators_],
    }

    with (BASE_DIR / "modelo_eta.json").open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    with (BASE_DIR / "metricas_eta.json").open("w", encoding="utf-8") as f:
        json.dump({
            "version": payload["version"],
            "entrenado_en": payload["entrenado_en"],
            "dataset": payload["dataset"],
            "features": FEATURES,
            "metricas": payload["metricas"],
            "importancia_features": importancias,
        }, f, ensure_ascii=False, indent=2)

    if args.datos == "sintetico":
        with (BASE_DIR / "datos_eta_sinteticos.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=FEATURES + ["minutos_entrega"])
            writer.writeheader()
            writer.writerows(filas)

    print("Modelo de ETA entrenado")
    print(f"  Dataset:          {dataset_nombre}")
    print(f"  Train: {len(X_train)} | Test: {len(X_test)}")
    print(f"  MAE modelo:       {mae_modelo:.3f} min")
    print(f"  RMSE modelo:      {rmse_modelo:.3f} min")
    print(f"  R2 modelo:        {r2_modelo:.3f}")
    print(f"  MAE heurístico:   {mae_heuristico:.3f} min")
    print(f"  Mejora MAE:       {mejora:.1f}%")
    print(f"  Modelo guardado en {BASE_DIR / 'modelo_eta.json'}")


if __name__ == "__main__":
    main()
