/**
 * CAPA DE PERSISTENCIA SQL (SQLite Nativo Node 24 + Compatible PostgreSQL)
 * Gestiona usuarios, sesiones, catálogo BEDCA/USDA, comidas, agua, evolución de peso,
 * prevención de duplicidades y copias de seguridad automáticas.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { FOODS_CATALOG, computeItemNutrients } = require('./foods-catalog');
const { calculateMetabolicProfile } = require('./metabolism');

const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'nutriai.sqlite');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function hashPassword(password) {
  const salt = 'nutrivital_rgpd_salt_v1';
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function getTodayIso() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDateIso(baseIso, deltaDays) {
  const [y, m, d] = baseIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function initDatabase() {
  const schemaPath = path.join(__dirname, '..', 'schema.postgres.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schemaSql);

  // Poblar o actualizar catálogo verificado BEDCA / USDA
  const upsertFood = db.prepare(`
    INSERT INTO foods (
      id, name, category, preparation_state, paired_food_id,
      kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
      saturated_fat_per_100g, trans_fat_per_100g, fiber_per_100g,
      sugars_per_100g, free_sugars_per_100g, salt_g_per_100g,
      default_portion_g, source, source_code, barcode,
      is_who_fruit_veg, is_who_legume, is_who_whole_grain
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      category = excluded.category,
      preparation_state = excluded.preparation_state,
      paired_food_id = excluded.paired_food_id,
      kcal_per_100g = excluded.kcal_per_100g,
      protein_per_100g = excluded.protein_per_100g,
      carbs_per_100g = excluded.carbs_per_100g,
      fat_per_100g = excluded.fat_per_100g,
      saturated_fat_per_100g = excluded.saturated_fat_per_100g,
      fiber_per_100g = excluded.fiber_per_100g,
      sugars_per_100g = excluded.sugars_per_100g,
      free_sugars_per_100g = excluded.free_sugars_per_100g,
      salt_g_per_100g = excluded.salt_g_per_100g,
      default_portion_g = excluded.default_portion_g,
      source = excluded.source,
      source_code = excluded.source_code,
      barcode = excluded.barcode,
      is_who_fruit_veg = excluded.is_who_fruit_veg,
      is_who_legume = excluded.is_who_legume,
      is_who_whole_grain = excluded.is_who_whole_grain
  `);

  for (const food of FOODS_CATALOG) {
    upsertFood.run(
      food.id,
      food.name,
      food.category,
      food.preparation_state || 'cooked',
      food.paired_food_id || null,
      food.kcal_per_100g,
      food.protein_per_100g,
      food.carbs_per_100g,
      food.fat_per_100g,
      food.saturated_fat_per_100g || 0,
      food.trans_fat_per_100g || 0,
      food.fiber_per_100g || 0,
      food.sugars_per_100g || 0,
      food.free_sugars_per_100g || 0,
      food.salt_g_per_100g || 0,
      food.default_portion_g || 100,
      food.source || 'BEDCA',
      food.source_code || '',
      food.barcode || null,
      food.is_who_fruit_veg || 0,
      food.is_who_legume || 0,
      food.is_who_whole_grain || 0
    );
  }

  seedDemoUserIfNeeded();
}

function seedDemoUserIfNeeded() {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('elena@nutrivital.es');
  if (existing) return;

  const userId = 'user_demo_elena';
  const profileInput = {
    age: 32,
    sex: 'female',
    height_cm: 166,
    weight_kg: 67.4,
    target_weight_kg: 62.5,
    activity_level: 'moderate',
    work_activity: 'standing',
    exercise_frequency: '3_4_days',
    goal: 'lose',
    special_conditions: {}
  };

  const calc = calculateMetabolicProfile(profileInput);
  const nowIso = new Date().toISOString();
  const todayIso = getTodayIso();

  db.prepare(`
    INSERT INTO users (
      id, email, password_hash, name, age, sex, height_cm, weight_kg, target_weight_kg,
      activity_level, work_activity, exercise_frequency, goal, special_conditions_json,
      bmi, bmr_kcal, tdee_kcal, daily_calorie_target, macro_targets_json,
      water_target_ml, reminders_json, gdpr_consent_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    'elena@nutrivital.es',
    hashPassword('Nutri2026!'),
    'Elena Martínez',
    profileInput.age,
    profileInput.sex,
    profileInput.height_cm,
    profileInput.weight_kg,
    calc.targetWeightKg,
    profileInput.activity_level,
    profileInput.work_activity,
    profileInput.exercise_frequency,
    profileInput.goal,
    JSON.stringify(profileInput.special_conditions),
    calc.bmi,
    calc.bmrKcal,
    calc.tdeeKcal,
    calc.dailyCalorieTarget,
    JSON.stringify(calc.macroTargets),
    calc.waterTargetMl,
    JSON.stringify({
      meals: true,
      water: true,
      breakfastTime: '08:30',
      lunchTime: '14:00',
      dinnerTime: '21:00',
      waterIntervalMin: 120
    }),
    nowIso,
    shiftDateIso(todayIso, -90)
  );

  const foodMap = new Map(FOODS_CATALOG.map((f) => [f.id, f]));
  const buildMealRecord = (itemsSpec) => {
    const items = itemsSpec.map((sp) => computeItemNutrients(foodMap.get(sp.id), sp.g));
    const totals = items.reduce(
      (acc, it) => {
        acc.kcal += it.kcal;
        acc.protein += it.protein_g;
        acc.carbs += it.carbs_g;
        acc.fat += it.fat_g;
        acc.satFat += it.saturated_fat_g;
        acc.fiber += it.fiber_g;
        acc.sugars += it.sugars_g;
        acc.freeSugars += it.free_sugars_g;
        acc.salt += it.salt_g;
        acc.fruitVeg += it.fruit_veg_g;
        return acc;
      },
      { kcal: 0, protein: 0, carbs: 0, fat: 0, satFat: 0, fiber: 0, sugars: 0, freeSugars: 0, salt: 0, fruitVeg: 0 }
    );
    return { items, totals };
  };

  const insertMeal = db.prepare(`
    INSERT INTO meals (
      id, user_id, meal_date, meal_time, meal_type, title, photo_url, items_json,
      total_kcal, total_protein_g, total_carbs_g, total_fat_g, total_saturated_fat_g,
      total_fiber_g, total_sugars_g, total_free_sugars_g, total_salt_g, fruit_veg_grams,
      ai_confidence, ai_confidence_label, ai_notes, is_favorite, dedup_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertWater = db.prepare(`
    INSERT OR REPLACE INTO daily_water (user_id, log_date, water_ml, updated_at)
    VALUES (?, ?, ?, ?)
  `);

  const insertWeight = db.prepare(`
    INSERT OR REPLACE INTO weight_logs (id, user_id, log_date, weight_kg, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Generar historial realista de los últimos 89 días (para estadísticas de 7, 30, 60 y 90 días)
  for (let i = 89; i >= 1; i--) {
    const dateStr = shiftDateIso(todayIso, -i);
    const wave = Math.sin(i * 0.45);
    const bGramMod = Math.round(wave * 10);
    const lGramMod = Math.round(Math.cos(i * 0.35) * 15);

    const breakfast = buildMealRecord([
      { id: 'pan_integral', g: 60 + bGramMod },
      { id: 'aguacate', g: 55 },
      { id: 'huevo_escalfado', g: 55 },
      { id: 'frutos_rojos', g: 100 }
    ]);
    insertMeal.run(
      `meal_hist_${i}_b`,
      userId,
      dateStr,
      '08:30',
      'breakfast',
      'Tostada integral con aguacate, huevo y frutos rojos',
      '/assets/meals/tostada_aguacate_huevo.jpg',
      JSON.stringify(breakfast.items),
      Math.round(breakfast.totals.kcal),
      Number(breakfast.totals.protein.toFixed(1)),
      Number(breakfast.totals.carbs.toFixed(1)),
      Number(breakfast.totals.fat.toFixed(1)),
      Number(breakfast.totals.satFat.toFixed(1)),
      Number(breakfast.totals.fiber.toFixed(1)),
      Number(breakfast.totals.sugars.toFixed(1)),
      Number(breakfast.totals.freeSugars.toFixed(1)),
      Number(breakfast.totals.salt.toFixed(2)),
      Math.round(breakfast.totals.fruitVeg),
      0.91,
      'Alta',
      'Registro histórico verificado BEDCA',
      0,
      `hist_${i}_b`,
      `${dateStr}T08:30:00Z`
    );

    const lunch = buildMealRecord(
      i % 2 === 0
        ? [
            { id: 'pollo_plancha', g: 150 + lGramMod },
            { id: 'arroz_cocido', g: 150 },
            { id: 'ensalada_mixta', g: 120 },
            { id: 'aceite_oliva', g: 10 },
            { id: 'manzana', g: 150 }
          ]
        : [
            { id: 'lentejas_cocidas', g: 230 },
            { id: 'verduras_asadas', g: 100 },
            { id: 'pan_integral', g: 40 },
            { id: 'naranja', g: 150 },
            { id: 'aceite_oliva', g: 8 }
          ]
    );
    insertMeal.run(
      `meal_hist_${i}_l`,
      userId,
      dateStr,
      '14:15',
      'lunch',
      i % 2 === 0 ? 'Pechuga de pollo con arroz, ensalada y fruta' : 'Lentejas estofadas con verduras y naranja',
      '/assets/meals/pollo_arroz_ensalada.jpg',
      JSON.stringify(lunch.items),
      Math.round(lunch.totals.kcal),
      Number(lunch.totals.protein.toFixed(1)),
      Number(lunch.totals.carbs.toFixed(1)),
      Number(lunch.totals.fat.toFixed(1)),
      Number(lunch.totals.satFat.toFixed(1)),
      Number(lunch.totals.fiber.toFixed(1)),
      Number(lunch.totals.sugars.toFixed(1)),
      Number(lunch.totals.freeSugars.toFixed(1)),
      Number(lunch.totals.salt.toFixed(2)),
      Math.round(lunch.totals.fruitVeg),
      0.92,
      'Alta',
      'Registro histórico verificado BEDCA',
      0,
      `hist_${i}_l`,
      `${dateStr}T14:15:00Z`
    );

    const dinner = buildMealRecord([
      { id: 'salmon_horno', g: 150 },
      { id: 'quinoa_cocida', g: 110 },
      { id: 'brocoli_vapor', g: 130 },
      { id: 'yogur_natural', g: 125 }
    ]);
    insertMeal.run(
      `meal_hist_${i}_d`,
      userId,
      dateStr,
      '21:00',
      'dinner',
      'Salmón al horno con quinoa, brócoli y yogur natural',
      '/assets/meals/salmon_quinoa_brocoli.jpg',
      JSON.stringify(dinner.items),
      Math.round(dinner.totals.kcal),
      Number(dinner.totals.protein.toFixed(1)),
      Number(dinner.totals.carbs.toFixed(1)),
      Number(dinner.totals.fat.toFixed(1)),
      Number(dinner.totals.satFat.toFixed(1)),
      Number(dinner.totals.fiber.toFixed(1)),
      Number(dinner.totals.sugars.toFixed(1)),
      Number(dinner.totals.freeSugars.toFixed(1)),
      Number(dinner.totals.salt.toFixed(2)),
      Math.round(dinner.totals.fruitVeg),
      0.90,
      'Alta',
      'Registro histórico verificado BEDCA',
      0,
      `hist_${i}_d`,
      `${dateStr}T21:00:00Z`
    );

    insertWater.run(userId, dateStr, 1750 + ((i % 4) * 250), `${dateStr}T22:00:00Z`);

    // Evolución progresiva de peso cada 3 días (de 70.8 kg hace 90 días a 67.4 kg hoy)
    if (i % 3 === 0) {
      const w = Number((67.4 + (i / 90) * 3.4 + Math.sin(i) * 0.15).toFixed(1));
      insertWeight.run(`w_hist_${i}`, userId, dateStr, w, 'Control periódico de peso', `${dateStr}T08:00:00Z`);
    }
  }

  // Peso de hoy
  insertWeight.run('w_today', userId, todayIso, 67.4, 'Peso actual en ayunas', nowIso);

  // Comidas registradas HOY (dejando margen para registrar la cena o más comidas en vivo)
  const todayBreakfast = buildMealRecord([
    { id: 'pan_integral', g: 60 },
    { id: 'aguacate', g: 60 },
    { id: 'huevo_escalfado', g: 55 },
    { id: 'frutos_rojos', g: 100 },
    { id: 'cafe_solo', g: 150 }
  ]);
  insertMeal.run(
    'meal_today_breakfast',
    userId,
    todayIso,
    '08:35',
    'breakfast',
    'Tostada integral con aguacate, huevo escalfado y frutos rojos',
    '/assets/meals/tostada_aguacate_huevo.jpg',
    JSON.stringify(todayBreakfast.items),
    Math.round(todayBreakfast.totals.kcal),
    Number(todayBreakfast.totals.protein.toFixed(1)),
    Number(todayBreakfast.totals.carbs.toFixed(1)),
    Number(todayBreakfast.totals.fat.toFixed(1)),
    Number(todayBreakfast.totals.satFat.toFixed(1)),
    Number(todayBreakfast.totals.fiber.toFixed(1)),
    Number(todayBreakfast.totals.sugars.toFixed(1)),
    Number(todayBreakfast.totals.freeSugars.toFixed(1)),
    Number(todayBreakfast.totals.salt.toFixed(2)),
    Math.round(todayBreakfast.totals.fruitVeg),
    0.91,
    'Alta',
    'Desayuno equilibrado analizado por IA',
    1, // Guardada como comida habitual
    'today_b_hash',
    nowIso
  );

  // El ejemplo exacto del prompt maestro (568 kcal: Pollo 150g = 248 kcal, Arroz 150g = 195 kcal, Ensalada 100g = 35 kcal, Aceite 10g = 90 kcal)
  const todayLunch = buildMealRecord([
    { id: 'pollo_plancha', g: 150 },
    { id: 'arroz_cocido', g: 150 },
    { id: 'ensalada_mixta', g: 100 },
    { id: 'aceite_oliva', g: 10 }
  ]);
  insertMeal.run(
    'meal_today_lunch',
    userId,
    todayIso,
    '14:20',
    'lunch',
    'Pechuga de pollo a la plancha, arroz cocido y ensalada',
    '/assets/meals/pollo_arroz_ensalada.jpg',
    JSON.stringify(todayLunch.items),
    Math.round(todayLunch.totals.kcal), // 568 kcal
    Number(todayLunch.totals.protein.toFixed(1)),
    Number(todayLunch.totals.carbs.toFixed(1)),
    Number(todayLunch.totals.fat.toFixed(1)),
    Number(todayLunch.totals.satFat.toFixed(1)),
    Number(todayLunch.totals.fiber.toFixed(1)),
    Number(todayLunch.totals.sugars.toFixed(1)),
    Number(todayLunch.totals.freeSugars.toFixed(1)),
    Number(todayLunch.totals.salt.toFixed(2)),
    Math.round(todayLunch.totals.fruitVeg),
    0.92,
    'Alta',
    'Fotografía verificada con catálogo BEDCA (568 kcal)',
    1, // Guardada como comida habitual
    'today_l_hash',
    nowIso
  );

  insertWater.run(userId, todayIso, 1250, nowIso);
}

function createBackupSnapshot(userId) {
  try {
    const user = db.prepare('SELECT id, email, name, age, sex, height_cm, weight_kg, target_weight_kg, activity_level, work_activity, exercise_frequency, goal, bmi, bmr_kcal, tdee_kcal, daily_calorie_target, macro_targets_json, water_target_ml, created_at FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    const meals = db.prepare('SELECT * FROM meals WHERE user_id = ? ORDER BY meal_date DESC, meal_time DESC').all(userId);
    const weights = db.prepare('SELECT * FROM weight_logs WHERE user_id = ? ORDER BY log_date DESC').all(userId);
    const water = db.prepare('SELECT * FROM daily_water WHERE user_id = ? ORDER BY log_date DESC').all(userId);

    const backupPayload = {
      backupCreatedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      user,
      mealsCount: meals.length,
      meals,
      weights,
      water
    };

    const filename = `backup_${userId}_${getTodayIso()}.json`;
    const filePath = path.join(BACKUP_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(backupPayload, null, 2), 'utf8');
    return { filename, filePath, mealsCount: meals.length };
  } catch (_err) {
    return null;
  }
}

module.exports = {
  db,
  hashPassword,
  getTodayIso,
  shiftDateIso,
  initDatabase,
  createBackupSnapshot
};
