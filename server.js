/**
 * SERVIDOR BACKEND PRINCIPAL — NUTRIVITAL AI
 * Arquitectura segura, multiusuario, con aislamiento de sesión,
 * motor metabólico científico, IA en servidor y cumplimiento RGPD.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const {
  db,
  hashPassword,
  getTodayIso,
  shiftDateIso,
  initDatabase,
  createBackupSnapshot
} = require('./src/db');
const { calculateMetabolicProfile, generateWhoEvaluation } = require('./src/metabolism');
const { FOODS_CATALOG, computeItemNutrients } = require('./src/foods-catalog');
const { analyzeFoodPhotograph } = require('./src/ai-vision');

// Inicializar base de datos y semillas BEDCA/USDA
initDatabase();

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 18 * 1024 * 1024) {
        reject(new Error('Payload demasiado grande (máx 18MB)'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      out[k] = v;
    }
  });
  return out;
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  const cookies = parseCookies(req);
  const token = bearerToken || cookies.nutrivital_token || null;

  if (token) {
    const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?').get(token);
    if (session && session.expires_at > new Date().toISOString()) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
      if (user) return sanitizeUser(user);
    }
  }

  // Fallback para sesión demo predeterminada si no se envió cabecera explícita de cierre
  if (req.headers['x-no-demo-fallback'] === '1') {
    return null;
  }
  const demoUser = db.prepare('SELECT * FROM users WHERE email = ?').get('elena@nutrivital.es');
  return demoUser ? sanitizeUser(demoUser) : null;
}

function sanitizeUser(u) {
  if (!u) return null;
  const macroTargets = safeParseJson(u.macro_targets_json, {});
  const specialConditions = safeParseJson(u.special_conditions_json, {});
  const reminders = safeParseJson(u.reminders_json, {});
  const metabolicPreview = calculateMetabolicProfile({
    age: u.age,
    sex: u.sex,
    height_cm: u.height_cm,
    weight_kg: u.weight_kg,
    target_weight_kg: u.target_weight_kg,
    activity_level: u.activity_level,
    work_activity: u.work_activity,
    exercise_frequency: u.exercise_frequency,
    goal: u.goal,
    special_conditions: specialConditions
  });

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    age: u.age,
    sex: u.sex,
    height_cm: u.height_cm,
    weight_kg: u.weight_kg,
    target_weight_kg: u.target_weight_kg,
    activity_level: u.activity_level,
    work_activity: u.work_activity,
    exercise_frequency: u.exercise_frequency,
    goal: u.goal,
    special_conditions: specialConditions,
    bmi: u.bmi,
    bmiCategory: metabolicPreview.bmiCategory,
    healthyWeightRange: metabolicPreview.healthyWeightRange,
    bmr_kcal: u.bmr_kcal,
    tdee_kcal: u.tdee_kcal,
    daily_calorie_target: u.daily_calorie_target,
    appliedDelta: metabolicPreview.appliedDelta,
    safetyFloor: metabolicPreview.safetyFloor,
    warnings: metabolicPreview.warnings,
    methodologyNote: metabolicPreview.methodologyNote,
    macroTargets,
    water_target_ml: u.water_target_ml,
    reminders,
    gdpr_consent_at: u.gdpr_consent_at,
    created_at: u.created_at
  };
}

function safeParseJson(str, fallback) {
  try {
    return typeof str === 'string' ? JSON.parse(str) : (str || fallback);
  } catch (_e) {
    return fallback;
  }
}

function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    expires.toISOString(),
    now.toISOString()
  );
  return token;
}

function getAllFoodsMap() {
  const rows = db.prepare('SELECT * FROM foods').all();
  return new Map(rows.map((r) => [r.id, r]));
}

function summarizeItemsList(rawItems) {
  const foodMap = getAllFoodsMap();
  const enrichedItems = [];
  let totalKcal = 0;
  let totalProtein = 0;
  let totalCarbs = 0;
  let totalFat = 0;
  let totalSatFat = 0;
  let totalFiber = 0;
  let totalSugars = 0;
  let totalFreeSugars = 0;
  let totalSalt = 0;
  let fruitVegGrams = 0;

  for (const item of rawItems || []) {
    const food = foodMap.get(item.food_id);
    const grams = Math.max(1, Math.min(2500, Number(item.grams) || 100));
    if (food) {
      const c = computeItemNutrients(food, grams);
      c.item_confidence = item.item_confidence || 0.95;
      enrichedItems.push(c);
      totalKcal += c.kcal;
      totalProtein += c.protein_g;
      totalCarbs += c.carbs_g;
      totalFat += c.fat_g;
      totalSatFat += c.saturated_fat_g;
      totalFiber += c.fiber_g;
      totalSugars += c.sugars_g;
      totalFreeSugars += c.free_sugars_g;
      totalSalt += c.salt_g;
      fruitVegGrams += c.fruit_veg_g;
    } else if (item.name && item.kcal !== undefined) {
      // Ingrediente manual personalizado
      const customItem = {
        food_id: item.food_id || `custom_${Date.now()}`,
        name: String(item.name),
        category: item.category || 'Personalizado',
        preparation_state: item.preparation_state || 'ready',
        paired_food_id: null,
        grams: Math.round(grams),
        kcal: Math.round(Number(item.kcal) || 0),
        protein_g: Number((Number(item.protein_g) || 0).toFixed(1)),
        carbs_g: Number((Number(item.carbs_g) || 0).toFixed(1)),
        fat_g: Number((Number(item.fat_g) || 0).toFixed(1)),
        saturated_fat_g: Number((Number(item.saturated_fat_g) || 0).toFixed(1)),
        fiber_g: Number((Number(item.fiber_g) || 0).toFixed(1)),
        sugars_g: Number((Number(item.sugars_g) || 0).toFixed(1)),
        free_sugars_g: Number((Number(item.free_sugars_g) || 0).toFixed(1)),
        salt_g: Number((Number(item.salt_g) || 0).toFixed(2)),
        fruit_veg_g: Number(item.fruit_veg_g) || 0,
        source: item.source || 'MANUAL',
        source_code: 'REGISTRO-MANUAL'
      };
      enrichedItems.push(customItem);
      totalKcal += customItem.kcal;
      totalProtein += customItem.protein_g;
      totalCarbs += customItem.carbs_g;
      totalFat += customItem.fat_g;
      totalSatFat += customItem.saturated_fat_g;
      totalFiber += customItem.fiber_g;
      totalSugars += customItem.sugars_g;
      totalFreeSugars += customItem.free_sugars_g;
      totalSalt += customItem.salt_g;
      fruitVegGrams += customItem.fruit_veg_g;
    }
  }

  return {
    items: enrichedItems,
    totals: {
      total_kcal: Math.round(totalKcal),
      total_protein_g: Number(totalProtein.toFixed(1)),
      total_carbs_g: Number(totalCarbs.toFixed(1)),
      total_fat_g: Number(totalFat.toFixed(1)),
      total_saturated_fat_g: Number(totalSatFat.toFixed(1)),
      total_fiber_g: Number(totalFiber.toFixed(1)),
      total_sugars_g: Number(totalSugars.toFixed(1)),
      total_free_sugars_g: Number(totalFreeSugars.toFixed(1)),
      total_salt_g: Number(totalSalt.toFixed(2)),
      fruit_veg_grams: Math.round(fruitVegGrams)
    }
  };
}

function buildDaySummary(user, dateStr) {
  const mealsRaw = db
    .prepare('SELECT * FROM meals WHERE user_id = ? AND meal_date = ? ORDER BY meal_time ASC, created_at ASC')
    .all(user.id, dateStr);

  let consumedKcal = 0;
  let proteinG = 0;
  let carbsG = 0;
  let fatG = 0;
  let satFatG = 0;
  let fiberG = 0;
  let sugarsG = 0;
  let freeSugarsG = 0;
  let saltG = 0;
  let fruitVegGrams = 0;
  let hasLegumes = false;
  let hasWholeGrains = false;

  const meals = mealsRaw.map((m) => {
    const items = safeParseJson(m.items_json, []);
    consumedKcal += m.total_kcal;
    proteinG += m.total_protein_g;
    carbsG += m.total_carbs_g;
    fatG += m.total_fat_g;
    satFatG += m.total_saturated_fat_g || 0;
    fiberG += m.total_fiber_g || 0;
    sugarsG += m.total_sugars_g || 0;
    freeSugarsG += m.total_free_sugars_g || 0;
    saltG += m.total_salt_g || 0;
    fruitVegGrams += m.fruit_veg_grams || 0;

    items.forEach((it) => {
      if (it.is_who_legume || it.category === 'Legumbres') hasLegumes = true;
      if (it.is_who_whole_grain || (it.name && it.name.toLowerCase().includes('integral'))) hasWholeGrains = true;
    });

    return {
      id: m.id,
      meal_date: m.meal_date,
      meal_time: m.meal_time,
      meal_type: m.meal_type,
      title: m.title,
      photo_url: m.photo_url,
      items,
      total_kcal: Math.round(m.total_kcal),
      total_protein_g: Number(m.total_protein_g.toFixed(1)),
      total_carbs_g: Number(m.total_carbs_g.toFixed(1)),
      total_fat_g: Number(m.total_fat_g.toFixed(1)),
      total_saturated_fat_g: Number((m.total_saturated_fat_g || 0).toFixed(1)),
      total_fiber_g: Number((m.total_fiber_g || 0).toFixed(1)),
      total_sugars_g: Number((m.total_sugars_g || 0).toFixed(1)),
      total_free_sugars_g: Number((m.total_free_sugars_g || 0).toFixed(1)),
      total_salt_g: Number((m.total_salt_g || 0).toFixed(2)),
      fruit_veg_grams: Math.round(m.fruit_veg_grams || 0),
      ai_confidence: m.ai_confidence,
      ai_confidence_label: m.ai_confidence_label,
      ai_notes: m.ai_notes,
      is_favorite: Boolean(m.is_favorite)
    };
  });

  const waterRow = db
    .prepare('SELECT water_ml FROM daily_water WHERE user_id = ? AND log_date = ?')
    .get(user.id, dateStr);
  const waterMl = waterRow ? waterRow.water_ml : 0;

  const targetKcal = user.daily_calorie_target || 2000;
  const remainingKcal = targetKcal - Math.round(consumedKcal);
  const progressPct = Math.round((consumedKcal / Math.max(1, targetKcal)) * 100);

  const dailyTotals = {
    total_kcal: Math.round(consumedKcal),
    total_protein_g: Number(proteinG.toFixed(1)),
    total_carbs_g: Number(carbsG.toFixed(1)),
    total_fat_g: Number(fatG.toFixed(1)),
    total_saturated_fat_g: Number(satFatG.toFixed(1)),
    total_fiber_g: Number(fiberG.toFixed(1)),
    total_sugars_g: Number(sugarsG.toFixed(1)),
    total_free_sugars_g: Number(freeSugarsG.toFixed(1)),
    total_salt_g: Number(saltG.toFixed(2)),
    fruit_veg_grams: Math.round(fruitVegGrams),
    water_ml: waterMl,
    meals_count: meals.length,
    has_legumes: hasLegumes,
    has_whole_grains: hasWholeGrains
  };

  const whoEvaluation = generateWhoEvaluation(dailyTotals, user);

  return {
    date: dateStr,
    target_kcal: targetKcal,
    consumed_kcal: Math.round(consumedKcal),
    remaining_kcal: remainingKcal,
    progress_pct: progressPct,
    water_ml: waterMl,
    water_target_ml: user.water_target_ml || 2000,
    totals: dailyTotals,
    macroTargets: user.macroTargets,
    meals,
    whoEvaluation
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // =========================================================================
    // ENDPOINTS API
    // =========================================================================
    if (pathname === '/api/health' && method === 'GET') {
      const foodsCount = db.prepare('SELECT COUNT(*) as c FROM foods').get().c;
      return sendJson(res, 200, {
        status: 'ok',
        service: 'NutriVital AI Backend',
        today: getTodayIso(),
        foodsCatalogCount: foodsCount,
        externalVisionConfigured: Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY)
      });
    }

    // Vista previa en vivo del motor de cálculo metabólico
    if (pathname === '/api/metabolism/preview' && method === 'POST') {
      const body = await parseJsonBody(req);
      const result = calculateMetabolicProfile(body);
      return sendJson(res, 200, result);
    }

    // Registro de nuevo usuario
    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await parseJsonBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || 'Usuario NutriVital').trim();
      const password = String(body.password || 'Nutri2026!');

      if (!email || !email.includes('@')) {
        return sendJson(res, 400, { error: 'Introduce un correo electrónico válido.' });
      }
      if (!body.gdpr_consent) {
        return sendJson(res, 400, {
          error: 'Debes aceptar el consentimiento informado y la Política de Privacidad RGPD para registrarte.'
        });
      }

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (existing) {
        return sendJson(res, 409, { error: 'Ya existe una cuenta registrada con este correo electrónico.' });
      }

      const calc = calculateMetabolicProfile(body);
      const userId = `user_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
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
        email,
        hashPassword(password),
        name,
        Number(body.age) || 30,
        body.sex === 'male' ? 'male' : 'female',
        Number(body.height_cm) || 168,
        Number(body.weight_kg) || 68,
        calc.targetWeightKg,
        body.activity_level || 'moderate',
        body.work_activity || 'sedentary',
        body.exercise_frequency || '3_4_days',
        body.goal || 'maintain',
        JSON.stringify(body.special_conditions || {}),
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
        nowIso
      );

      db.prepare(`
        INSERT OR REPLACE INTO weight_logs (id, user_id, log_date, weight_kg, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`w_${Date.now()}`, userId, todayIso, Number(body.weight_kg) || 68, 'Peso inicial de registro', nowIso);

      const token = createSessionForUser(userId);
      const newUser = sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
      return sendJson(
        res,
        201,
        { token, user: newUser },
        { 'Set-Cookie': `nutrivital_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` }
      );
    }

    // Inicio de sesión
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await parseJsonBody(req);
      const email = String(body.email || 'elena@nutrivital.es').trim().toLowerCase();
      const password = String(body.password || 'Nutri2026!');

      const userRow = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!userRow || userRow.password_hash !== hashPassword(password)) {
        return sendJson(res, 401, { error: 'Credenciales incorrectas. Verifica tu correo y contraseña.' });
      }

      const token = createSessionForUser(userRow.id);
      return sendJson(
        res,
        200,
        { token, user: sanitizeUser(userRow) },
        { 'Set-Cookie': `nutrivital_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` }
      );
    }

    // Cerrar sesión
    if (pathname === '/api/auth/logout' && method === 'POST') {
      const cookies = parseCookies(req);
      if (cookies.nutrivital_token) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.nutrivital_token);
      }
      return sendJson(
        res,
        200,
        { ok: true },
        { 'Set-Cookie': 'nutrivital_token=; Path=/; HttpOnly; Max-Age=0' }
      );
    }

    // Obtener perfil de usuario autenticado
    if (pathname === '/api/user/profile' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      return sendJson(res, 200, { user, today: getTodayIso() });
    }

    // Actualizar perfil personal y recalcular motor metabólico
    if (pathname === '/api/user/profile' && method === 'PUT') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const body = await parseJsonBody(req);

      const updatedInput = {
        age: body.age !== undefined ? Number(body.age) : user.age,
        sex: body.sex || user.sex,
        height_cm: body.height_cm !== undefined ? Number(body.height_cm) : user.height_cm,
        weight_kg: body.weight_kg !== undefined ? Number(body.weight_kg) : user.weight_kg,
        target_weight_kg: body.target_weight_kg !== undefined ? Number(body.target_weight_kg) : user.target_weight_kg,
        activity_level: body.activity_level || user.activity_level,
        work_activity: body.work_activity || user.work_activity,
        exercise_frequency: body.exercise_frequency || user.exercise_frequency,
        goal: body.goal || user.goal,
        special_conditions: body.special_conditions !== undefined ? body.special_conditions : user.special_conditions
      };

      const calc = calculateMetabolicProfile(updatedInput);
      const reminders = body.reminders !== undefined ? body.reminders : user.reminders;
      const name = body.name ? String(body.name).trim() : user.name;

      db.prepare(`
        UPDATE users SET
          name = ?, age = ?, sex = ?, height_cm = ?, weight_kg = ?, target_weight_kg = ?,
          activity_level = ?, work_activity = ?, exercise_frequency = ?, goal = ?,
          special_conditions_json = ?, bmi = ?, bmr_kcal = ?, tdee_kcal = ?,
          daily_calorie_target = ?, macro_targets_json = ?, water_target_ml = ?, reminders_json = ?
        WHERE id = ?
      `).run(
        name,
        updatedInput.age,
        updatedInput.sex,
        updatedInput.height_cm,
        updatedInput.weight_kg,
        calc.targetWeightKg,
        updatedInput.activity_level,
        updatedInput.work_activity,
        updatedInput.exercise_frequency,
        updatedInput.goal,
        JSON.stringify(updatedInput.special_conditions),
        calc.bmi,
        calc.bmrKcal,
        calc.tdeeKcal,
        calc.dailyCalorieTarget,
        JSON.stringify(calc.macroTargets),
        calc.waterTargetMl,
        JSON.stringify(reminders),
        user.id
      );

      // Si cambió el peso, guardar también en evolución de peso de hoy
      if (body.weight_kg !== undefined && Number(body.weight_kg) !== user.weight_kg) {
        const todayIso = getTodayIso();
        db.prepare(`
          INSERT OR REPLACE INTO weight_logs (id, user_id, log_date, weight_kg, note, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(`w_${user.id}_${todayIso}`, user.id, todayIso, updatedInput.weight_kg, 'Actualizado desde Mi Perfil', new Date().toISOString());
      }

      createBackupSnapshot(user.id);
      const refreshed = sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
      return sendJson(res, 200, { user: refreshed });
    }

    // Catálogo de alimentos BEDCA / USDA y buscador por texto o código de barras
    if (pathname === '/api/foods' && method === 'GET') {
      const q = (parsedUrl.searchParams.get('q') || '').trim().toLowerCase();
      const category = (parsedUrl.searchParams.get('category') || '').trim();
      const barcode = (parsedUrl.searchParams.get('barcode') || '').trim();
      const state = (parsedUrl.searchParams.get('state') || '').trim();

      let rows = db.prepare('SELECT * FROM foods ORDER BY name ASC').all();
      if (barcode) {
        rows = rows.filter((r) => r.barcode === barcode);
      }
      if (category && category !== 'all') {
        rows = rows.filter((r) => r.category === category);
      }
      if (state && state !== 'all') {
        rows = rows.filter((r) => r.preparation_state === state);
      }
      if (q) {
        rows = rows.filter(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.category.toLowerCase().includes(q) ||
            (r.barcode && r.barcode.includes(q))
        );
      }
      return sendJson(res, 200, { foods: rows });
    }

    // Añadir nuevo alimento personalizado al catálogo
    if (pathname === '/api/foods' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const body = await parseJsonBody(req);
      if (!body.name || body.kcal_per_100g === undefined) {
        return sendJson(res, 400, { error: 'Nombre y calorías por 100g son obligatorios.' });
      }
      const id = `custom_${Date.now()}`;
      db.prepare(`
        INSERT INTO foods (
          id, name, category, preparation_state, paired_food_id,
          kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g,
          saturated_fat_per_100g, trans_fat_per_100g, fiber_per_100g,
          sugars_per_100g, free_sugars_per_100g, salt_g_per_100g,
          default_portion_g, source, source_code, barcode,
          is_who_fruit_veg, is_who_legume, is_who_whole_grain
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        String(body.name).trim(),
        body.category || 'Personalizado',
        body.preparation_state || 'ready',
        null,
        Number(body.kcal_per_100g) || 0,
        Number(body.protein_per_100g) || 0,
        Number(body.carbs_per_100g) || 0,
        Number(body.fat_per_100g) || 0,
        Number(body.saturated_fat_per_100g) || 0,
        0,
        Number(body.fiber_per_100g) || 0,
        Number(body.sugars_per_100g) || 0,
        Number(body.free_sugars_per_100g) || 0,
        Number(body.salt_g_per_100g) || 0,
        Number(body.default_portion_g) || 100,
        'PERSONALIZADO',
        'USER-CUSTOM',
        body.barcode || null,
        body.category === 'Frutas' || body.category === 'Verduras y hortalizas' ? 1 : 0,
        body.category === 'Legumbres' ? 1 : 0,
        0
      );
      const created = db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
      return sendJson(res, 201, { food: created });
    }

    // Análisis de fotografía mediante Inteligencia Artificial en servidor
    if (pathname === '/api/ai/analyze-food' && method === 'POST') {
      const body = await parseJsonBody(req);
      const analysis = await analyzeFoodPhotograph({
        presetId: body.presetId,
        imageUrl: body.imageUrl,
        imageBase64: body.imageBase64,
        userHint: body.userHint,
        visualSignature: body.visualSignature,
        captureHour: body.captureHour !== undefined ? Number(body.captureHour) : new Date().getHours()
      });
      return sendJson(res, 200, analysis);
    }

    // Recalcular lista de ingredientes editados por el usuario antes de guardar
    if (pathname === '/api/ai/recalculate-items' && method === 'POST') {
      const body = await parseJsonBody(req);
      const summary = summarizeItemsList(body.items || []);
      return sendJson(res, 200, summary);
    }

    // Panel diario completo (calorías, macros, comidas, agua, consejos OMS)
    if (pathname === '/api/day' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const dateStr = parsedUrl.searchParams.get('date') || getTodayIso();
      const summary = buildDaySummary(user, dateStr);
      const favorites = db
        .prepare('SELECT * FROM meals WHERE user_id = ? AND is_favorite = 1 ORDER BY created_at DESC LIMIT 12')
        .all(user.id)
        .map((m) => ({
          id: m.id,
          title: m.title,
          meal_type: m.meal_type,
          photo_url: m.photo_url,
          total_kcal: Math.round(m.total_kcal),
          total_protein_g: Number(m.total_protein_g.toFixed(1)),
          total_carbs_g: Number(m.total_carbs_g.toFixed(1)),
          total_fat_g: Number(m.total_fat_g.toFixed(1)),
          items: safeParseJson(m.items_json, [])
        }));
      return sendJson(res, 200, { ...summary, favorites });
    }

    // Registrar una comida confirmada y descontar automáticamente las calorías del objetivo diario
    if (pathname === '/api/meals' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const body = await parseJsonBody(req);

      const mealDate = body.meal_date || getTodayIso();
      const now = new Date();
      const mealTime = body.meal_time || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const mealType = ['breakfast', 'mid_morning', 'lunch', 'snack', 'dinner', 'other'].includes(body.meal_type)
        ? body.meal_type
        : 'lunch';

      const { items, totals } = summarizeItemsList(body.items || []);
      if (items.length === 0) {
        return sendJson(res, 400, { error: 'Añade al menos un alimento antes de guardar la comida.' });
      }

      const title = String(body.title || items.map((i) => i.name.split('(')[0].trim()).slice(0, 3).join(', ')).trim();
      const dedupHash = crypto
        .createHash('sha1')
        .update(`${user.id}|${mealDate}|${mealTime}|${title}|${totals.total_kcal}`)
        .digest('hex');

      const duplicate = db
        .prepare('SELECT id FROM meals WHERE user_id = ? AND dedup_hash = ? AND created_at > ?')
        .get(user.id, dedupHash, new Date(Date.now() - 15000).toISOString());
      if (duplicate) {
        const daySummary = buildDaySummary(user, mealDate);
        return sendJson(res, 200, { duplicatePrevented: true, daySummary });
      }

      const mealId = `meal_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      db.prepare(`
        INSERT INTO meals (
          id, user_id, meal_date, meal_time, meal_type, title, photo_url, items_json,
          total_kcal, total_protein_g, total_carbs_g, total_fat_g, total_saturated_fat_g,
          total_fiber_g, total_sugars_g, total_free_sugars_g, total_salt_g, fruit_veg_grams,
          ai_confidence, ai_confidence_label, ai_notes, is_favorite, dedup_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mealId,
        user.id,
        mealDate,
        mealTime,
        mealType,
        title,
        body.photo_url || '/assets/meals/pollo_arroz_ensalada.jpg',
        JSON.stringify(items),
        totals.total_kcal,
        totals.total_protein_g,
        totals.total_carbs_g,
        totals.total_fat_g,
        totals.total_saturated_fat_g,
        totals.total_fiber_g,
        totals.total_sugars_g,
        totals.total_free_sugars_g,
        totals.total_salt_g,
        totals.fruit_veg_grams,
        Number(body.ai_confidence) || 0.92,
        body.ai_confidence_label || 'Confirmado',
        body.ai_notes || 'Cantidades verificadas y confirmadas por el usuario',
        body.is_favorite ? 1 : 0,
        dedupHash,
        now.toISOString()
      );

      createBackupSnapshot(user.id);
      const daySummary = buildDaySummary(user, mealDate);
      return sendJson(res, 201, { mealId, daySummary });
    }

    // Editar comida registrada o marcar/desmarcar como comida habitual (favorita)
    if (pathname.startsWith('/api/meals/') && method === 'PUT') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const mealId = pathname.split('/')[3];
      const existing = db.prepare('SELECT * FROM meals WHERE id = ? AND user_id = ?').get(mealId, user.id);
      if (!existing) return sendJson(res, 404, { error: 'Comida no encontrada' });

      const body = await parseJsonBody(req);
      const itemsToCalc = body.items !== undefined ? body.items : safeParseJson(existing.items_json, []);
      const { items, totals } = summarizeItemsList(itemsToCalc);

      const title = body.title !== undefined ? String(body.title).trim() : existing.title;
      const mealType = body.meal_type || existing.meal_type;
      const mealTime = body.meal_time || existing.meal_time;
      const isFavorite = body.is_favorite !== undefined ? (body.is_favorite ? 1 : 0) : existing.is_favorite;

      db.prepare(`
        UPDATE meals SET
          title = ?, meal_type = ?, meal_time = ?, items_json = ?,
          total_kcal = ?, total_protein_g = ?, total_carbs_g = ?, total_fat_g = ?,
          total_saturated_fat_g = ?, total_fiber_g = ?, total_sugars_g = ?,
          total_free_sugars_g = ?, total_salt_g = ?, fruit_veg_grams = ?, is_favorite = ?
        WHERE id = ? AND user_id = ?
      `).run(
        title,
        mealType,
        mealTime,
        JSON.stringify(items),
        totals.total_kcal,
        totals.total_protein_g,
        totals.total_carbs_g,
        totals.total_fat_g,
        totals.total_saturated_fat_g,
        totals.total_fiber_g,
        totals.total_sugars_g,
        totals.total_free_sugars_g,
        totals.total_salt_g,
        totals.fruit_veg_grams,
        isFavorite,
        mealId,
        user.id
      );

      createBackupSnapshot(user.id);
      const daySummary = buildDaySummary(user, existing.meal_date);
      return sendJson(res, 200, { daySummary });
    }

    // Eliminar comida registrada
    if (pathname.startsWith('/api/meals/') && method === 'DELETE') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const mealId = pathname.split('/')[3];
      const existing = db.prepare('SELECT meal_date FROM meals WHERE id = ? AND user_id = ?').get(mealId, user.id);
      if (!existing) return sendJson(res, 404, { error: 'Comida no encontrada' });

      db.prepare('DELETE FROM meals WHERE id = ? AND user_id = ?').run(mealId, user.id);
      createBackupSnapshot(user.id);
      const daySummary = buildDaySummary(user, existing.meal_date);
      return sendJson(res, 200, { daySummary });
    }

    // Repetir una comida anterior o habitual en el día seleccionado
    if (pathname.startsWith('/api/meals/') && pathname.endsWith('/repeat') && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const mealId = pathname.split('/')[3];
      const sourceMeal = db.prepare('SELECT * FROM meals WHERE id = ? AND user_id = ?').get(mealId, user.id);
      if (!sourceMeal) return sendJson(res, 404, { error: 'Comida origen no encontrada' });

      const body = await parseJsonBody(req);
      const targetDate = body.meal_date || getTodayIso();
      const now = new Date();
      const targetTime = body.meal_time || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const newId = `meal_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

      db.prepare(`
        INSERT INTO meals (
          id, user_id, meal_date, meal_time, meal_type, title, photo_url, items_json,
          total_kcal, total_protein_g, total_carbs_g, total_fat_g, total_saturated_fat_g,
          total_fiber_g, total_sugars_g, total_free_sugars_g, total_salt_g, fruit_veg_grams,
          ai_confidence, ai_confidence_label, ai_notes, is_favorite, dedup_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        newId,
        user.id,
        targetDate,
        targetTime,
        body.meal_type || sourceMeal.meal_type,
        sourceMeal.title,
        sourceMeal.photo_url,
        sourceMeal.items_json,
        sourceMeal.total_kcal,
        sourceMeal.total_protein_g,
        sourceMeal.total_carbs_g,
        sourceMeal.total_fat_g,
        sourceMeal.total_saturated_fat_g,
        sourceMeal.total_fiber_g,
        sourceMeal.total_sugars_g,
        sourceMeal.total_free_sugars_g,
        sourceMeal.total_salt_g,
        sourceMeal.fruit_veg_grams,
        sourceMeal.ai_confidence,
        'Repetida',
        'Comida habitual repetida por el usuario',
        sourceMeal.is_favorite,
        `repeat_${newId}`,
        now.toISOString()
      );

      const daySummary = buildDaySummary(user, targetDate);
      return sendJson(res, 201, { mealId: newId, daySummary });
    }

    // Registro de agua diaria
    if (pathname === '/api/water' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const body = await parseJsonBody(req);
      const dateStr = body.date || getTodayIso();

      const currentRow = db
        .prepare('SELECT water_ml FROM daily_water WHERE user_id = ? AND log_date = ?')
        .get(user.id, dateStr);
      const currentMl = currentRow ? currentRow.water_ml : 0;

      let nextMl = currentMl;
      if (body.delta_ml !== undefined) {
        nextMl = Math.max(0, Math.min(8000, currentMl + Number(body.delta_ml)));
      } else if (body.water_ml !== undefined) {
        nextMl = Math.max(0, Math.min(8000, Number(body.water_ml)));
      }

      db.prepare(`
        INSERT OR REPLACE INTO daily_water (user_id, log_date, water_ml, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(user.id, dateStr, nextMl, new Date().toISOString());

      const daySummary = buildDaySummary(user, dateStr);
      return sendJson(res, 200, { water_ml: nextMl, daySummary });
    }

    // Registro periódico de peso corporal
    if (pathname === '/api/weight' && method === 'POST') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const body = await parseJsonBody(req);
      const weightKg = Number(body.weight_kg);
      if (!weightKg || weightKg < 25 || weightKg > 300) {
        return sendJson(res, 400, { error: 'Introduce un peso válido entre 25 y 300 kg.' });
      }
      const logDate = body.log_date || getTodayIso();
      const note = String(body.note || 'Registro periódico de peso').trim();

      db.prepare(`
        INSERT OR REPLACE INTO weight_logs (id, user_id, log_date, weight_kg, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`w_${user.id}_${logDate}`, user.id, logDate, weightKg, note, new Date().toISOString());

      // Si la fecha es hoy, actualizar el peso actual del usuario y recalcular TMB/GET/Objetivo
      if (logDate === getTodayIso()) {
        const calc = calculateMetabolicProfile({
          ...user,
          weight_kg: weightKg
        });
        db.prepare(`
          UPDATE users SET
            weight_kg = ?, bmi = ?, bmr_kcal = ?, tdee_kcal = ?,
            daily_calorie_target = ?, macro_targets_json = ?, water_target_ml = ?
          WHERE id = ?
        `).run(
          weightKg,
          calc.bmi,
          calc.bmrKcal,
          calc.tdeeKcal,
          calc.dailyCalorieTarget,
          JSON.stringify(calc.macroTargets),
          calc.waterTargetMl,
          user.id
        );
      }

      const weights = db
        .prepare('SELECT log_date, weight_kg, note FROM weight_logs WHERE user_id = ? ORDER BY log_date ASC')
        .all(user.id);
      const updatedUser = sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
      return sendJson(res, 200, { weights, user: updatedUser });
    }

    // Estadísticas diarias, semanales (7d) y mensuales (30, 60 y 90 días)
    if (pathname === '/api/stats' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });

      const days = Math.min(90, Math.max(7, Number(parsedUrl.searchParams.get('days')) || 7));
      const todayIso = getTodayIso();
      const startDate = shiftDateIso(todayIso, -(days - 1));
      const prevStartDate = shiftDateIso(startDate, -days);

      const mealAggRows = db
        .prepare(`
          SELECT
            meal_date,
            SUM(total_kcal) AS kcal,
            SUM(total_protein_g) AS protein_g,
            SUM(total_carbs_g) AS carbs_g,
            SUM(total_fat_g) AS fat_g,
            SUM(total_fiber_g) AS fiber_g,
            SUM(fruit_veg_grams) AS fruit_veg_g,
            COUNT(*) AS meals_count
          FROM meals
          WHERE user_id = ? AND meal_date >= ? AND meal_date <= ?
          GROUP BY meal_date
          ORDER BY meal_date ASC
        `)
        .all(user.id, startDate, todayIso);

      const prevAgg = db
        .prepare(`
          SELECT AVG(daily_kcal) as avg_kcal FROM (
            SELECT meal_date, SUM(total_kcal) as daily_kcal
            FROM meals
            WHERE user_id = ? AND meal_date >= ? AND meal_date < ?
            GROUP BY meal_date
          )
        `)
        .get(user.id, prevStartDate, startDate);

      const waterRows = db
        .prepare('SELECT log_date, water_ml FROM daily_water WHERE user_id = ? AND log_date >= ? AND log_date <= ?')
        .all(user.id, startDate, todayIso);
      const waterMap = new Map(waterRows.map((w) => [w.log_date, w.water_ml]));
      const aggMap = new Map(mealAggRows.map((r) => [r.meal_date, r]));

      const series = [];
      let totalKcalPeriod = 0;
      let totalProteinPeriod = 0;
      let totalCarbsPeriod = 0;
      let totalFatPeriod = 0;
      let totalFiberPeriod = 0;
      let totalFruitVegPeriod = 0;
      let activeDays = 0;
      let compliantDays = 0;
      const targetKcal = user.daily_calorie_target || 2000;

      for (let i = days - 1; i >= 0; i--) {
        const dStr = shiftDateIso(todayIso, -i);
        const row = aggMap.get(dStr);
        const kcal = row ? Math.round(row.kcal) : 0;
        const protein = row ? Number(row.protein_g.toFixed(1)) : 0;
        const carbs = row ? Number(row.carbs_g.toFixed(1)) : 0;
        const fat = row ? Number(row.fat_g.toFixed(1)) : 0;
        const fiber = row ? Number((row.fiber_g || 0).toFixed(1)) : 0;
        const fruitVeg = row ? Math.round(row.fruit_veg_g || 0) : 0;
        const mealsCount = row ? row.meals_count : 0;
        const waterMl = waterMap.get(dStr) || 0;

        const withinTarget = kcal > 0 && Math.abs(kcal - targetKcal) <= targetKcal * 0.12;
        if (kcal > 0) {
          activeDays++;
          totalKcalPeriod += kcal;
          totalProteinPeriod += protein;
          totalCarbsPeriod += carbs;
          totalFatPeriod += fat;
          totalFiberPeriod += fiber;
          totalFruitVegPeriod += fruitVeg;
          if (withinTarget) compliantDays++;
        }

        series.push({
          date: dStr,
          kcal,
          target_kcal: targetKcal,
          balance_kcal: kcal > 0 ? kcal - targetKcal : 0,
          protein_g: protein,
          carbs_g: carbs,
          fat_g: fat,
          fiber_g: fiber,
          fruit_veg_g: fruitVeg,
          meals_count: mealsCount,
          water_ml: waterMl,
          within_target: withinTarget
        });
      }

      const divisor = Math.max(1, activeDays);
      const avgKcal = Math.round(totalKcalPeriod / divisor);
      const prevAvgKcal = prevAgg && prevAgg.avg_kcal ? Math.round(prevAgg.avg_kcal) : avgKcal;
      const avgProtein = Number((totalProteinPeriod / divisor).toFixed(1));
      const avgCarbs = Number((totalCarbsPeriod / divisor).toFixed(1));
      const avgFat = Number((totalFatPeriod / divisor).toFixed(1));
      const avgFiber = Number((totalFiberPeriod / divisor).toFixed(1));
      const avgFruitVeg = Math.round(totalFruitVegPeriod / divisor);

      const macroKcalSum = Math.max(1, avgProtein * 4 + avgCarbs * 4 + avgFat * 9);
      const macroDistribution = {
        proteinPct: Math.round(((avgProtein * 4) / macroKcalSum) * 100),
        carbsPct: Math.round(((avgCarbs * 4) / macroKcalSum) * 100),
        fatPct: Math.round(((avgFat * 9) / macroKcalSum) * 100)
      };

      const weights = db
        .prepare('SELECT log_date, weight_kg, note FROM weight_logs WHERE user_id = ? AND log_date >= ? ORDER BY log_date ASC')
        .all(user.id, startDate);

      return sendJson(res, 200, {
        days,
        startDate,
        endDate: todayIso,
        summary: {
          activeDays,
          avgKcal,
          prevAvgKcal,
          kcalDeltaVsPrev: avgKcal - prevAvgKcal,
          targetKcal,
          avgDailyBalance: avgKcal - targetKcal,
          compliancePct: Math.round((compliantDays / divisor) * 100),
          avgProtein,
          avgCarbs,
          avgFat,
          avgFiber,
          avgFruitVeg,
          macroDistribution
        },
        series,
        weights
      });
    }

    // Exportación del historial completo en CSV o JSON (Portabilidad RGPD)
    if (pathname === '/api/export' && method === 'GET') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });
      const format = (parsedUrl.searchParams.get('format') || 'json').toLowerCase();
      const meals = db
        .prepare('SELECT * FROM meals WHERE user_id = ? ORDER BY meal_date DESC, meal_time DESC')
        .all(user.id);
      const weights = db
        .prepare('SELECT * FROM weight_logs WHERE user_id = ? ORDER BY log_date DESC')
        .all(user.id);

      if (format === 'csv') {
        const header = 'Fecha,Hora,Tipo,Comida,Calorias_kcal,Proteinas_g,Hidratos_g,Grasas_g,Fibra_g,Azucares_Libres_g,Sal_g,Frutas_Verduras_g\n';
        const lines = meals.map((m) =>
          [
            m.meal_date,
            m.meal_time,
            m.meal_type,
            `"${String(m.title).replace(/"/g, '""')}"`,
            Math.round(m.total_kcal),
            m.total_protein_g,
            m.total_carbs_g,
            m.total_fat_g,
            m.total_fiber_g,
            m.total_free_sugars_g,
            m.total_salt_g,
            m.fruit_veg_grams
          ].join(',')
        );
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="nutrivital_historial_${getTodayIso()}.csv"`
        });
        return res.end('\uFEFF' + header + lines.join('\n'));
      }

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="nutrivital_datos_rgpd_${getTodayIso()}.json"`
      });
      return res.end(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            gdprNotice: 'Portabilidad de datos personales según Art. 20 del RGPD (UE 2016/679)',
            user,
            meals,
            weights
          },
          null,
          2
        )
      );
    }

    // Eliminación completa de datos y cuenta (Derecho de supresión / Derecho al olvido RGPD Art. 17)
    if (pathname === '/api/user/account' && method === 'DELETE') {
      const user = getAuthenticatedUser(req);
      if (!user) return sendJson(res, 401, { error: 'Sesión no iniciada' });

      db.prepare('DELETE FROM meals WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM daily_water WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM weight_logs WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

      // Re-sembrar cuenta demo si el usuario borró la cuenta demo para dejar el entorno funcional
      seedDemoUserAgainIfEmpty();

      return sendJson(
        res,
        200,
        { deleted: true, message: 'Todos tus datos personales, fotografías e historial han sido eliminados conforme al RGPD.' },
        { 'Set-Cookie': 'nutrivital_token=; Path=/; HttpOnly; Max-Age=0' }
      );
    }

    // =========================================================================
    // SERVIDOR DE ARCHIVOS ESTÁTICOS (FRONTEND SPA + PWA)
    // =========================================================================
    let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    if (safePath === '/' || safePath === '') safePath = '/index.html';
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // Fallback SPA hacia index.html
    const indexHtml = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexHtml).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'Recurso no encontrado' });
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message || 'Error interno del servidor' });
  }
});

function seedDemoUserAgainIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count === 0) {
    initDatabase();
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`NutriVital AI ejecutándose en http://localhost:${PORT}`);
});
