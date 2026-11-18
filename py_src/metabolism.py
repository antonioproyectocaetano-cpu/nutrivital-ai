"""
MOTOR DE CÁLCULO DE NECESIDADES CALÓRICAS Y RECOMENDACIONES OMS (PYTHON)
Basado en ecuaciones metabólicas clínicas validadas (Mifflin-St Jeor, 1990)
y en las directrices nutricionales oficiales de la Organización Mundial de la Salud (OMS).
"""

import json
from typing import Any, Dict, List

ACTIVITY_FACTORS = {
    "sedentary": {"factor": 1.2, "label": "Sedentario", "description": "Poca o ninguna actividad física diaria"},
    "light": {"factor": 1.375, "label": "Ligero", "description": "Actividad física ocasional (1 a 2 días por semana)"},
    "moderate": {"factor": 1.55, "label": "Moderado", "description": "Ejercicio moderado entre 3 y 5 días por semana"},
    "high": {"factor": 1.725, "label": "Alto", "description": "Ejercicio intenso y frecuente (6 a 7 días por semana)"},
    "very_high": {"factor": 1.9, "label": "Muy alto", "description": "Actividad física o trabajo físico muy exigente"},
}

WORK_ADJUSTMENTS = {
    "sedentary": 0.0,
    "standing": 0.04,
    "walking": 0.08,
    "heavy": 0.14,
}

EXERCISE_ADJUSTMENTS = {
    "none": -0.02,
    "1_2_days": 0.0,
    "3_4_days": 0.03,
    "5_6_days": 0.06,
    "daily": 0.09,
}

GOAL_LABELS = {
    "maintain": "Mantener mi peso actual",
    "lose": "Perder peso de forma progresiva",
    "gain": "Ganar peso",
    "improve_habits": "Mejorar mis hábitos alimenticios",
}


def calculate_metabolic_profile(data: Dict[str, Any]) -> Dict[str, Any]:
    age = max(10, min(110, int(float(data.get("age") or 30))))
    sex = "male" if data.get("sex") == "male" else "female"
    height_cm = max(100.0, min(240.0, float(data.get("height_cm") or 168)))
    weight_kg = max(25.0, min(300.0, float(data.get("weight_kg") or 68)))

    activity_level = data.get("activity_level") if data.get("activity_level") in ACTIVITY_FACTORS else "moderate"
    work_activity = data.get("work_activity") if data.get("work_activity") in WORK_ADJUSTMENTS else "sedentary"
    exercise_frequency = data.get("exercise_frequency") if data.get("exercise_frequency") in EXERCISE_ADJUSTMENTS else "3_4_days"
    goal = data.get("goal") if data.get("goal") in GOAL_LABELS else "maintain"

    special = data.get("special_conditions") or {}
    if isinstance(special, str):
        try:
            special = json.loads(special)
        except Exception:
            special = {}

    is_minor = age < 18 or bool(special.get("minor"))
    is_pregnant = bool(special.get("pregnancy"))
    is_lactating = bool(special.get("lactation"))
    has_eating_disorder = bool(special.get("eating_disorder"))
    has_medical_condition = bool(special.get("medical_condition"))
    requires_clinical_protection = is_minor or is_pregnant or is_lactating or has_eating_disorder or has_medical_condition

    # 1. IMC
    height_m = height_cm / 100.0
    bmi = round(weight_kg / (height_m * height_m), 1)
    if bmi < 18.5:
        bmi_category = "Bajo peso"
    elif bmi < 25:
        bmi_category = "Peso saludable (Normopeso)"
    elif bmi < 30:
        bmi_category = "Sobrepeso"
    elif bmi < 35:
        bmi_category = "Obesidad grado I"
    else:
        bmi_category = "Obesidad grado II+"

    healthy_min = round(18.5 * height_m * height_m, 1)
    healthy_max = round(24.9 * height_m * height_m, 1)
    healthy_mid = round(21.7 * height_m * height_m, 1)

    raw_target_w = data.get("target_weight_kg")
    target_weight_kg = float(raw_target_w) if raw_target_w not in (None, "", 0) else None
    if target_weight_kg is None:
        if goal == "lose" and weight_kg > healthy_mid:
            target_weight_kg = round(max(healthy_mid, weight_kg - 4.0), 1)
        elif goal == "gain" and weight_kg < healthy_mid:
            target_weight_kg = round(min(healthy_mid, weight_kg + 3.0), 1)
        else:
            target_weight_kg = weight_kg

    # 2. TMB — Ecuación validada de Mifflin-St Jeor (1990)
    bmr_raw = (10 * weight_kg) + (6.25 * height_cm) - (5 * age) + (5 if sex == "male" else -161)
    bmr_kcal = round(bmr_raw)

    # 3. GET / TDEE
    base_factor = ACTIVITY_FACTORS[activity_level]["factor"]
    work_mod = WORK_ADJUSTMENTS.get(work_activity, 0.0)
    ex_mod = EXERCISE_ADJUSTMENTS.get(exercise_frequency, 0.0)
    effective_factor = round(min(2.1, max(1.2, base_factor + (work_mod * 0.5) + (ex_mod * 0.4))), 3)
    tdee_kcal = round(bmr_kcal * effective_factor)

    # 4. Objetivo Calórico Diario con límites de seguridad clínica
    min_safe_floor = 1500 if sex == "male" else 1200
    safety_floor = max(min_safe_floor, bmr_kcal)
    warnings: List[str] = []
    applied_delta = 0
    daily_calorie_target = tdee_kcal

    if requires_clinical_protection:
        if is_pregnant:
            applied_delta = 300
            daily_calorie_target = tdee_kcal + 300
            warnings.append("Perfil de embarazo activo: se ha desactivado cualquier déficit calórico y se recomienda seguimiento obstétrico y nutricional profesional.")
        elif is_lactating:
            applied_delta = 450
            daily_calorie_target = tdee_kcal + 450
            warnings.append("Perfil de lactancia activo: se prioriza cubrir el gasto energético aumentado sin restricciones calóricas.")
        elif has_eating_disorder:
            daily_calorie_target = max(tdee_kcal, safety_floor)
            warnings.append("Modo de bienestar no restrictivo activado: por precaución ante TCA, no se aplican déficits calóricos. Prioriza el acompañamiento profesional.")
        elif is_minor:
            daily_calorie_target = max(tdee_kcal, safety_floor)
            warnings.append("Usuario menor de 18 años: en etapa de crecimiento no se generan objetivos calóricos restrictivos sin supervisión pediátrica.")
        elif has_medical_condition:
            daily_calorie_target = max(tdee_kcal, safety_floor)
            warnings.append("Condición médica indicada: el objetivo se mantiene en equilibrio energético orientativo. Consulta siempre con tu especialista.")
    elif goal == "lose":
        if bmi < 19.0:
            daily_calorie_target = tdee_kcal
            warnings.append("Tu IMC actual ya se encuentra en el límite inferior del rango saludable; se establece mantenimiento en lugar de déficit.")
        else:
            prudent_deficit = min(500, max(300, round(tdee_kcal * 0.16)))
            daily_calorie_target = max(safety_floor, tdee_kcal - prudent_deficit)
            applied_delta = daily_calorie_target - tdee_kcal
            if daily_calorie_target == safety_floor:
                warnings.append(f"El objetivo se ha ajustado al límite prudente de seguridad ({safety_floor} kcal/día) para proteger tu metabolismo basal.")
    elif goal == "gain":
        prudent_surplus = min(450, max(280, round(tdee_kcal * 0.14)))
        daily_calorie_target = tdee_kcal + prudent_surplus
        applied_delta = prudent_surplus
    else:
        daily_calorie_target = tdee_kcal

    # 5. Macronutrientes y límites OMS
    protein_ratio = 0.25 if goal in ("lose", "gain") else 0.20
    fat_ratio = 0.30
    carbs_ratio = round(1.0 - protein_ratio - fat_ratio, 2)

    protein_grams = round((daily_calorie_target * protein_ratio) / 4)
    carbs_grams = round((daily_calorie_target * carbs_ratio) / 4)
    fat_grams = round((daily_calorie_target * fat_ratio) / 9)

    who_limits = {
        "freeSugarsMax10PctGrams": round((daily_calorie_target * 0.10) / 4),
        "freeSugarsIdeal5PctGrams": round((daily_calorie_target * 0.05) / 4),
        "saturatedFatMaxGrams": round((daily_calorie_target * 0.10) / 9),
        "transFatMaxGrams": round((daily_calorie_target * 0.01) / 9, 1),
        "fruitVegMinGrams": 400,
        "fiberMinGrams": 25,
        "saltMaxGrams": 5.0,
    }

    water_target_ml = round((weight_kg * 35 + (400 if effective_factor > 1.5 else 0)) / 50) * 50

    return {
        "bmi": bmi,
        "bmiCategory": bmi_category,
        "healthyWeightRange": {"min": healthy_min, "max": healthy_max, "ideal": healthy_mid},
        "targetWeightKg": target_weight_kg,
        "bmrKcal": bmr_kcal,
        "tdeeKcal": tdee_kcal,
        "effectiveActivityFactor": effective_factor,
        "dailyCalorieTarget": daily_calorie_target,
        "appliedDelta": applied_delta,
        "safetyFloor": safety_floor,
        "requiresClinicalProtection": requires_clinical_protection,
        "warnings": warnings,
        "macroTargets": {
            "proteinGrams": protein_grams,
            "carbsGrams": carbs_grams,
            "fatGrams": fat_grams,
            "proteinPct": round(protein_ratio * 100),
            "carbsPct": round(carbs_ratio * 100),
            "fatPct": round(fat_ratio * 100),
            **who_limits,
        },
        "waterTargetMl": water_target_ml,
        "methodologyNote": (
            "Estimación calculada mediante la ecuación clínica de Mifflin-St Jeor (1990) combinada con factores de actividad física. "
            "Los objetivos de calidad nutricional (azúcares libres <10%, grasas saturadas <10%, sal <5g/día y ≥400g de frutas y hortalizas) "
            "siguen las directrices oficiales de la Organización Mundial de la Salud (OMS)."
        ),
    }


def generate_who_evaluation(daily_totals: Dict[str, Any], user_profile: Dict[str, Any]) -> Dict[str, Any]:
    raw_mt = user_profile.get("macro_targets_json") or user_profile.get("macroTargets") or "{}"
    macro_targets = json.loads(raw_mt) if isinstance(raw_mt, str) else raw_mt

    target_kcal = user_profile.get("daily_calorie_target") or 2000
    max_free_sugars = macro_targets.get("freeSugarsMax10PctGrams") or round((target_kcal * 0.10) / 4)
    ideal_free_sugars = macro_targets.get("freeSugarsIdeal5PctGrams") or round((target_kcal * 0.05) / 4)
    max_sat_fat = macro_targets.get("saturatedFatMaxGrams") or round((target_kcal * 0.10) / 9)
    min_fiber = macro_targets.get("fiberMinGrams") or 25
    min_fruit_veg = macro_targets.get("fruitVegMinGrams") or 400
    max_salt = macro_targets.get("saltMaxGrams") or 5.0

    consumed_kcal = daily_totals.get("total_kcal") or 0
    fruit_veg_grams = daily_totals.get("fruit_veg_grams") or 0
    fiber_grams = daily_totals.get("total_fiber_g") or 0
    free_sugars_grams = daily_totals.get("total_free_sugars_g") or 0
    sat_fat_grams = daily_totals.get("total_saturated_fat_g") or 0
    salt_grams = daily_totals.get("total_salt_g") or 0
    protein_grams = daily_totals.get("total_protein_g") or 0
    water_ml = daily_totals.get("water_ml") or 0
    water_target_ml = user_profile.get("water_target_ml") or 2000
    meals_count = daily_totals.get("meals_count") or 0

    tips = []
    if meals_count == 0:
        tips.append({
            "type": "info",
            "icon": "camera",
            "title": "Comienza tu registro de hoy",
            "message": "Pulsa «FOTOGRAFIAR MI COMIDA» para analizar tu primer plato o regístralo desde el buscador BEDCA/USDA.",
        })
    else:
        if fruit_veg_grams == 0:
            tips.append({
                "type": "warning",
                "icon": "apple",
                "title": "Frutas y verduras pendientes hoy",
                "message": "Hoy todavía no has registrado ninguna ración de fruta ni verdura. La OMS recomienda alcanzar al menos 400 g diarios (unas 5 raciones).",
            })
        elif fruit_veg_grams < 250:
            tips.append({
                "type": "info",
                "icon": "salad",
                "title": f"Llevas {round(fruit_veg_grams)} g de frutas y verduras",
                "message": "Vas por buen camino. Añadir una guarnición de verdura o una pieza de fruta en tu próxima comida te acercará a los 400 g/día recomendados por la OMS.",
            })
        elif fruit_veg_grams >= 400:
            tips.append({
                "type": "positive",
                "icon": "check",
                "title": "Objetivo OMS de frutas y verduras cumplido",
                "message": f"¡Excelente! Has alcanzado {round(fruit_veg_grams)} g de frutas y hortalizas frescas hoy, superando el mínimo de 400 g/día de la OMS.",
            })

        if consumed_kcal > 800 and fiber_grams < 12:
            tips.append({
                "type": "warning",
                "icon": "grain",
                "title": "Alimentación de hoy baja en fibra",
                "message": f"Llevas {fiber_grams:.1f} g de fibra (recomendación OMS: ≥{min_fiber} g/día). Priorizar legumbres, cereales integrales o fruta entera mejorará tu saciedad.",
            })
        elif fiber_grams >= min_fiber:
            tips.append({
                "type": "positive",
                "icon": "grain",
                "title": "Óptimo aporte de fibra dietética",
                "message": f"Has registrado {fiber_grams:.1f} g de fibra hoy, favoreciendo la salud digestiva y el control glucémico.",
            })

        if free_sugars_grams > max_free_sugars:
            tips.append({
                "type": "alert",
                "icon": "sugar",
                "title": "Atención al consumo de azúcares libres",
                "message": f"Has registrado {free_sugars_grams:.1f} g de azúcares libres (límite orientativo OMS <10%: {max_free_sugars} g). Prioriza agua, lácteos naturales y fruta entera.",
            })
        elif free_sugars_grams <= ideal_free_sugars:
            tips.append({
                "type": "positive",
                "icon": "sparkle",
                "title": "Azúcares libres bajo el umbral óptimo (<5%)",
                "message": f"Mantienes los azúcares libres en {free_sugars_grams:.1f} g, cumpliendo la recomendación condicional más exigente de la OMS (<{ideal_free_sugars} g/día).",
            })

        if sat_fat_grams > max_sat_fat:
            tips.append({
                "type": "warning",
                "icon": "heart",
                "title": "Cantidad elevada de grasas saturadas",
                "message": f"Hoy llevas {sat_fat_grams:.1f} g de grasas saturadas (límite orientativo OMS: {max_sat_fat} g). Equilibra con aceite de oliva virgen extra, pescado o proteínas magras.",
            })

        if salt_grams > max_salt:
            tips.append({
                "type": "warning",
                "icon": "salt",
                "title": "Vigilancia del consumo de sal",
                "message": f"Has superado los {max_salt} g de sal diarios recomendados por la OMS ({salt_grams:.1f} g). Usa especias y hierbas aromáticas.",
            })

        target_protein = macro_targets.get("proteinGrams") or 100
        if consumed_kcal > target_kcal * 0.45 and protein_grams < target_protein * 0.4:
            tips.append({
                "type": "info",
                "icon": "protein",
                "title": "Sugerencia para tu próxima comida",
                "message": "Puedes completar tu próxima comida con una fuente saludable de proteínas (legumbres, pescado, huevo o ave) acompañada de verduras.",
            })

    if water_ml < water_target_ml * 0.4:
        tips.append({
            "type": "info",
            "icon": "water",
            "title": "Recuerda mantener una hidratación adecuada",
            "message": f"Llevas {water_ml} ml de agua registrados hoy de tu meta orientativa de {water_target_ml} ml.",
        })

    indicators = [
        {
            "id": "fruit_veg",
            "label": "Frutas y hortalizas (OMS ≥ 400 g)",
            "current": round(fruit_veg_grams),
            "target": min_fruit_veg,
            "unit": "g",
            "mode": "min",
            "status": "optimal" if fruit_veg_grams >= min_fruit_veg else ("moderate" if fruit_veg_grams >= 200 else "low"),
        },
        {
            "id": "fiber",
            "label": "Fibra dietética (OMS ≥ 25 g)",
            "current": round(fiber_grams, 1),
            "target": min_fiber,
            "unit": "g",
            "mode": "min",
            "status": "optimal" if fiber_grams >= min_fiber else ("moderate" if fiber_grams >= 14 else "low"),
        },
        {
            "id": "free_sugars",
            "label": f"Azúcares libres (OMS < 10% / {max_free_sugars} g)",
            "current": round(free_sugars_grams, 1),
            "target": max_free_sugars,
            "ideal": ideal_free_sugars,
            "unit": "g",
            "mode": "max",
            "status": "optimal" if free_sugars_grams <= ideal_free_sugars else ("moderate" if free_sugars_grams <= max_free_sugars else "high"),
        },
        {
            "id": "saturated_fat",
            "label": f"Grasas saturadas (OMS < 10% / {max_sat_fat} g)",
            "current": round(sat_fat_grams, 1),
            "target": max_sat_fat,
            "unit": "g",
            "mode": "max",
            "status": "optimal" if sat_fat_grams <= max_sat_fat * 0.8 else ("moderate" if sat_fat_grams <= max_sat_fat else "high"),
        },
        {
            "id": "salt",
            "label": "Sal equivalente (OMS < 5 g/día)",
            "current": round(salt_grams, 1),
            "target": max_salt,
            "unit": "g",
            "mode": "max",
            "status": "optimal" if salt_grams <= 3.8 else ("moderate" if salt_grams <= max_salt else "high"),
        },
    ]

    return {
        "tips": tips,
        "indicators": indicators,
        "qualitativeBadges": {
            "hasLegumes": bool(daily_totals.get("has_legumes")),
            "hasWholeGrains": bool(daily_totals.get("has_whole_grains")),
            "fruitVegPortions": round(fruit_veg_grams / 80.0, 1),
        },
    }
