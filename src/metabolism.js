/**
 * MOTOR DE CÁLCULO DE NECESIDADES CALÓRICAS Y RECOMENDACIONES OMS
 * Basado en ecuaciones metabólicas clínicas validadas (Mifflin-St Jeor, 1990)
 * y en las directrices nutricionales oficiales de la Organización Mundial de la Salud (OMS).
 * Nota científica: La OMS establece directrices poblacionales sobre calidad de la dieta y
 * distribución de nutrientes, pero no promulga ecuaciones individuales como Mifflin-St Jeor.
 */

const ACTIVITY_FACTORS = {
  sedentary: {
    factor: 1.2,
    label: 'Sedentario',
    description: 'Poca o ninguna actividad física diaria'
  },
  light: {
    factor: 1.375,
    label: 'Ligero',
    description: 'Actividad física ocasional (1 a 2 días por semana)'
  },
  moderate: {
    factor: 1.55,
    label: 'Moderado',
    description: 'Ejercicio moderado entre 3 y 5 días por semana'
  },
  high: {
    factor: 1.725,
    label: 'Alto',
    description: 'Ejercicio intenso y frecuente (6 a 7 días por semana)'
  },
  very_high: {
    factor: 1.9,
    label: 'Muy alto',
    description: 'Actividad física o trabajo físico muy exigente'
  }
};

const WORK_ADJUSTMENTS = {
  sedentary: 0,      // Trabajo de oficina / sentado
  standing: 0.04,    // De pie / comercio / docencia
  walking: 0.08,     // Caminata continua / reparto / hostelería
  heavy: 0.14        // Trabajo físico intenso / construcción / campo
};

const EXERCISE_ADJUSTMENTS = {
  none: -0.02,
  '1_2_days': 0,
  '3_4_days': 0.03,
  '5_6_days': 0.06,
  daily: 0.09
};

const GOAL_LABELS = {
  maintain: 'Mantener mi peso actual',
  lose: 'Perder peso de forma progresiva',
  gain: 'Ganar peso',
  improve_habits: 'Mejorar mis hábitos alimenticios'
};

function calculateMetabolicProfile(input) {
  const age = Math.max(10, Math.min(110, Number(input.age) || 30));
  const sex = input.sex === 'male' ? 'male' : 'female';
  const heightCm = Math.max(100, Math.min(240, Number(input.height_cm) || 168));
  const weightKg = Math.max(25, Math.min(300, Number(input.weight_kg) || 68));
  const activityLevel = ACTIVITY_FACTORS[input.activity_level] ? input.activity_level : 'moderate';
  const workActivity = WORK_ADJUSTMENTS[input.work_activity] !== undefined ? input.work_activity : 'sedentary';
  const exerciseFrequency = EXERCISE_ADJUSTMENTS[input.exercise_frequency] !== undefined ? input.exercise_frequency : '3_4_days';
  const goal = GOAL_LABELS[input.goal] ? input.goal : 'maintain';

  const specialConditions = input.special_conditions || {};
  const isMinor = age < 18 || Boolean(specialConditions.minor);
  const isPregnant = Boolean(specialConditions.pregnancy);
  const isLactating = Boolean(specialConditions.lactation);
  const hasEatingDisorder = Boolean(specialConditions.eating_disorder);
  const hasMedicalCondition = Boolean(specialConditions.medical_condition);
  const requiresClinicalProtection = isMinor || isPregnant || isLactating || hasEatingDisorder || hasMedicalCondition;

  // 1. Índice de Masa Corporal (IMC = kg / m^2)
  const heightM = heightCm / 100;
  const bmi = Number((weightKg / (heightM * heightM)).toFixed(1));
  let bmiCategory = 'Normopeso';
  if (bmi < 18.5) bmiCategory = 'Bajo peso';
  else if (bmi < 25) bmiCategory = 'Peso saludable (Normopeso)';
  else if (bmi < 30) bmiCategory = 'Sobrepeso';
  else if (bmi < 35) bmiCategory = 'Obesidad grado I';
  else bmiCategory = 'Obesidad grado II+';

  // Peso saludable orientativo (rango IMC 18.5 - 24.9)
  const healthyWeightMin = Number((18.5 * heightM * heightM).toFixed(1));
  const healthyWeightMax = Number((24.9 * heightM * heightM).toFixed(1));
  const healthyWeightMid = Number((21.7 * heightM * heightM).toFixed(1));

  let targetWeightKg = input.target_weight_kg ? Number(input.target_weight_kg) : null;
  if (!targetWeightKg || Number.isNaN(targetWeightKg)) {
    if (goal === 'lose' && weightKg > healthyWeightMid) {
      targetWeightKg = Number(Math.max(healthyWeightMid, weightKg - 4).toFixed(1));
    } else if (goal === 'gain' && weightKg < healthyWeightMid) {
      targetWeightKg = Number(Math.min(healthyWeightMid, weightKg + 3).toFixed(1));
    } else {
      targetWeightKg = weightKg;
    }
  }

  // 2. Metabolismo Basal (TMB) — Ecuación validada de Mifflin-St Jeor (1990)
  // Hombres: (10 x peso) + (6.25 x altura) - (5 x edad) + 5
  // Mujeres: (10 x peso) + (6.25 x altura) - (5 x edad) - 161
  const bmrRaw = (10 * weightKg) + (6.25 * heightCm) - (5 * age) + (sex === 'male' ? 5 : -161);
  const bmrKcal = Math.round(bmrRaw);

  // 3. Gasto Energético Total Diario (GET / TDEE)
  const baseFactor = ACTIVITY_FACTORS[activityLevel].factor;
  const workMod = WORK_ADJUSTMENTS[workActivity] || 0;
  const exMod = EXERCISE_ADJUSTMENTS[exerciseFrequency] || 0;
  const effectiveFactor = Number(Math.min(2.1, Math.max(1.2, baseFactor + (workMod * 0.5) + (exMod * 0.4))).toFixed(3));
  const tdeeKcal = Math.round(bmrKcal * effectiveFactor);

  // 4. Objetivo Calórico Diario con límites de seguridad clínica
  const minSafeFloor = sex === 'male' ? 1500 : 1200;
  const safetyFloor = Math.max(minSafeFloor, bmrKcal);
  const warnings = [];
  let appliedDelta = 0;
  let dailyCalorieTarget = tdeeKcal;

  if (requiresClinicalProtection) {
    // Protección estricta para perfiles vulnerables (Sección 11)
    if (isPregnant) {
      appliedDelta = 300;
      dailyCalorieTarget = tdeeKcal + 300;
      warnings.push('Perfil de embarazo activo: se ha desactivado cualquier déficit calórico y se recomienda seguimiento obstétrico y nutricional profesional.');
    } else if (isLactating) {
      appliedDelta = 450;
      dailyCalorieTarget = tdeeKcal + 450;
      warnings.push('Perfil de lactancia activo: se prioriza cubrir el gasto energético aumentado sin restricciones calóricas.');
    } else if (hasEatingDisorder) {
      appliedDelta = 0;
      dailyCalorieTarget = Math.max(tdeeKcal, safetyFloor);
      warnings.push('Modo de bienestar no restrictivo activado: por precaución ante TCA, no se aplican déficits calóricos. Prioriza el acompañamiento profesional.');
    } else if (isMinor) {
      appliedDelta = 0;
      dailyCalorieTarget = Math.max(tdeeKcal, safetyFloor);
      warnings.push('Usuario menor de 18 años: en etapa de crecimiento no se generan objetivos calóricos restrictivos sin supervisión pediátrica o de un dietista-nutricionista.');
    } else if (hasMedicalCondition) {
      appliedDelta = 0;
      dailyCalorieTarget = Math.max(tdeeKcal, safetyFloor);
      warnings.push('Condición médica indicada: el objetivo se mantiene en equilibrio energético orientativo. Consulta siempre con tu especialista.');
    }
  } else if (goal === 'lose') {
    if (bmi < 19.0) {
      appliedDelta = 0;
      dailyCalorieTarget = tdeeKcal;
      warnings.push('Tu IMC actual ya se encuentra en el límite inferior del rango saludable; se establece mantenimiento en lugar de déficit.');
    } else {
      // Déficit moderado y prudente: 15% del GET (entre 300 y 500 kcal), sin bajar del límite de seguridad
      const prudentDeficit = Math.min(500, Math.max(300, Math.round(tdeeKcal * 0.16)));
      dailyCalorieTarget = Math.max(safetyFloor, tdeeKcal - prudentDeficit);
      appliedDelta = dailyCalorieTarget - tdeeKcal;
      if (dailyCalorieTarget === safetyFloor) {
        warnings.push(`El objetivo se ha ajustado al límite prudente de seguridad (${safetyFloor} kcal/día) para proteger tu metabolismo basal.`);
      }
    }
  } else if (goal === 'gain') {
    const prudentSurplus = Math.min(450, Math.max(280, Math.round(tdeeKcal * 0.14)));
    dailyCalorieTarget = tdeeKcal + prudentSurplus;
    appliedDelta = prudentSurplus;
  } else {
    dailyCalorieTarget = tdeeKcal;
    appliedDelta = 0;
  }

  // 5. Distribución de macronutrientes y límites OMS
  // Proteínas: 22% (o ~1.4-1.8g/kg), Hidratos: 48%, Grasas saludables: 30%
  const proteinRatio = goal === 'lose' || goal === 'gain' ? 0.25 : 0.20;
  const fatRatio = 0.30;
  const carbsRatio = Number((1 - proteinRatio - fatRatio).toFixed(2));

  const proteinGrams = Math.round((dailyCalorieTarget * proteinRatio) / 4);
  const carbsGrams = Math.round((dailyCalorieTarget * carbsRatio) / 4);
  const fatGrams = Math.round((dailyCalorieTarget * fatRatio) / 9);

  // Límites orientativos basados en directrices oficiales de la OMS:
  // - Azúcares libres: < 10% de la ingesta energética total (y beneficio adicional < 5%)
  // - Grasas saturadas: < 10% de la ingesta energética total
  // - Grasas trans: < 1% de la ingesta energética total
  // - Frutas y verduras: >= 400 g/día (5 raciones)
  // - Sal: < 5 g/día (< 2 g sodio/día)
  // - Fibra dietética: >= 25 g/día
  const whoLimits = {
    freeSugarsMax10PctGrams: Math.round((dailyCalorieTarget * 0.10) / 4),
    freeSugarsIdeal5PctGrams: Math.round((dailyCalorieTarget * 0.05) / 4),
    saturatedFatMaxGrams: Math.round((dailyCalorieTarget * 0.10) / 9),
    transFatMaxGrams: Number(((dailyCalorieTarget * 0.01) / 9).toFixed(1)),
    fruitVegMinGrams: 400,
    fiberMinGrams: 25,
    saltMaxGrams: 5.0
  };

  // Hidratación orientativa: ~35 ml por kg de peso corporal (ajustado por actividad)
  const waterTargetMl = Math.round((weightKg * 35 + (effectiveFactor > 1.5 ? 400 : 0)) / 50) * 50;

  return {
    bmi,
    bmiCategory,
    healthyWeightRange: { min: healthyWeightMin, max: healthyWeightMax, ideal: healthyWeightMid },
    targetWeightKg,
    bmrKcal,
    tdeeKcal,
    effectiveActivityFactor: effectiveFactor,
    dailyCalorieTarget,
    appliedDelta,
    safetyFloor,
    requiresClinicalProtection,
    warnings,
    macroTargets: {
      proteinGrams,
      carbsGrams,
      fatGrams,
      proteinPct: Math.round(proteinRatio * 100),
      carbsPct: Math.round(carbsRatio * 100),
      fatPct: Math.round(fatRatio * 100),
      ...whoLimits
    },
    waterTargetMl,
    methodologyNote:
      'Estimación calculada mediante la ecuación clínica de Mifflin-St Jeor (1990) combinada con factores de actividad física. Los objetivos de calidad nutricional (azúcares libres <10%, grasas saturadas <10%, sal <5g/día y ≥400g de frutas y hortalizas) siguen las directrices oficiales de la Organización Mundial de la Salud (OMS). Estos valores son estimaciones orientativas y no mediciones calorimétricas exactas.'
  };
}

/**
 * Genera consejos inteligentes personalizados y evaluación OMS a partir del consumo diario
 */
function generateWhoEvaluation(dailyTotals, userProfile) {
  const macroTargets = typeof userProfile.macro_targets_json === 'string'
    ? JSON.parse(userProfile.macro_targets_json)
    : (userProfile.macroTargets || {});

  const targetKcal = userProfile.daily_calorie_target || 2000;
  const maxFreeSugars = macroTargets.freeSugarsMax10PctGrams || Math.round((targetKcal * 0.10) / 4);
  const idealFreeSugars = macroTargets.freeSugarsIdeal5PctGrams || Math.round((targetKcal * 0.05) / 4);
  const maxSatFat = macroTargets.saturatedFatMaxGrams || Math.round((targetKcal * 0.10) / 9);
  const minFiber = macroTargets.fiberMinGrams || 25;
  const minFruitVeg = macroTargets.fruitVegMinGrams || 400;
  const maxSalt = macroTargets.saltMaxGrams || 5.0;

  const consumedKcal = dailyTotals.total_kcal || 0;
  const fruitVegGrams = dailyTotals.fruit_veg_grams || 0;
  const fiberGrams = dailyTotals.total_fiber_g || 0;
  const freeSugarsGrams = dailyTotals.total_free_sugars_g || 0;
  const satFatGrams = dailyTotals.total_saturated_fat_g || 0;
  const saltGrams = dailyTotals.total_salt_g || 0;
  const proteinGrams = dailyTotals.total_protein_g || 0;
  const waterMl = dailyTotals.water_ml || 0;
  const waterTargetMl = userProfile.water_target_ml || 2000;
  const mealsCount = dailyTotals.meals_count || 0;
  const hasLegumes = Boolean(dailyTotals.has_legumes);
  const hasWholeGrains = Boolean(dailyTotals.has_whole_grains);

  const tips = [];

  if (mealsCount === 0) {
    tips.push({
      type: 'info',
      icon: 'camera',
      title: 'Comienza tu registro de hoy',
      message: 'Pulsa «FOTOGRAFIAR MI COMIDA» para analizar tu primer plato o regístralo desde el buscador BEDCA/USDA.'
    });
  } else {
    // 1. Frutas y verduras (OMS: >= 400 g/día)
    if (fruitVegGrams === 0) {
      tips.push({
        type: 'warning',
        icon: 'apple',
        title: 'Frutas y verduras pendientes hoy',
        message: 'Hoy todavía no has registrado ninguna ración de fruta ni verdura. La OMS recomienda alcanzar al menos 400 g diarios (unas 5 raciones).'
      });
    } else if (fruitVegGrams < 250) {
      tips.push({
        type: 'info',
        icon: 'salad',
        title: `Llevas ${Math.round(fruitVegGrams)} g de frutas y verduras`,
        message: `Vas por buen camino. Añadir una guarnición de verdura o una pieza de fruta en tu próxima comida te acercará a los 400 g/día recomendados por la OMS.`
      });
    } else if (fruitVegGrams >= 400) {
      tips.push({
        type: 'positive',
        icon: 'check',
        title: 'Objetivo OMS de frutas y verduras cumplido',
        message: `¡Excelente! Has alcanzado ${Math.round(fruitVegGrams)} g de frutas y hortalizas frescas hoy, superando el mínimo de 400 g/día de la OMS.`
      });
    }

    // 2. Fibra dietética (OMS: >= 25 g/día)
    if (consumedKcal > 800 && fiberGrams < 12) {
      tips.push({
        type: 'warning',
        icon: 'grain',
        title: 'Alimentación de hoy baja en fibra',
        message: `Llevas ${fiberGrams.toFixed(1)} g de fibra (recomendación OMS: ≥${minFiber} g/día). Priorizar legumbres, cereales integrales o fruta entera mejorará tu saciedad.`
      });
    } else if (fiberGrams >= minFiber) {
      tips.push({
        type: 'positive',
        icon: 'grain',
        title: 'Óptimo aporte de fibra dietética',
        message: `Has registrado ${fiberGrams.toFixed(1)} g de fibra hoy, favoreciendo la salud digestiva y el control glucémico.`
      });
    }

    // 3. Azúcares libres (OMS: <10% energía total y condicional <5%)
    if (freeSugarsGrams > maxFreeSugars) {
      tips.push({
        type: 'alert',
        icon: 'sugar',
        title: 'Atención al consumo de azúcares libres',
        message: `Has registrado ${freeSugarsGrams.toFixed(1)} g de azúcares libres (límite orientativo OMS <10%: ${maxFreeSugars} g). Para las siguientes tomas, prioriza agua, lácteos naturales sin azucarar y fruta fresca entera.`
      });
    } else if (freeSugarsGrams <= idealFreeSugars) {
      tips.push({
        type: 'positive',
        icon: 'sparkle',
        title: 'Azúcares libres bajo el umbral óptimo (<5%)',
        message: `Mantienes los azúcares libres en ${freeSugarsGrams.toFixed(1)} g, cumpliendo la recomendación condicional más exigente de la OMS (<${idealFreeSugars} g/día).`
      });
    }

    // 4. Grasas saturadas (OMS: <10% energía total)
    if (satFatGrams > maxSatFat) {
      tips.push({
        type: 'warning',
        icon: 'heart',
        title: 'Cantidad elevada de grasas saturadas',
        message: `Hoy llevas ${satFatGrams.toFixed(1)} g de grasas saturadas (límite orientativo OMS: ${maxSatFat} g). Puedes equilibrar tus próximas comidas usando aceite de oliva virgen extra, pescado o proteínas magras.`
      });
    }

    // 5. Sal / Sodio (OMS: < 5 g de sal al día)
    if (saltGrams > maxSalt) {
      tips.push({
        type: 'warning',
        icon: 'salt',
        title: 'Vigilancia del consumo de sal',
        message: `Has superado los ${maxSalt} g de sal diarios recomendados por la OMS (${saltGrams.toFixed(1)} g). Utilizar especias, hierbas aromáticas y limón ayuda a potenciar el sabor reduciendo el sodio.`
      });
    }

    // 6. Proteínas y completitud nutricional
    const targetProtein = macroTargets.proteinGrams || 100;
    if (consumedKcal > targetKcal * 0.45 && proteinGrams < targetProtein * 0.4) {
      tips.push({
        type: 'info',
        icon: 'protein',
        title: 'Sugerencia para tu próxima comida',
        message: 'Puedes completar tu próxima comida con una fuente saludable de proteínas (legumbres, pescado, huevo o ave) acompañada de verduras.'
      });
    }
  }

  // 7. Hidratación
  if (waterMl < waterTargetMl * 0.4) {
    tips.push({
      type: 'info',
      icon: 'water',
      title: 'Recuerda mantener una hidratación adecuada',
      message: `Llevas ${waterMl} ml de agua registrados hoy de tu meta orientativa de ${waterTargetMl} ml. El agua debe ser siempre la bebida de referencia.`
    });
  }

  const indicators = [
    {
      id: 'fruit_veg',
      label: 'Frutas y hortalizas (OMS ≥ 400 g)',
      current: Math.round(fruitVegGrams),
      target: minFruitVeg,
      unit: 'g',
      mode: 'min',
      status: fruitVegGrams >= minFruitVeg ? 'optimal' : fruitVegGrams >= 200 ? 'moderate' : 'low'
    },
    {
      id: 'fiber',
      label: 'Fibra dietética (OMS ≥ 25 g)',
      current: Number(fiberGrams.toFixed(1)),
      target: minFiber,
      unit: 'g',
      mode: 'min',
      status: fiberGrams >= minFiber ? 'optimal' : fiberGrams >= 14 ? 'moderate' : 'low'
    },
    {
      id: 'free_sugars',
      label: `Azúcares libres (OMS < 10% / ${maxFreeSugars} g)`,
      current: Number(freeSugarsGrams.toFixed(1)),
      target: maxFreeSugars,
      ideal: idealFreeSugars,
      unit: 'g',
      mode: 'max',
      status: freeSugarsGrams <= idealFreeSugars ? 'optimal' : freeSugarsGrams <= maxFreeSugars ? 'moderate' : 'high'
    },
    {
      id: 'saturated_fat',
      label: `Grasas saturadas (OMS < 10% / ${maxSatFat} g)`,
      current: Number(satFatGrams.toFixed(1)),
      target: maxSatFat,
      unit: 'g',
      mode: 'max',
      status: satFatGrams <= maxSatFat * 0.8 ? 'optimal' : satFatGrams <= maxSatFat ? 'moderate' : 'high'
    },
    {
      id: 'salt',
      label: 'Sal equivalente (OMS < 5 g/día)',
      current: Number(saltGrams.toFixed(1)),
      target: maxSalt,
      unit: 'g',
      mode: 'max',
      status: saltGrams <= 3.8 ? 'optimal' : saltGrams <= maxSalt ? 'moderate' : 'high'
    }
  ];

  return {
    tips,
    indicators,
    qualitativeBadges: {
      hasLegumes,
      hasWholeGrains,
      fruitVegPortions: Number((fruitVegGrams / 80).toFixed(1))
    }
  };
}

module.exports = {
  ACTIVITY_FACTORS,
  GOAL_LABELS,
  calculateMetabolicProfile,
  generateWhoEvaluation
};
