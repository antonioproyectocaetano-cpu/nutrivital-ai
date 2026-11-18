#!/usr/bin/env python3
"""
NUTRIVITAL AI — CLI PARA TERMINAL
Permite consultar tu balance diario de calorías, analizar alimentos desde cualquier terminal
y arrancar el servidor web en Python (FastAPI).
"""

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from py_src.ai_vision import analyze_food_photograph
from py_src.metabolism import calculate_metabolic_profile

DB_PATH = BASE_DIR / "data" / "nutriai.sqlite"


def cmd_resumen():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    user = conn.execute("SELECT * FROM users LIMIT 1").fetchone()
    if not user:
        print("No hay usuario registrado. Inicia el servidor web primero.")
        return
    today = conn.execute("SELECT date('now', 'localtime') as d").fetchone()["d"]
    meals = conn.execute(
        "SELECT meal_time, meal_type, title, total_kcal FROM meals WHERE user_id = ? AND meal_date = ? ORDER BY meal_time",
        (user["id"], today),
    ).fetchall()
    consumed = sum(m["total_kcal"] for m in meals)
    target = user["daily_calorie_target"]
    remaining = target - round(consumed)

    print(f"\n=== NUTRIVITAL AI ({today}) — {user['name']} ===")
    print(f"Objetivo diario : {target} kcal | TMB: {user['bmr_kcal']} kcal | GET: {user['tdee_kcal']} kcal")
    print(f"Consumidas hoy  : {round(consumed)} kcal")
    print(f"Disponibles hoy : {remaining} kcal\n")
    print("Comidas registradas:")
    for m in meals:
        print(f"  [{m['meal_time']}] {m['title']} -> {round(m['total_kcal'])} kcal")
    print()


def cmd_analizar(texto: str):
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    foods = [dict(r) for r in conn.execute("SELECT * FROM foods").fetchall()]
    res = analyze_food_photograph(foods_list=foods, user_hint=texto)
    print(f"\nAnálisis IA: {res['title']} (Confianza: {int(res['confidence']*100)}%)")
    for it in res["items"]:
        print(f"  - {it['name']}: {it['grams']} g -> {it['kcal']} kcal (P:{it['protein_g']}g H:{it['carbs_g']}g G:{it['fat_g']}g)")
    print(f"TOTAL: {res['totals']['total_kcal']} kcal\n")


def cmd_serve(port: int):
    print(f"Iniciando NutriVital AI en Python (FastAPI/Uvicorn) en http://0.0.0.0:{port} ...")
    subprocess.run([sys.executable, "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", str(port)], cwd=str(BASE_DIR))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NutriVital AI — Control de Calorías desde Terminal Python")
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("resumen", help="Muestra el resumen calórico de hoy")
    p_an = sub.add_parser("analizar", help="Analiza un plato por descripción y calcula calorías BEDCA")
    p_an.add_argument("texto", help="Descripción de la comida (ej: 'pollo con arroz y ensalada')")
    p_srv = sub.add_parser("serve", help="Arranca el servidor web Python FastAPI")
    p_srv.add_argument("--port", type=int, default=3000)

    args = parser.parse_args()
    if args.cmd == "resumen":
        cmd_resumen()
    elif args.cmd == "analizar":
        cmd_analizar(args.texto)
    elif args.cmd == "serve":
        cmd_serve(args.port)
    else:
        parser.print_help()
