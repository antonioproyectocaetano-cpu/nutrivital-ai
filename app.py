"""
SERVIDOR BACKEND PYTHON (FASTAPI + UVICORN) — NUTRIVITAL AI
Permite ejecutar toda la aplicación web y API REST desde Python en cualquier terminal o servidor.
"""

import hashlib
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from py_src.ai_vision import analyze_food_photograph, compute_item_nutrients
from py_src.metabolism import calculate_metabolic_profile, generate_who_evaluation

BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / "public"
DATA_DIR = BASE_DIR / "data"
BACKUP_DIR = DATA_DIR / "backups"
DB_PATH = Path(os.environ.get("SQLITE_DB_PATH") or (DATA_DIR / "nutriai.sqlite"))

DATA_DIR.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="NutriVital AI — Python Backend",
    description="API REST y aplicación web PWA de control inteligente de calorías con IA, BEDCA/USDA y OMS.",
    version="1.0.0",
)


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def hash_password(password: str) -> str:
    salt = b"nutrivital_rgpd_salt_v1"
    return hashlib.scrypt(str(password).encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=64).hex()


def get_today_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def shift_date_iso(base_iso: str, delta_days: int) -> str:
    dt = datetime.strptime(base_iso, "%Y-%m-%d") + timedelta(days=delta_days)
    return dt.strftime("%Y-%m-%d")


def safe_parse_json(raw: Any, fallback: Any) -> Any:
    if isinstance(raw, (dict, list)):
        return raw
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except Exception:
            return fallback
    return fallback


def sanitize_user(row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    u = dict(row)
    macro_targets = safe_parse_json(u.get("macro_targets_json"), {})
    special_conditions = safe_parse_json(u.get("special_conditions_json"), {})
    reminders = safe_parse_json(u.get("reminders_json"), {})

    metabolic = calculate_metabolic_profile({
        "age": u["age"],
        "sex": u["sex"],
        "height_cm": u["height_cm"],
        "weight_kg": u["weight_kg"],
        "target_weight_kg": u.get("target_weight_kg"),
        "activity_level": u["activity_level"],
        "work_activity": u.get("work_activity", "sedentary"),
        "exercise_frequency": u.get("exercise_frequency", "3_4_days"),
        "goal": u["goal"],
        "special_conditions": special_conditions,
    })

    return {
        "id": u["id"],
        "email": u["email"],
        "name": u["name"],
        "age": u["age"],
        "sex": u["sex"],
        "height_cm": u["height_cm"],
        "weight_kg": u["weight_kg"],
        "target_weight_kg": u.get("target_weight_kg"),
        "activity_level": u["activity_level"],
        "work_activity": u.get("work_activity", "sedentary"),
        "exercise_frequency": u.get("exercise_frequency", "3_4_days"),
        "goal": u["goal"],
        "special_conditions": special_conditions,
        "bmi": u["bmi"],
        "bmiCategory": metabolic["bmiCategory"],
        "healthyWeightRange": metabolic["healthyWeightRange"],
        "bmr_kcal": u["bmr_kcal"],
        "tdee_kcal": u["tdee_kcal"],
        "daily_calorie_target": u["daily_calorie_target"],
        "appliedDelta": metabolic["appliedDelta"],
        "safetyFloor": metabolic["safetyFloor"],
        "warnings": metabolic["warnings"],
        "methodologyNote": metabolic["methodologyNote"],
        "macroTargets": macro_targets,
        "water_target_ml": u["water_target_ml"],
        "reminders": reminders,
        "gdpr_consent_at": u["gdpr_consent_at"],
        "created_at": u["created_at"],
    }


def get_authenticated_user(req: Request, conn: sqlite3.Connection) -> Optional[Dict[str, Any]]:
    auth_header = req.headers.get("authorization", "")
    bearer = auth_header[7:].strip() if auth_header.startswith("Bearer ") else None
    token = bearer or req.cookies.get("nutrivital_token")

    if token:
        sess = conn.execute("SELECT user_id, expires_at FROM sessions WHERE token = ?", (token,)).fetchone()
        if sess and sess["expires_at"] > datetime.now(timezone.utc).isoformat():
            user = conn.execute("SELECT * FROM users WHERE id = ?", (sess["user_id"],)).fetchone()
            if user:
                return sanitize_user(user)

    if req.headers.get("x-no-demo-fallback") == "1":
        return None
    demo = conn.execute("SELECT * FROM users WHERE email = ?", ("elena@nutrivital.es",)).fetchone()
    return sanitize_user(demo)


def create_session(user_id: str, conn: sqlite3.Connection) -> str:
    token = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=30)
    conn.execute(
        "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        (token, user_id, expires.isoformat(), now.isoformat()),
    )
    conn.commit()
    return token


def get_all_foods(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    rows = conn.execute("SELECT * FROM foods ORDER BY name ASC").fetchall()
    return [dict(r) for r in rows]


def summarize_items_list(raw_items: List[Dict[str, Any]], conn: sqlite3.Connection) -> Dict[str, Any]:
    foods = get_all_foods(conn)
    food_map = {f["id"]: f for f in foods}
    enriched = []
    tot_kcal = tot_p = tot_c = tot_f = tot_sat = tot_fib = tot_sug = tot_free_sug = tot_salt = tot_fv = 0.0

    for item in raw_items or []:
        food = food_map.get(item.get("food_id"))
        grams = max(1.0, min(2500.0, float(item.get("grams") or 100)))
        if food:
            c = compute_item_nutrients(food, grams)
            c["item_confidence"] = item.get("item_confidence", 0.95)
            enriched.append(c)
        elif item.get("name") and item.get("kcal") is not None:
            c = {
                "food_id": item.get("food_id") or f"custom_{int(datetime.now().timestamp())}",
                "name": str(item["name"]),
                "category": item.get("category", "Personalizado"),
                "preparation_state": item.get("preparation_state", "ready"),
                "paired_food_id": None,
                "grams": round(grams),
                "kcal": round(float(item.get("kcal") or 0)),
                "protein_g": round(float(item.get("protein_g") or 0), 1),
                "carbs_g": round(float(item.get("carbs_g") or 0), 1),
                "fat_g": round(float(item.get("fat_g") or 0), 1),
                "saturated_fat_g": round(float(item.get("saturated_fat_g") or 0), 1),
                "fiber_g": round(float(item.get("fiber_g") or 0), 1),
                "sugars_g": round(float(item.get("sugars_g") or 0), 1),
                "free_sugars_g": round(float(item.get("free_sugars_g") or 0), 1),
                "salt_g": round(float(item.get("salt_g") or 0), 2),
                "fruit_veg_g": round(float(item.get("fruit_veg_g") or 0)),
                "source": item.get("source", "MANUAL"),
                "source_code": "REGISTRO-MANUAL",
            }
            enriched.append(c)
        else:
            continue

        tot_kcal += c["kcal"]
        tot_p += c["protein_g"]
        tot_c += c["carbs_g"]
        tot_f += c["fat_g"]
        tot_sat += c["saturated_fat_g"]
        tot_fib += c["fiber_g"]
        tot_sug += c["sugars_g"]
        tot_free_sug += c["free_sugars_g"]
        tot_salt += c["salt_g"]
        tot_fv += c["fruit_veg_g"]

    return {
        "items": enriched,
        "totals": {
            "total_kcal": round(tot_kcal),
            "total_protein_g": round(tot_p, 1),
            "total_carbs_g": round(tot_c, 1),
            "total_fat_g": round(tot_f, 1),
            "total_saturated_fat_g": round(tot_sat, 1),
            "total_fiber_g": round(tot_fib, 1),
            "total_sugars_g": round(tot_sug, 1),
            "total_free_sugars_g": round(tot_free_sug, 1),
            "total_salt_g": round(tot_salt, 2),
            "fruit_veg_grams": round(tot_fv),
        },
    }


def build_day_summary(user: Dict[str, Any], date_str: str, conn: sqlite3.Connection) -> Dict[str, Any]:
    rows = conn.execute(
        "SELECT * FROM meals WHERE user_id = ? AND meal_date = ? ORDER BY meal_time ASC, created_at ASC",
        (user["id"], date_str),
    ).fetchall()

    consumed_kcal = p_g = c_g = f_g = sat_g = fib_g = sug_g = free_sug_g = salt_g = fv_g = 0.0
    has_legumes = False
    has_whole_grains = False
    meals = []

    for r in rows:
        m = dict(r)
        items = safe_parse_json(m.get("items_json"), [])
        consumed_kcal += m["total_kcal"]
        p_g += m["total_protein_g"]
        c_g += m["total_carbs_g"]
        f_g += m["total_fat_g"]
        sat_g += m.get("total_saturated_fat_g") or 0
        fib_g += m.get("total_fiber_g") or 0
        sug_g += m.get("total_sugars_g") or 0
        free_sug_g += m.get("total_free_sugars_g") or 0
        salt_g += m.get("total_salt_g") or 0
        fv_g += m.get("fruit_veg_grams") or 0

        for it in items:
            if it.get("is_who_legume") or it.get("category") == "Legumbres":
                has_legumes = True
            if it.get("is_who_whole_grain") or "integral" in str(it.get("name", "")).lower():
                has_whole_grains = True

        meals.append({
            "id": m["id"],
            "meal_date": m["meal_date"],
            "meal_time": m["meal_time"],
            "meal_type": m["meal_type"],
            "title": m["title"],
            "photo_url": m["photo_url"],
            "items": items,
            "total_kcal": round(m["total_kcal"]),
            "total_protein_g": round(m["total_protein_g"], 1),
            "total_carbs_g": round(m["total_carbs_g"], 1),
            "total_fat_g": round(m["total_fat_g"], 1),
            "total_saturated_fat_g": round(m.get("total_saturated_fat_g") or 0, 1),
            "total_fiber_g": round(m.get("total_fiber_g") or 0, 1),
            "total_sugars_g": round(m.get("total_sugars_g") or 0, 1),
            "total_free_sugars_g": round(m.get("total_free_sugars_g") or 0, 1),
            "total_salt_g": round(m.get("total_salt_g") or 0, 2),
            "fruit_veg_grams": round(m.get("fruit_veg_grams") or 0),
            "ai_confidence": m.get("ai_confidence", 0.9),
            "ai_confidence_label": m.get("ai_confidence_label", "Alta"),
            "ai_notes": m.get("ai_notes"),
            "is_favorite": bool(m.get("is_favorite")),
        })

    w_row = conn.execute(
        "SELECT water_ml FROM daily_water WHERE user_id = ? AND log_date = ?",
        (user["id"], date_str),
    ).fetchone()
    water_ml = w_row["water_ml"] if w_row else 0

    target_kcal = user.get("daily_calorie_target") or 2000
    remaining_kcal = target_kcal - round(consumed_kcal)
    progress_pct = round((consumed_kcal / max(1, target_kcal)) * 100)

    daily_totals = {
        "total_kcal": round(consumed_kcal),
        "total_protein_g": round(p_g, 1),
        "total_carbs_g": round(c_g, 1),
        "total_fat_g": round(f_g, 1),
        "total_saturated_fat_g": round(sat_g, 1),
        "total_fiber_g": round(fib_g, 1),
        "total_sugars_g": round(sug_g, 1),
        "total_free_sugars_g": round(free_sug_g, 1),
        "total_salt_g": round(salt_g, 2),
        "fruit_veg_grams": round(fv_g),
        "water_ml": water_ml,
        "meals_count": len(meals),
        "has_legumes": has_legumes,
        "has_whole_grains": has_whole_grains,
    }

    who_eval = generate_who_evaluation(daily_totals, user)
    return {
        "date": date_str,
        "target_kcal": target_kcal,
        "consumed_kcal": round(consumed_kcal),
        "remaining_kcal": remaining_kcal,
        "progress_pct": progress_pct,
        "water_ml": water_ml,
        "water_target_ml": user.get("water_target_ml") or 2000,
        "totals": daily_totals,
        "macroTargets": user.get("macroTargets"),
        "meals": meals,
        "whoEvaluation": who_eval,
    }


def create_backup_snapshot(user_id: str, conn: sqlite3.Connection) -> None:
    try:
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        if not user_row:
            return
        meals = [dict(r) for r in conn.execute("SELECT * FROM meals WHERE user_id = ?", (user_id,)).fetchall()]
        weights = [dict(r) for r in conn.execute("SELECT * FROM weight_logs WHERE user_id = ?", (user_id,)).fetchall()]
        water = [dict(r) for r in conn.execute("SELECT * FROM daily_water WHERE user_id = ?", (user_id,)).fetchall()]
        payload = {
            "backupCreatedAt": datetime.now(timezone.utc).isoformat(),
            "user": dict(user_row),
            "mealsCount": len(meals),
            "meals": meals,
            "weights": weights,
            "water": water,
        }
        out_path = BACKUP_DIR / f"backup_{user_id}_{get_today_iso()}.json"
        out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


# ==============================================================================
# ENDPOINTS API REST
# ==============================================================================

@app.get("/api/health")
def api_health():
    with get_db() as conn:
        count = conn.execute("SELECT COUNT(*) as c FROM foods").fetchone()["c"]
    return {
        "status": "ok",
        "service": "NutriVital AI Python FastAPI Backend",
        "today": get_today_iso(),
        "foodsCatalogCount": count,
        "externalVisionConfigured": bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY")),
    }


@app.post("/api/metabolism/preview")
async def api_metabolism_preview(req: Request):
    body = await req.json()
    return calculate_metabolic_profile(body)


@app.post("/api/auth/register", status_code=201)
async def api_register(req: Request, response: Response):
    body = await req.json()
    email = str(body.get("email") or "").strip().lower()
    name = str(body.get("name") or "Usuario NutriVital").strip()
    password = str(body.get("password") or "Nutri2026!")

    if "@" not in email:
        raise HTTPException(status_code=400, detail="Introduce un correo electrónico válido.")
    if not body.get("gdpr_consent"):
        raise HTTPException(status_code=400, detail="Debes aceptar el consentimiento informado RGPD.")

    with get_db() as conn:
        if conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(status_code=409, detail="Ya existe una cuenta registrada con este correo.")

        calc = calculate_metabolic_profile(body)
        user_id = f"user_{int(datetime.now().timestamp())}_{secrets.token_hex(3)}"
        now_iso = datetime.now(timezone.utc).isoformat()
        today_iso = get_today_iso()

        conn.execute(
            """
            INSERT INTO users (
              id, email, password_hash, name, age, sex, height_cm, weight_kg, target_weight_kg,
              activity_level, work_activity, exercise_frequency, goal, special_conditions_json,
              bmi, bmr_kcal, tdee_kcal, daily_calorie_target, macro_targets_json,
              water_target_ml, reminders_json, gdpr_consent_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_id, email, hash_password(password), name,
                int(body.get("age") or 30), "male" if body.get("sex") == "male" else "female",
                float(body.get("height_cm") or 168), float(body.get("weight_kg") or 68),
                calc["targetWeightKg"], body.get("activity_level") or "moderate",
                body.get("work_activity") or "sedentary", body.get("exercise_frequency") or "3_4_days",
                body.get("goal") or "maintain", json.dumps(body.get("special_conditions") or {}),
                calc["bmi"], calc["bmrKcal"], calc["tdeeKcal"], calc["dailyCalorieTarget"],
                json.dumps(calc["macroTargets"]), calc["waterTargetMl"],
                json.dumps({"meals": True, "water": True, "breakfastTime": "08:30", "lunchTime": "14:00", "dinnerTime": "21:00"}),
                now_iso, now_iso,
            ),
        )
        conn.execute(
            "INSERT OR REPLACE INTO weight_logs (id, user_id, log_date, weight_kg, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (f"w_{int(datetime.now().timestamp())}", user_id, today_iso, float(body.get("weight_kg") or 68), "Peso inicial", now_iso),
        )
        conn.commit()
        token = create_session(user_id, conn)
        new_user = sanitize_user(conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone())
        response.set_cookie("nutrivital_token", token, httponly=True, samesite="lax", max_age=2592000)
        return {"token": token, "user": new_user}


@app.post("/api/auth/login")
async def api_login(req: Request, response: Response):
    body = await req.json()
    email = str(body.get("email") or "elena@nutrivital.es").strip().lower()
    password = str(body.get("password") or "Nutri2026!")

    with get_db() as conn:
        user_row = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if not user_row or user_row["password_hash"] != hash_password(password):
            raise HTTPException(status_code=401, detail="Credenciales incorrectas.")
        token = create_session(user_row["id"], conn)
        response.set_cookie("nutrivital_token", token, httponly=True, samesite="lax", max_age=2592000)
        return {"token": token, "user": sanitize_user(user_row)}


@app.post("/api/auth/logout")
def api_logout(req: Request, response: Response):
    token = req.cookies.get("nutrivital_token")
    if token:
        with get_db() as conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
    response.delete_cookie("nutrivital_token")
    return {"ok": True}


@app.get("/api/user/profile")
def api_get_profile(req: Request):
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        return {"user": user, "today": get_today_iso()}


@app.put("/api/user/profile")
async def api_update_profile(req: Request):
    body = await req.json()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")

        updated_input = {
            "age": int(body["age"]) if "age" in body else user["age"],
            "sex": body.get("sex") or user["sex"],
            "height_cm": float(body["height_cm"]) if "height_cm" in body else user["height_cm"],
            "weight_kg": float(body["weight_kg"]) if "weight_kg" in body else user["weight_kg"],
            "target_weight_kg": body.get("target_weight_kg") if "target_weight_kg" in body else user.get("target_weight_kg"),
            "activity_level": body.get("activity_level") or user["activity_level"],
            "work_activity": body.get("work_activity") or user["work_activity"],
            "exercise_frequency": body.get("exercise_frequency") or user["exercise_frequency"],
            "goal": body.get("goal") or user["goal"],
            "special_conditions": body.get("special_conditions") if "special_conditions" in body else user["special_conditions"],
        }
        calc = calculate_metabolic_profile(updated_input)
        reminders = body.get("reminders") if "reminders" in body else user["reminders"]
        name = str(body.get("name") or user["name"]).strip()

        conn.execute(
            """
            UPDATE users SET
              name = ?, age = ?, sex = ?, height_cm = ?, weight_kg = ?, target_weight_kg = ?,
              activity_level = ?, work_activity = ?, exercise_frequency = ?, goal = ?,
              special_conditions_json = ?, bmi = ?, bmr_kcal = ?, tdee_kcal = ?,
              daily_calorie_target = ?, macro_targets_json = ?, water_target_ml = ?, reminders_json = ?
            WHERE id = ?
            """,
            (
                name, updated_input["age"], updated_input["sex"], updated_input["height_cm"], updated_input["weight_kg"],
                calc["targetWeightKg"], updated_input["activity_level"], updated_input["work_activity"],
                updated_input["exercise_frequency"], updated_input["goal"], json.dumps(updated_input["special_conditions"]),
                calc["bmi"], calc["bmrKcal"], calc["tdeeKcal"], calc["dailyCalorieTarget"],
                json.dumps(calc["macroTargets"]), calc["waterTargetMl"], json.dumps(reminders), user["id"],
            ),
        )
        conn.commit()
        create_backup_snapshot(user["id"], conn)
        refreshed = sanitize_user(conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())
        return {"user": refreshed}


@app.get("/api/foods")
def api_get_foods(q: str = "", category: str = "", barcode: str = "", state: str = ""):
    with get_db() as conn:
        rows = get_all_foods(conn)
    if barcode:
        rows = [r for r in rows if r.get("barcode") == barcode]
    if category and category != "all":
        rows = [r for r in rows if r.get("category") == category]
    if state and state != "all":
        rows = [r for r in rows if r.get("preparation_state") == state]
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in r["name"].lower() or ql in r["category"].lower() or (r.get("barcode") and ql in r["barcode"])]
    return {"foods": rows}


@app.post("/api/foods", status_code=201)
async def api_create_food(req: Request):
    body = await req.json()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        if not body.get("name") or body.get("kcal_per_100g") is None:
            raise HTTPException(status_code=400, detail="Nombre y calorías son obligatorios.")
        fid = f"custom_{int(datetime.now().timestamp())}"
        cat = body.get("category") or "Personalizado"
        conn.execute(
            """
            INSERT INTO foods (
              id, name, category, preparation_state, paired_food_id,
              kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
              saturated_fat_per_100g, trans_fat_per_100g, fiber_per_100g,
              sugars_per_100g, free_sugars_per_100g, salt_g_per_100g,
              default_portion_g, source, source_code, barcode,
              is_who_fruit_veg, is_who_legume, is_who_whole_grain
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                fid, str(body["name"]).strip(), cat, body.get("preparation_state", "ready"), None,
                float(body.get("kcal_per_100g") or 0), float(body.get("protein_per_100g") or 0),
                float(body.get("carbs_per_100g") or 0), float(body.get("fat_per_100g") or 0),
                float(body.get("saturated_fat_per_100g") or 0), 0, float(body.get("fiber_per_100g") or 0),
                float(body.get("sugars_per_100g") or 0), float(body.get("free_sugars_per_100g") or 0),
                float(body.get("salt_g_per_100g") or 0), int(body.get("default_portion_g") or 100),
                "PERSONALIZADO", "USER-CUSTOM", body.get("barcode"),
                1 if cat in ("Frutas", "Verduras y hortalizas") else 0, 1 if cat == "Legumbres" else 0, 0,
            ),
        )
        conn.commit()
        created = dict(conn.execute("SELECT * FROM foods WHERE id = ?", (fid,)).fetchone())
        return {"food": created}


@app.post("/api/ai/analyze-food")
async def api_ai_analyze(req: Request):
    body = await req.json()
    with get_db() as conn:
        foods = get_all_foods(conn)
    return analyze_food_photograph(
        foods_list=foods,
        preset_id=body.get("presetId"),
        image_url=body.get("imageUrl"),
        image_base64=body.get("imageBase64"),
        user_hint=body.get("userHint") or "",
        visual_signature=body.get("visualSignature"),
        capture_hour=body.get("captureHour"),
    )


@app.post("/api/ai/recalculate-items")
async def api_recalculate_items(req: Request):
    body = await req.json()
    with get_db() as conn:
        return summarize_items_list(body.get("items") or [], conn)


@app.get("/api/day")
def api_get_day(req: Request, date: Optional[str] = None):
    date_str = date or get_today_iso()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        summary = build_day_summary(user, date_str, conn)
        fav_rows = conn.execute(
            "SELECT * FROM meals WHERE user_id = ? AND is_favorite = 1 ORDER BY created_at DESC LIMIT 12",
            (user["id"],),
        ).fetchall()
        favorites = [
            {
                "id": r["id"],
                "title": r["title"],
                "meal_type": r["meal_type"],
                "photo_url": r["photo_url"],
                "total_kcal": round(r["total_kcal"]),
                "total_protein_g": round(r["total_protein_g"], 1),
                "total_carbs_g": round(r["total_carbs_g"], 1),
                "total_fat_g": round(r["total_fat_g"], 1),
                "items": safe_parse_json(r["items_json"], []),
            }
            for r in fav_rows
        ]
        return {**summary, "favorites": favorites}


@app.post("/api/meals", status_code=201)
async def api_create_meal(req: Request):
    body = await req.json()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")

        meal_date = body.get("meal_date") or get_today_iso()
        now = datetime.now()
        meal_time = body.get("meal_time") or now.strftime("%H:%M")
        meal_type = body.get("meal_type") if body.get("meal_type") in ("breakfast", "mid_morning", "lunch", "snack", "dinner", "other") else "lunch"

        res_calc = summarize_items_list(body.get("items") or [], conn)
        items, totals = res_calc["items"], res_calc["totals"]
        if not items:
            raise HTTPException(status_code=400, detail="Añade al menos un alimento antes de guardar.")

        title = str(body.get("title") or ", ".join(i["name"].split("(")[0].strip() for i in items[:3])).strip()
        dedup_hash = hashlib.sha1(f"{user['id']}|{meal_date}|{meal_time}|{title}|{totals['total_kcal']}".encode()).hexdigest()
        meal_id = f"meal_{int(now.timestamp())}_{secrets.token_hex(3)}"

        conn.execute(
            """
            INSERT INTO meals (
              id, user_id, meal_date, meal_time, meal_type, title, photo_url, items_json,
              total_kcal, total_protein_g, total_carbs_g, total_fat_g, total_saturated_fat_g,
              total_fiber_g, total_sugars_g, total_free_sugars_g, total_salt_g, fruit_veg_grams,
              ai_confidence, ai_confidence_label, ai_notes, is_favorite, dedup_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                meal_id, user["id"], meal_date, meal_time, meal_type, title,
                body.get("photo_url") or "/assets/meals/pollo_arroz_ensalada.jpg",
                json.dumps(items), totals["total_kcal"], totals["total_protein_g"], totals["total_carbs_g"],
                totals["total_fat_g"], totals["total_saturated_fat_g"], totals["total_fiber_g"],
                totals["total_sugars_g"], totals["total_free_sugars_g"], totals["total_salt_g"],
                totals["fruit_veg_grams"], float(body.get("ai_confidence") or 0.92),
                body.get("ai_confidence_label") or "Confirmado",
                body.get("ai_notes") or "Cantidades verificadas por el usuario",
                1 if body.get("is_favorite") else 0, dedup_hash, datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        create_backup_snapshot(user["id"], conn)
        return {"mealId": meal_id, "daySummary": build_day_summary(user, meal_date, conn)}


@app.put("/api/meals/{meal_id}")
async def api_update_meal(meal_id: str, req: Request):
    body = await req.json()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        existing = conn.execute("SELECT * FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"])).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Comida no encontrada")

        items_in = body.get("items") if "items" in body else safe_parse_json(existing["items_json"], [])
        res_calc = summarize_items_list(items_in, conn)
        items, totals = res_calc["items"], res_calc["totals"]

        conn.execute(
            """
            UPDATE meals SET
              title = ?, meal_type = ?, meal_time = ?, items_json = ?,
              total_kcal = ?, total_protein_g = ?, total_carbs_g = ?, total_fat_g = ?,
              total_saturated_fat_g = ?, total_fiber_g = ?, total_sugars_g = ?,
              total_free_sugars_g = ?, total_salt_g = ?, fruit_veg_grams = ?, is_favorite = ?
            WHERE id = ? AND user_id = ?
            """,
            (
                str(body.get("title") or existing["title"]).strip(),
                body.get("meal_type") or existing["meal_type"],
                body.get("meal_time") or existing["meal_time"],
                json.dumps(items), totals["total_kcal"], totals["total_protein_g"], totals["total_carbs_g"],
                totals["total_fat_g"], totals["total_saturated_fat_g"], totals["total_fiber_g"],
                totals["total_sugars_g"], totals["total_free_sugars_g"], totals["total_salt_g"],
                totals["fruit_veg_grams"], 1 if body.get("is_favorite", existing["is_favorite"]) else 0,
                meal_id, user["id"],
            ),
        )
        conn.commit()
        return {"daySummary": build_day_summary(user, existing["meal_date"], conn)}


@app.delete("/api/meals/{meal_id}")
def api_delete_meal(meal_id: str, req: Request):
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        existing = conn.execute("SELECT meal_date FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"])).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="Comida no encontrada")
        conn.execute("DELETE FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"]))
        conn.commit()
        return {"daySummary": build_day_summary(user, existing["meal_date"], conn)}


@app.post("/api/meals/{meal_id}/repeat", status_code=201)
async def api_repeat_meal(meal_id: str, req: Request):
    body = await req.json()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        src = conn.execute("SELECT * FROM meals WHERE id = ? AND user_id = ?", (meal_id, user["id"])).fetchone()
        if not src:
            raise HTTPException(status_code=404, detail="Comida origen no encontrada")
        target_date = body.get("meal_date") or get_today_iso()
        now = datetime.now()
        new_id = f"meal_{int(now.timestamp())}_{secrets.token_hex(3)}"
        conn.execute(
            """
            INSERT INTO meals (
              id, user_id, meal_date, meal_time, meal_type, title, photo_url, items_json,
              total_kcal, total_protein_g, total_carbs_g, total_fat_g, total_saturated_fat_g,
              total_fiber_g, total_sugars_g, total_free_sugars_g, total_salt_g, fruit_veg_grams,
              ai_confidence, ai_confidence_label, ai_notes, is_favorite, dedup_hash, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                new_id, user["id"], target_date, body.get("meal_time") or now.strftime("%H:%M"),
                body.get("meal_type") or src["meal_type"], src["title"], src["photo_url"], src["items_json"],
                src["total_kcal"], src["total_protein_g"], src["total_carbs_g"], src["total_fat_g"],
                src["total_saturated_fat_g"], src["total_fiber_g"], src["total_sugars_g"],
                src["total_free_sugars_g"], src["total_salt_g"], src["fruit_veg_grams"],
                src["ai_confidence"], "Repetida", "Comida habitual repetida", src["is_favorite"],
                f"repeat_{new_id}", datetime.now(timezone.utc).isoformat(),
            ),
        )
        conn.commit()
        return {"mealId": new_id, "daySummary": build_day_summary(user, target_date, conn)}


@app.post("/api/water")
async def api_water(req: Request):
    body = await req.json()
    date_str = body.get("date") or get_today_iso()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        row = conn.execute("SELECT water_ml FROM daily_water WHERE user_id = ? AND log_date = ?", (user["id"], date_str)).fetchone()
        curr = row["water_ml"] if row else 0
        if "delta_ml" in body:
            nxt = max(0, min(8000, curr + int(body["delta_ml"])))
        else:
            nxt = max(0, min(8000, int(body.get("water_ml", curr))))
        conn.execute(
            "INSERT OR REPLACE INTO daily_water (user_id, log_date, water_ml, updated_at) VALUES (?, ?, ?, ?)",
            (user["id"], date_str, nxt, datetime.now(timezone.utc).isoformat()),
        )
        conn.commit()
        return {"water_ml": nxt, "daySummary": build_day_summary(user, date_str, conn)}


@app.post("/api/weight")
async def api_weight(req: Request):
    body = await req.json()
    weight_kg = float(body.get("weight_kg") or 0)
    if weight_kg < 25 or weight_kg > 300:
        raise HTTPException(status_code=400, detail="Peso inválido (25-300 kg).")
    log_date = body.get("log_date") or get_today_iso()
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        conn.execute(
            "INSERT OR REPLACE INTO weight_logs (id, user_id, log_date, weight_kg, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (f"w_{user['id']}_{log_date}", user["id"], log_date, weight_kg, body.get("note") or "Registro periódico", datetime.now(timezone.utc).isoformat()),
        )
        if log_date == get_today_iso():
            calc = calculate_metabolic_profile({**user, "weight_kg": weight_kg})
            conn.execute(
                "UPDATE users SET weight_kg = ?, bmi = ?, bmr_kcal = ?, tdee_kcal = ?, daily_calorie_target = ?, macro_targets_json = ?, water_target_ml = ? WHERE id = ?",
                (weight_kg, calc["bmi"], calc["bmrKcal"], calc["tdeeKcal"], calc["dailyCalorieTarget"], json.dumps(calc["macroTargets"]), calc["waterTargetMl"], user["id"]),
            )
        conn.commit()
        weights = [dict(r) for r in conn.execute("SELECT log_date, weight_kg, note FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC", (user["id"],)).fetchall()]
        updated_user = sanitize_user(conn.execute("SELECT * FROM users WHERE id = ?", (user["id"],)).fetchone())
        return {"weights": weights, "user": updated_user}


@app.get("/api/stats")
def api_stats(req: Request, days: int = 7):
    days = min(90, max(7, int(days)))
    today_iso = get_today_iso()
    start_date = shift_date_iso(today_iso, -(days - 1))
    prev_start = shift_date_iso(start_date, -days)

    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        agg_rows = conn.execute(
            """
            SELECT meal_date, SUM(total_kcal) AS kcal, SUM(total_protein_g) AS protein_g,
                   SUM(total_carbs_g) AS carbs_g, SUM(total_fat_g) AS fat_g,
                   SUM(total_fiber_g) AS fiber_g, SUM(fruit_veg_grams) AS fruit_veg_g,
                   COUNT(*) AS meals_count
            FROM meals WHERE user_id = ? AND meal_date >= ? AND meal_date <= ?
            GROUP BY meal_date ORDER BY meal_date ASC
            """,
            (user["id"], start_date, today_iso),
        ).fetchall()
        prev_row = conn.execute(
            "SELECT AVG(daily_kcal) as avg_kcal FROM (SELECT meal_date, SUM(total_kcal) as daily_kcal FROM meals WHERE user_id = ? AND meal_date >= ? AND meal_date < ? GROUP BY meal_date)",
            (user["id"], prev_start, start_date),
        ).fetchone()
        water_rows = conn.execute("SELECT log_date, water_ml FROM daily_water WHERE user_id = ? AND log_date >= ? AND log_date <= ?", (user["id"], start_date, today_iso)).fetchall()
        weights = [dict(r) for r in conn.execute("SELECT log_date, weight_kg, note FROM weight_logs WHERE user_id = ? AND log_date >= ? ORDER BY log_date ASC", (user["id"], start_date)).fetchall()]

    agg_map = {r["meal_date"]: dict(r) for r in agg_rows}
    water_map = {r["log_date"]: r["water_ml"] for r in water_rows}
    target_kcal = user.get("daily_calorie_target") or 2000

    series = []
    tot_k = tot_p = tot_c = tot_f = tot_fib = tot_fv = 0.0
    active_days = compliant_days = 0

    for i in range(days - 1, -1, -1):
        d_str = shift_date_iso(today_iso, -i)
        row = agg_map.get(d_str)
        kcal = round(row["kcal"]) if row else 0
        p = round(row["protein_g"], 1) if row else 0
        c = round(row["carbs_g"], 1) if row else 0
        f = round(row["fat_g"], 1) if row else 0
        fib = round(row["fiber_g"] or 0, 1) if row else 0
        fv = round(row["fruit_veg_g"] or 0) if row else 0
        within = kcal > 0 and abs(kcal - target_kcal) <= target_kcal * 0.12
        if kcal > 0:
            active_days += 1
            tot_k += kcal
            tot_p += p
            tot_c += c
            tot_f += f
            tot_fib += fib
            tot_fv += fv
            if within:
                compliant_days += 1
        series.append({
            "date": d_str, "kcal": kcal, "target_kcal": target_kcal,
            "balance_kcal": kcal - target_kcal if kcal > 0 else 0,
            "protein_g": p, "carbs_g": c, "fat_g": f, "fiber_g": fib,
            "fruit_veg_g": fv, "meals_count": row["meals_count"] if row else 0,
            "water_ml": water_map.get(d_str, 0), "within_target": within,
        })

    div = max(1, active_days)
    avg_kcal = round(tot_k / div)
    prev_avg = round(prev_row["avg_kcal"]) if prev_row and prev_row["avg_kcal"] else avg_kcal
    avg_p, avg_c, avg_f = round(tot_p / div, 1), round(tot_c / div, 1), round(tot_f / div, 1)
    m_sum = max(1.0, avg_p * 4 + avg_c * 4 + avg_f * 9)

    return {
        "days": days, "startDate": start_date, "endDate": today_iso,
        "summary": {
            "activeDays": active_days, "avgKcal": avg_kcal, "prevAvgKcal": prev_avg,
            "kcalDeltaVsPrev": avg_kcal - prev_avg, "targetKcal": target_kcal,
            "avgDailyBalance": avg_kcal - target_kcal,
            "compliancePct": round((compliant_days / div) * 100),
            "avgProtein": avg_p, "avgCarbs": avg_c, "avgFat": avg_f,
            "avgFiber": round(tot_fib / div, 1), "avgFruitVeg": round(tot_fv / div),
            "macroDistribution": {
                "proteinPct": round(((avg_p * 4) / m_sum) * 100),
                "carbsPct": round(((avg_c * 4) / m_sum) * 100),
                "fatPct": round(((avg_f * 9) / m_sum) * 100),
            },
        },
        "series": series, "weights": weights,
    }


@app.get("/api/export")
def api_export(req: Request, format: str = "json"):
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        meals = [dict(r) for r in conn.execute("SELECT * FROM meals WHERE user_id = ? ORDER BY meal_date DESC", (user["id"],)).fetchall()]
        weights = [dict(r) for r in conn.execute("SELECT * FROM weight_logs WHERE user_id = ? ORDER BY log_date DESC", (user["id"],)).fetchall()]

    if format.lower() == "csv":
        header = "Fecha,Hora,Tipo,Comida,Calorias_kcal,Proteinas_g,Hidratos_g,Grasas_g,Fibra_g,Sal_g\n"
        lines = [
            f"{m['meal_date']},{m['meal_time']},{m['meal_type']},\"{m['title']}\",{round(m['total_kcal'])},{m['total_protein_g']},{m['total_carbs_g']},{m['total_fat_g']},{m['total_fiber_g']},{m['total_salt_g']}"
            for m in meals
        ]
        return PlainTextResponse(
            "\ufeff" + header + "\n".join(lines),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="nutrivital_historial_{get_today_iso()}.csv"'},
        )
    return JSONResponse(
        {"exportedAt": datetime.now(timezone.utc).isoformat(), "gdprNotice": "Art. 20 RGPD", "user": user, "meals": meals, "weights": weights},
        headers={"Content-Disposition": f'attachment; filename="nutrivital_datos_rgpd_{get_today_iso()}.json"'},
    )


@app.delete("/api/user/account")
def api_delete_account(req: Request, response: Response):
    with get_db() as conn:
        user = get_authenticated_user(req, conn)
        if not user:
            raise HTTPException(status_code=401, detail="Sesión no iniciada")
        conn.execute("DELETE FROM meals WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM daily_water WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM weight_logs WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM sessions WHERE user_id = ?", (user["id"],))
        conn.execute("DELETE FROM users WHERE id = ?", (user["id"],))
        conn.commit()
    response.delete_cookie("nutrivital_token")
    return {"deleted": True, "message": "Todos tus datos personales han sido eliminados conforme al RGPD."}


# Servir archivos estáticos del frontend SPA + PWA
@app.get("/")
def serve_index():
    return FileResponse(str(PUBLIC_DIR / "index.html"))


app.mount("/", StaticFiles(directory=str(PUBLIC_DIR), html=True), name="static")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 3000))
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False)
