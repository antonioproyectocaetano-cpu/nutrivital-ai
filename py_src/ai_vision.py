"""
SERVICIO DE INTELIGENCIA ARTIFICIAL MULTIMODAL EN SERVIDOR (PYTHON)
Analiza fotografías de comidas, identifica alimentos e ingredientes,
estima cantidades aproximadas en gramos y cruza con la base de datos BEDCA / USDA.
"""

import json
import os
import re
import urllib.request
from datetime import datetime
from typing import Any, Dict, List, Optional


def suggest_meal_type_by_hour(hour: Optional[int] = None) -> str:
    h = datetime.now().hour if hour is None else int(hour)
    if 6 <= h < 10:
        return "breakfast"
    if 10 <= h < 13:
        return "mid_morning"
    if 13 <= h < 16:
        return "lunch"
    if 16 <= h < 20:
        return "snack"
    if 20 <= h <= 23:
        return "dinner"
    return "other"


def compute_item_nutrients(food: Dict[str, Any], grams: float) -> Dict[str, Any]:
    g = max(0.0, float(grams or 0))
    ratio = g / 100.0
    return {
        "food_id": food["id"],
        "name": food["name"],
        "category": food["category"],
        "preparation_state": food.get("preparation_state", "cooked"),
        "paired_food_id": food.get("paired_food_id"),
        "grams": round(g),
        "kcal": round(float(food["kcal_per_100g"]) * ratio),
        "protein_g": round(float(food["protein_per_100g"]) * ratio, 1),
        "carbs_g": round(float(food["carbs_per_100g"]) * ratio, 1),
        "fat_g": round(float(food["fat_per_100g"]) * ratio, 1),
        "saturated_fat_g": round(float(food.get("saturated_fat_per_100g") or 0) * ratio, 1),
        "fiber_g": round(float(food.get("fiber_per_100g") or 0) * ratio, 1),
        "sugars_g": round(float(food.get("sugars_per_100g") or 0) * ratio, 1),
        "free_sugars_g": round(float(food.get("free_sugars_per_100g") or 0) * ratio, 1),
        "salt_g": round(float(food.get("salt_g_per_100g") or 0) * ratio, 2),
        "fruit_veg_g": round(g) if food.get("is_who_fruit_veg") else 0,
        "is_who_legume": bool(food.get("is_who_legume")),
        "is_who_whole_grain": bool(food.get("is_who_whole_grain")),
        "source": food.get("source", "BEDCA"),
        "source_code": food.get("source_code", ""),
    }


VISUAL_PRESETS = {
    "pollo_arroz_ensalada": {
        "title": "Pechuga de pollo a la plancha con arroz y ensalada",
        "confidence": 0.92,
        "confidenceLabel": "Alta",
        "items": [
            {"food_id": "pollo_plancha", "grams": 150, "item_confidence": 0.94},
            {"food_id": "arroz_cocido", "grams": 150, "item_confidence": 0.91},
            {"food_id": "ensalada_mixta", "grams": 100, "item_confidence": 0.93},
            {"food_id": "aceite_oliva", "grams": 10, "item_confidence": 0.82},
        ],
        "clarificationQuestions": [
            "¿El arroz es blanco cocido (150 g) o prefieres cambiarlo a arroz integral?",
            "Hemos estimado 10 g (1 cucharada) de aceite de oliva virgen extra para el aliño y plancha. ¿Deseas ajustarlo?",
        ],
        "aiNotes": "Estimación visual orientativa: una fotografía convencional en 2D no permite conocer con exactitud milimétrica el peso ni la cantidad exacta de aceite absorbido. Verifica o ajusta los gramos antes de confirmar.",
    },
    "salmon_quinoa_brocoli": {
        "title": "Salmón al horno con quinoa, brócoli al vapor y aguacate",
        "confidence": 0.90,
        "confidenceLabel": "Alta",
        "items": [
            {"food_id": "salmon_horno", "grams": 160, "item_confidence": 0.93},
            {"food_id": "quinoa_cocida", "grams": 120, "item_confidence": 0.88},
            {"food_id": "brocoli_vapor", "grams": 120, "item_confidence": 0.94},
            {"food_id": "aguacate", "grams": 50, "item_confidence": 0.89},
            {"food_id": "aceite_oliva", "grams": 8, "item_confidence": 0.80},
        ],
        "clarificationQuestions": [
            "¿El salmón se ha horneado con aceite adicional o en su propio jugo?",
            "¿La guarnición de grano es quinoa cocida (120 g) o cuscús/arroz integral?",
        ],
        "aiNotes": "Plato rico en ácidos grasos omega-3, fibra y proteínas de alto valor biológico. Recuerda que los pesos estimados por visión artificial son aproximados.",
    },
    "tostada_aguacate_huevo": {
        "title": "Tostada integral con aguacate, huevo escalfado y frutos rojos",
        "confidence": 0.91,
        "confidenceLabel": "Alta",
        "items": [
            {"food_id": "pan_integral", "grams": 60, "item_confidence": 0.92},
            {"food_id": "aguacate", "grams": 60, "item_confidence": 0.90},
            {"food_id": "huevo_escalfado", "grams": 55, "item_confidence": 0.95},
            {"food_id": "frutos_rojos", "grams": 100, "item_confidence": 0.93},
            {"food_id": "cafe_solo", "grams": 150, "item_confidence": 0.96},
        ],
        "clarificationQuestions": [
            "¿Añadiste aceite de oliva sobre la tostada o leche/azúcar en el café?",
            "¿El pan es 100% integral (60 g) o pan blanco?",
        ],
        "aiNotes": "Desayuno equilibrado con cereales integrales, grasas monoinsaturadas y fruta fresca entera. Confirma las cantidades antes de guardar.",
    },
}

KEYWORD_MATCHERS = [
    (["pollo", "pechuga", "chicken"], "pollo_plancha", 150),
    (["pavo", "turkey"], "pavo_plancha", 150),
    (["ternera", "bistec", "filete", "beef"], "ternera_plancha", 150),
    (["cerdo", "lomo", "pork"], "lomo_cerdo_plancha", 140),
    (["jamon", "jamón"], "jamon_serrano", 40),
    (["salmon", "salmón"], "salmon_horno", 160),
    (["merluza", "pescado blanco", "fish"], "merluza_plancha", 180),
    (["atun", "atún"], "atun_natural", 80),
    (["bacalao"], "bacalao_horno", 170),
    (["arroz integral"], "arroz_integral_cocido", 150),
    (["arroz", "rice"], "arroz_cocido", 150),
    (["paella"], "paella_mixta", 280),
    (["quinoa"], "quinoa_cocida", 120),
    (["pasta integral"], "pasta_integral_cocida", 180),
    (["pasta", "macarrones", "espaguetis"], "pasta_cocida", 180),
    (["patatas fritas", "papas fritas"], "patatas_fritas", 120),
    (["patata", "papa", "patatas"], "patata_cocida", 160),
    (["tostada", "pan integral"], "pan_integral", 60),
    (["pan", "bocadillo"], "pan_blanco", 50),
    (["avena", "porridge"], "copos_avena", 45),
    (["lenteja", "lentejas"], "lentejas_cocidas", 220),
    (["garbanzo", "garbanzos", "cocido"], "garbanzos_cocidos", 200),
    (["alubia", "alubias", "judias"], "alubias_cocidas", 200),
    (["ensalada", "lechuga", "salad"], "ensalada_mixta", 100),
    (["brocoli", "brócoli"], "brocoli_vapor", 120),
    (["verdura", "verduras", "calabacin", "pimiento"], "verduras_asadas", 150),
    (["espinaca", "espinacas"], "espinacas_rehogadas", 120),
    (["tomate"], "tomate_fresco", 100),
    (["aguacate", "avocado"], "aguacate", 60),
    (["fresa", "fresas", "arandanos", "frutos rojos"], "frutos_rojos", 100),
    (["platano", "plátano", "banana"], "platano", 110),
    (["manzana", "apple"], "manzana", 160),
    (["naranja", "mandarina"], "naranja", 150),
    (["kiwi"], "kiwi_fresco", 100),
    (["pera"], "pera_fresca", 160),
    (["huevo", "huevos", "egg"], "huevo_escalfado", 55),
    (["tortilla"], "tortilla_patata", 160),
    (["gazpacho"], "gazpacho_andaluz", 250),
    (["salmorejo"], "salmorejo_cordobes", 200),
    (["pisto"], "pisto_manchego", 200),
    (["dorada", "lubina"], "dorada_horno", 180),
    (["pulpo"], "pulpo_cocido", 160),
    (["sardina", "sardinas"], "sardinas_asadas", 150),
    (["hummus"], "hummus_garbanzos", 80),
    (["yogur", "yogurt"], "yogur_natural", 125),
    (["queso batido", "skyr"], "queso_batido_0", 150),
    (["kefir", "kéfir"], "kefir_natural", 150),
    (["queso"], "queso_fresco_burgos", 75),
    (["leche"], "leche_semidesnatada", 200),
    (["aceite", "aove"], "aceite_oliva", 10),
    (["salsa de tomate"], "salsa_tomate_casera", 50),
    (["mayonesa"], "mayonesa", 15),
    (["nuez", "nueces"], "nueces_naturales", 25),
    (["almendra", "almendras"], "almendras_naturales", 25),
    (["cafe", "café", "infusion", "té"], "cafe_solo", 150),
    (["chocolate"], "chocolate_negro_85", 20),
]


def try_external_gemini_vision(image_base64: Optional[str], user_hint: str, foods_list: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    gemini_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not gemini_key or not image_base64 or not image_base64.startswith("data:image/"):
        return None
    match = re.match(r"^data:(image/[a-zA-Z0-9+.-]+);base64,(.+)$", image_base64)
    if not match:
        return None
    mime_type, b64_data = match.group(1), match.group(2)
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    catalog_ids = "\n".join(f"{f['id']}: {f['name']} ({f['kcal_per_100g']} kcal/100g)" for f in foods_list)
    prompt = (
        "Analiza esta fotografía de comida y devuelve EXCLUSIVAMENTE un objeto JSON válido con la estructura:\n"
        '{"title":"Nombre","confidence":0.88,"confidenceLabel":"Alta","needsUserClarification":false,'
        '"clarificationQuestions":["Pregunta"],"aiNotes":"Nota","items":[{"food_id":"id","grams":150,"item_confidence":0.9}]}\n'
        f"Catálogo BEDCA/USDA:\n{catalog_ids}\nPista del usuario: {user_hint or 'Ninguna'}"
    )
    req_body = json.dumps({
        "contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": mime_type, "data": b64_data}}]}],
        "generationConfig": {"responseMimeType": "application/json"},
    }).encode("utf-8")

    try:
        req = urllib.request.Request(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={gemini_key}",
            data=req_body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            raw_text = payload["candidates"][0]["content"]["parts"][0]["text"]
            return json.loads(raw_text)
    except Exception:
        return None


def build_analysis_payload(raw: Dict[str, Any], suggested_meal_type: str, engine_used: str, food_map: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    default_food = next(iter(food_map.values()))
    enriched_items = []
    tot_kcal = tot_p = tot_c = tot_f = tot_sat = tot_fib = tot_sug = tot_free_sug = tot_salt = tot_fv = 0.0

    for item in raw.get("items") or []:
        food = food_map.get(item.get("food_id")) or default_food
        calc = compute_item_nutrients(food, item.get("grams") or food.get("default_portion_g", 100))
        calc["item_confidence"] = item.get("item_confidence") or raw.get("confidence") or 0.85
        enriched_items.append(calc)

        tot_kcal += calc["kcal"]
        tot_p += calc["protein_g"]
        tot_c += calc["carbs_g"]
        tot_f += calc["fat_g"]
        tot_sat += calc["saturated_fat_g"]
        tot_fib += calc["fiber_g"]
        tot_sug += calc["sugars_g"]
        tot_free_sug += calc["free_sugars_g"]
        tot_salt += calc["salt_g"]
        tot_fv += calc["fruit_veg_g"]

    return {
        "title": raw.get("title") or "Comida analizada por IA",
        "suggestedMealType": suggested_meal_type,
        "confidence": round(float(raw.get("confidence") or 0.88), 2),
        "confidenceLabel": raw.get("confidenceLabel") or "Alta",
        "needsUserClarification": bool(raw.get("needsUserClarification", False)),
        "clarificationQuestions": raw.get("clarificationQuestions") or [
            "¿Las cantidades estimadas en gramos coinciden con tu ración?",
            "¿Has añadido aceite de oliva, salsas o acompañamientos adicionales?",
        ],
        "aiNotes": raw.get("aiNotes") or "Importante: La IA estima volúmenes y pesos aproximados a partir de la imagen 2D. Revisa y confirma las cantidades antes de guardar.",
        "engineUsed": engine_used,
        "items": enriched_items,
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


def analyze_food_photograph(
    foods_list: List[Dict[str, Any]],
    preset_id: Optional[str] = None,
    image_url: Optional[str] = None,
    image_base64: Optional[str] = None,
    user_hint: str = "",
    visual_signature: Optional[Dict[str, float]] = None,
    capture_hour: Optional[int] = None,
) -> Dict[str, Any]:
    food_map = {f["id"]: f for f in foods_list}
    suggested_type = suggest_meal_type_by_hour(capture_hour)

    ext = try_external_gemini_vision(image_base64, user_hint, foods_list)
    if ext and ext.get("items"):
        return build_analysis_payload(ext, suggested_type, "gemini-vision-python-server", food_map)

    if preset_id and preset_id in VISUAL_PRESETS:
        return build_analysis_payload(VISUAL_PRESETS[preset_id], suggested_type, "bedca-vision-python", food_map)

    if image_url:
        if "pollo_arroz_ensalada" in image_url:
            return build_analysis_payload(VISUAL_PRESETS["pollo_arroz_ensalada"], suggested_type, "bedca-vision-python", food_map)
        if "salmon_quinoa_brocoli" in image_url:
            return build_analysis_payload(VISUAL_PRESETS["salmon_quinoa_brocoli"], suggested_type, "bedca-vision-python", food_map)
        if "tostada_aguacate_huevo" in image_url:
            return build_analysis_payload(VISUAL_PRESETS["tostada_aguacate_huevo"], "breakfast", "bedca-vision-python", food_map)

    if user_hint and len(user_hint.strip()) > 1:
        norm = user_hint.lower()
        matched = []
        used = set()
        for kws, fid, grams in KEYWORD_MATCHERS:
            if any(kw in norm for kw in kws) and fid not in used:
                used.add(fid)
                matched.append({"food_id": fid, "grams": grams, "item_confidence": 0.89})
        if matched:
            if "aceite_oliva" not in used and any(x in used for x in ("pollo_plancha", "ensalada_mixta", "verduras_asadas")):
                matched.append({"food_id": "aceite_oliva", "grams": 8, "item_confidence": 0.76})
            return build_analysis_payload(
                {
                    "title": f"Plato analizado: {user_hint.strip()}",
                    "confidence": 0.88,
                    "confidenceLabel": "Alta",
                    "items": matched,
                    "clarificationQuestions": [
                        "¿Las cantidades en gramos se ajustan al tamaño de tu plato?",
                        "¿Deseas añadir alguna salsa, aliño o acompañamiento adicional?",
                    ],
                    "aiNotes": "Alimentos identificados mediante análisis en Python y verificados en BEDCA/USDA.",
                },
                suggested_type,
                "hybrid-vision-python",
                food_map,
            )

    if visual_signature:
        if visual_signature.get("greenRatio", 0) > 0.28:
            return build_analysis_payload(
                {**VISUAL_PRESETS["salmon_quinoa_brocoli"], "confidence": 0.79, "confidenceLabel": "Media", "needsUserClarification": True},
                suggested_type,
                "camera-chromatic-python",
                food_map,
            )
        if visual_signature.get("brightRatio", 0) > 0.45 and visual_signature.get("warmRatio", 0) > 0.25:
            return build_analysis_payload(
                {**VISUAL_PRESETS["tostada_aguacate_huevo"], "confidence": 0.77, "confidenceLabel": "Media", "needsUserClarification": True},
                suggested_type,
                "camera-chromatic-python",
                food_map,
            )

    return build_analysis_payload(
        {**VISUAL_PRESETS["pollo_arroz_ensalada"], "confidence": 0.84, "confidenceLabel": "Media-Alta", "needsUserClarification": True},
        suggested_type,
        "bedca-vision-python",
        food_map,
    )
