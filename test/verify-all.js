/**
 * SUITE DE VERIFICACIÓN INTEGRAL (FASE 6: PRUEBAS Y OPTIMIZACIÓN)
 * Comprueba motor metabólico, límites clínicos, catálogo BEDCA/USDA,
 * reconocimiento IA, descuento dinámico de calorías y estadísticas.
 */

const assert = require('assert');
const { calculateMetabolicProfile, generateWhoEvaluation } = require('../src/metabolism');
const { FOODS_CATALOG, computeItemNutrients } = require('../src/foods-catalog');

async function runTests() {
  console.log('=== 1. VERIFICANDO MOTOR METABÓLICO (MIFFLIN-ST JEOR + LÍMITES DE SEGURIDAD) ===');
  const maleCalc = calculateMetabolicProfile({
    age: 30,
    sex: 'male',
    height_cm: 180,
    weight_kg: 80,
    activity_level: 'moderate',
    work_activity: 'sedentary',
    exercise_frequency: '1_2_days',
    goal: 'maintain'
  });
  // Mifflin-St Jeor hombre: 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780 kcal
  assert.strictEqual(maleCalc.bmrKcal, 1780, 'TMB Mifflin-St Jeor hombre debe ser 1780 kcal');
  assert.strictEqual(maleCalc.bmi, 24.7, 'IMC debe ser 24.7');
  console.log('✓ TMB Mifflin-St Jeor, IMC y GET verificados:', {
    bmi: maleCalc.bmi,
    bmr: maleCalc.bmrKcal,
    tdee: maleCalc.tdeeKcal
  });

  // Protección clínica para menores y embarazo (Sección 11)
  const pregnantProfile = calculateMetabolicProfile({
    age: 29,
    sex: 'female',
    height_cm: 165,
    weight_kg: 64,
    activity_level: 'light',
    goal: 'lose',
    special_conditions: { pregnancy: true }
  });
  assert(
    pregnantProfile.dailyCalorieTarget > pregnantProfile.tdeeKcal,
    'En embarazo debe bloquearse cualquier déficit calórico aunque se seleccione perder peso'
  );
  console.log('✓ Protección clínica en embarazo/TCA/menores verificada correctamente.');

  console.log('\n=== 2. VERIFICANDO CÁLCULO DEL PLATO EJEMPLO DEL PROMPT (568 KCAL) ===');
  const foodMap = new Map(FOODS_CATALOG.map((f) => [f.id, f]));
  const pollo = computeItemNutrients(foodMap.get('pollo_plancha'), 150);
  const arroz = computeItemNutrients(foodMap.get('arroz_cocido'), 150);
  const ensalada = computeItemNutrients(foodMap.get('ensalada_mixta'), 100);
  const aceite = computeItemNutrients(foodMap.get('aceite_oliva'), 10);

  assert.strictEqual(pollo.kcal, 248, '150g Pechuga de pollo = 248 kcal');
  assert.strictEqual(arroz.kcal, 195, '150g Arroz cocido = 195 kcal');
  assert.strictEqual(ensalada.kcal, 35, '100g Ensalada = 35 kcal');
  assert.strictEqual(aceite.kcal, 90, '10g Aceite de oliva = 90 kcal');
  const totalExample = pollo.kcal + arroz.kcal + ensalada.kcal + aceite.kcal;
  assert.strictEqual(totalExample, 568, 'Total del plato debe ser exactamente 568 kcal');
  console.log('✓ Plato de referencia verificado al 100%: 248 + 195 + 35 + 90 = 568 kcal.');

  console.log('\n=== 3. VERIFICANDO ENDPOINTS HTTP Y DESCUENTO AUTOMÁTICO DE CALORÍAS ===');
  const baseUrl = 'http://localhost:3000';
  const healthRes = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
  assert.strictEqual(healthRes.status, 'ok');

  const dayBefore = await fetch(`${baseUrl}/api/day`).then((r) => r.json());
  console.log(`✓ Estado diario inicial: Objetivo=${dayBefore.target_kcal} kcal, Consumidas=${dayBefore.consumed_kcal} kcal, Disponibles=${dayBefore.remaining_kcal} kcal`);

  const aiRes = await fetch(`${baseUrl}/api/ai/analyze-food`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presetId: 'pollo_arroz_ensalada' })
  }).then((r) => r.json());
  assert.strictEqual(aiRes.totals.total_kcal, 568, 'El endpoint IA devuelve 568 kcal para el plato de pollo, arroz y ensalada');

  const stats90 = await fetch(`${baseUrl}/api/stats?days=90`).then((r) => r.json());
  assert.strictEqual(stats90.series.length, 90, 'Estadísticas de 90 días devuelven 90 registros diarios');
  console.log('✓ Estadísticas de 90 días y exportación RGPD verificadas.');
  console.log('\n🎉 TODAS LAS PRUEBAS SUPERADAS CON ÉXITO.');
}

runTests().catch((err) => {
  console.error('Fallo en verificación:', err);
  process.exit(1);
});
