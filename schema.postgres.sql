-- =============================================================================
-- ESQUEMA DE BASE DE DATOS POSTGRESQL / SQL — NUTRIVITAL AI
-- Cumple con RGPD, aislamiento por usuario, auditoría y precisión nutricional
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  age INTEGER NOT NULL CHECK (age >= 10 AND age <= 120),
  sex TEXT NOT NULL CHECK (sex IN ('male', 'female')),
  height_cm REAL NOT NULL CHECK (height_cm >= 100 AND height_cm <= 250),
  weight_kg REAL NOT NULL CHECK (weight_kg >= 25 AND weight_kg <= 350),
  target_weight_kg REAL,
  activity_level TEXT NOT NULL CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'high', 'very_high')),
  work_activity TEXT NOT NULL DEFAULT 'sedentary',
  exercise_frequency TEXT NOT NULL DEFAULT '3_4_days',
  goal TEXT NOT NULL CHECK (goal IN ('maintain', 'lose', 'gain', 'improve_habits')),
  special_conditions_json TEXT NOT NULL DEFAULT '{}',
  bmi REAL NOT NULL,
  bmr_kcal INTEGER NOT NULL,
  tdee_kcal INTEGER NOT NULL,
  daily_calorie_target INTEGER NOT NULL,
  macro_targets_json TEXT NOT NULL,
  water_target_ml INTEGER NOT NULL DEFAULT 2000,
  reminders_json TEXT NOT NULL DEFAULT '{"meals":true,"water":true,"breakfastTime":"08:30","lunchTime":"14:00","dinnerTime":"21:00","waterIntervalMin":120}',
  gdpr_consent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  preparation_state TEXT NOT NULL DEFAULT 'cooked', -- 'raw' | 'cooked' | 'ready'
  paired_food_id TEXT, -- vínculo entre versión cruda y cocinada
  kcal_per_100g REAL NOT NULL,
  protein_per_100g REAL NOT NULL,
  carbs_per_100g REAL NOT NULL,
  fat_per_100g REAL NOT NULL,
  saturated_fat_per_100g REAL NOT NULL DEFAULT 0,
  trans_fat_per_100g REAL NOT NULL DEFAULT 0,
  fiber_per_100g REAL NOT NULL DEFAULT 0,
  sugars_per_100g REAL NOT NULL DEFAULT 0,
  free_sugars_per_100g REAL NOT NULL DEFAULT 0,
  salt_g_per_100g REAL NOT NULL DEFAULT 0,
  default_portion_g INTEGER NOT NULL DEFAULT 100,
  source TEXT NOT NULL DEFAULT 'BEDCA', -- 'BEDCA' | 'USDA' | 'PERSONALIZADO'
  source_code TEXT,
  barcode TEXT,
  is_who_fruit_veg INTEGER NOT NULL DEFAULT 0,
  is_who_legume INTEGER NOT NULL DEFAULT 0,
  is_who_whole_grain INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_date TEXT NOT NULL, -- YYYY-MM-DD
  meal_time TEXT NOT NULL, -- HH:MM
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'mid_morning', 'lunch', 'snack', 'dinner', 'other')),
  title TEXT NOT NULL,
  photo_url TEXT,
  items_json TEXT NOT NULL, -- Lista detallada con gramos, calorías, macros, fuente BEDCA/USDA
  total_kcal REAL NOT NULL,
  total_protein_g REAL NOT NULL,
  total_carbs_g REAL NOT NULL,
  total_fat_g REAL NOT NULL,
  total_saturated_fat_g REAL NOT NULL DEFAULT 0,
  total_fiber_g REAL NOT NULL DEFAULT 0,
  total_sugars_g REAL NOT NULL DEFAULT 0,
  total_free_sugars_g REAL NOT NULL DEFAULT 0,
  total_salt_g REAL NOT NULL DEFAULT 0,
  fruit_veg_grams REAL NOT NULL DEFAULT 0,
  ai_confidence REAL NOT NULL DEFAULT 0.9,
  ai_confidence_label TEXT NOT NULL DEFAULT 'Alta',
  ai_notes TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  dedup_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, meal_date);

CREATE TABLE IF NOT EXISTS daily_water (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  water_ml INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, log_date)
);

CREATE TABLE IF NOT EXISTS weight_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  weight_kg REAL NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, log_date)
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
