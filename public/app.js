/**
 * NUTRIVITAL AI — LÓGICA DE APLICACIÓN FRONTEND (SPA + PWA)
 * Conecta cámara móvil, reconocimiento de alimentos por IA en servidor,
 * recálculo en vivo con base de datos BEDCA/USDA, descuento automático de calorías,
 * estadísticas de 7/30/60/90 días y gestión de perfil metabólico.
 */

const state = {
  user: null,
  selectedDate: null,
  todayDate: null,
  daySummary: null,
  foodsCatalog: [],
  currentAnalysis: null,
  cameraStream: null,
  statsRangeDays: 7,
  theme: localStorage.getItem('nutrivital_theme') || 'light'
};

const MEAL_TYPE_LABELS = {
  breakfast: '🌅 Desayuno',
  mid_morning: '🍎 Media mañana',
  lunch: '☀️ Comida',
  snack: '🥨 Merienda',
  dinner: '🌙 Cena',
  other: '🍽️ Otros'
};

const GOAL_NAMES = {
  maintain: 'Mantener peso',
  lose: 'Pérdida progresiva',
  gain: 'Ganar peso',
  improve_habits: 'Mejorar hábitos'
};

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  if (type === 'success') el.style.borderLeft = '4px solid #22C55E';
  else if (type === 'warning') el.style.borderLeft = '4px solid #F59E0B';
  else if (type === 'danger') el.style.borderLeft = '4px solid #EF4444';
  else el.style.borderLeft = '4px solid #38BDF8';

  el.innerHTML = `<span>${message}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 3400);
}

async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }
  return data;
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('nutrivital_theme', theme);
  const btn = document.getElementById('btn-toggle-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}

function switchScreen(screenName) {
  document.querySelectorAll('.screen-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `screen-${screenName}`);
  });
  document.querySelectorAll('.bottom-nav .nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.screen === screenName);
  });

  if (screenName !== 'camera' && state.cameraStream) {
    stopLiveCamera();
  }
  if (screenName === 'stats') {
    loadStats(state.statsRangeDays);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString('es-ES');
}

// ============================================================================
// CARGA INICIAL Y SINCRONIZACIÓN DE ESTADO DIARIO
// ============================================================================

async function initApp() {
  applyTheme(state.theme);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  try {
    const [{ user, today }, { foods }] = await Promise.all([
      apiFetch('/api/user/profile'),
      apiFetch('/api/foods')
    ]);
    state.user = user;
    state.todayDate = today;
    state.selectedDate = today;
    state.foodsCatalog = foods || [];

    const datePicker = document.getElementById('input-date-picker');
    if (datePicker) datePicker.value = today;

    renderUserProfileHeader();
    populateProfileForm();
    renderFoodSearchResults();
    await loadDaySummary(state.selectedDate);
    await runSampleAnalysis('pollo_arroz_ensalada', '/assets/meals/pollo_arroz_ensalada.jpg', true);
    updateWizardLivePreview();
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

function renderUserProfileHeader() {
  if (!state.user) return;
  const greeting = document.getElementById('header-user-greeting');
  if (greeting) {
    greeting.textContent = `${state.user.name} · IMC ${state.user.bmi} (${GOAL_NAMES[state.user.goal] || 'Salud'})`;
  }
  const goalBadge = document.getElementById('hero-goal-badge');
  if (goalBadge) {
    goalBadge.textContent = GOAL_NAMES[state.user.goal] || 'Objetivo diario';
  }
  const bmrBadge = document.getElementById('hero-bmr-badge');
  if (bmrBadge) {
    bmrBadge.textContent = `TMB ${formatNumber(state.user.bmr_kcal)} · GET ${formatNumber(state.user.tdee_kcal)} kcal`;
  }
}

async function loadDaySummary(dateStr) {
  state.selectedDate = dateStr;
  const datePicker = document.getElementById('input-date-picker');
  if (datePicker && datePicker.value !== dateStr) {
    datePicker.value = dateStr;
  }
  const label = document.getElementById('current-date-label');
  if (label) {
    label.textContent = dateStr === state.todayDate ? 'Hoy' : dateStr;
  }

  const summary = await apiFetch(`/api/day?date=${encodeURIComponent(dateStr)}`);
  state.daySummary = summary;
  renderDashboard(summary);
  renderHistoryScreen(summary);
}

// ============================================================================
// RENDERIZADO DEL PANEL PRINCIPAL (CONTADOR CIRCULAR, MACROS, OMS, COMIDAS)
// ============================================================================

function renderDashboard(summary) {
  const target = summary.target_kcal || 2000;
  const consumed = summary.consumed_kcal || 0;
  const remaining = summary.remaining_kcal;
  const pct = summary.progress_pct || 0;

  // Actualizar textos numéricos principales
  document.getElementById('stat-target-kcal').textContent = `${formatNumber(target)} kcal`;
  document.getElementById('stat-consumed-kcal').textContent = `${formatNumber(consumed)} kcal`;
  document.getElementById('stat-remaining-kcal').textContent =
    remaining >= 0 ? `${formatNumber(remaining)} kcal` : `+${formatNumber(Math.abs(remaining))} kcal (exceso)`;

  const ringNum = document.getElementById('ring-remaining-number');
  const ringLabel = document.getElementById('ring-remaining-label');
  const ringPct = document.getElementById('ring-progress-pct');

  if (remaining >= 0) {
    ringNum.textContent = formatNumber(remaining);
    ringLabel.textContent = 'kcal disponibles';
    ringLabel.style.color = 'var(--primary)';
  } else {
    ringNum.textContent = `+${formatNumber(Math.abs(remaining))}`;
    ringLabel.textContent = 'kcal sobre objetivo';
    ringLabel.style.color = 'var(--danger)';
  }
  ringPct.textContent = `${pct}% del objetivo diario`;

  // Animación del anillo circular (r = 74 -> circunferencia = 465)
  const circle = document.getElementById('calorie-ring-progress');
  const circumference = 465;
  const clampedRatio = Math.min(1, Math.max(0, consumed / Math.max(1, target)));
  circle.style.strokeDashoffset = String(Math.round(circumference * (1 - clampedRatio)));
  if (consumed > target * 1.08) {
    circle.style.stroke = 'var(--danger)';
  } else if (consumed > target * 0.92) {
    circle.style.stroke = 'var(--warning)';
  } else {
    circle.style.stroke = 'var(--primary)';
  }

  // Macronutrientes
  const mt = summary.macroTargets || { proteinGrams: 110, carbsGrams: 210, fatGrams: 60, fiberMinGrams: 25 };
  const tot = summary.totals || {};

  const pPct = Math.min(100, Math.round(((tot.total_protein_g || 0) / Math.max(1, mt.proteinGrams)) * 100));
  document.getElementById('macro-protein-pct').textContent = `${pPct}%`;
  document.getElementById('macro-protein-val').textContent = `${tot.total_protein_g || 0} / ${mt.proteinGrams} g`;
  document.getElementById('macro-protein-bar').style.width = `${pPct}%`;

  const cPct = Math.min(100, Math.round(((tot.total_carbs_g || 0) / Math.max(1, mt.carbsGrams)) * 100));
  document.getElementById('macro-carbs-pct').textContent = `${cPct}%`;
  document.getElementById('macro-carbs-val').textContent = `${tot.total_carbs_g || 0} / ${mt.carbsGrams} g`;
  document.getElementById('macro-carbs-bar').style.width = `${cPct}%`;
  document.getElementById('macro-fiber-sub').textContent = `Fibra: ${tot.total_fiber_g || 0} / ${mt.fiberMinGrams || 25} g`;

  const fPct = Math.min(100, Math.round(((tot.total_fat_g || 0) / Math.max(1, mt.fatGrams)) * 100));
  document.getElementById('macro-fat-pct').textContent = `${fPct}%`;
  document.getElementById('macro-fat-val').textContent = `${tot.total_fat_g || 0} / ${mt.fatGrams} g`;
  document.getElementById('macro-fat-bar').style.width = `${fPct}%`;
  document.getElementById('macro-satfat-sub').textContent = `Saturadas: ${tot.total_saturated_fat_g || 0} / ${mt.saturatedFatMaxGrams || 20} g`;

  // Agua e indicadores rápidos
  const waterMl = summary.water_ml || 0;
  const waterTarget = summary.water_target_ml || 2000;
  const waterPct = Math.min(100, Math.round((waterMl / Math.max(1, waterTarget)) * 100));
  document.getElementById('water-status-text').textContent = `${formatNumber(waterMl)} / ${formatNumber(waterTarget)} ml`;
  document.getElementById('water-progress-bar').style.width = `${waterPct}%`;
  document.getElementById('water-glasses-count').textContent = `${Math.round(waterMl / 250)} vasos`;

  document.getElementById('meals-count-badge').textContent = `${(summary.meals || []).length} comidas`;
  document.getElementById('dash-fruit-veg-g').textContent = `${tot.fruit_veg_grams || 0} g`;

  // Consejos inteligentes y criterios OMS
  renderWhoEvaluation(summary.whoEvaluation);

  // Cronología de comidas del día
  renderMealsList('dashboard-meals-list', summary.meals || []);
}

function renderWhoEvaluation(whoEval) {
  const tipsContainer = document.getElementById('who-tips-container');
  const indContainer = document.getElementById('who-indicators-container');
  if (!whoEval || !tipsContainer || !indContainer) return;

  tipsContainer.innerHTML = (whoEval.tips || [])
    .map(
      (t) => `
      <div class="tip-banner ${t.type}">
        <div>
          <div class="tip-title">${t.title}</div>
          <div class="tip-message">${t.message}</div>
        </div>
      </div>
    `
    )
    .join('');

  indContainer.innerHTML = (whoEval.indicators || [])
    .map((ind) => {
      const pct = Math.min(100, Math.round((ind.current / Math.max(1, ind.target)) * 100));
      let barColor = 'var(--primary)';
      if (ind.mode === 'max') {
        barColor = ind.status === 'high' ? 'var(--danger)' : ind.status === 'moderate' ? 'var(--warning)' : 'var(--primary)';
      } else {
        barColor = ind.status === 'optimal' ? 'var(--primary)' : ind.status === 'moderate' ? 'var(--warning)' : 'var(--info)';
      }
      return `
        <div class="who-indicator-item">
          <div class="who-indicator-top">
            <span>${ind.label}</span>
            <span style="font-family:var(--font-mono); font-weight:800;">${ind.current} / ${ind.target} ${ind.unit}</span>
          </div>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" style="width:${pct}%; background:${barColor};"></div>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderMealsList(containerId, meals) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!meals || meals.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:22px; color:var(--text-muted); font-size:0.84rem;">
        Todavía no hay comidas registradas en esta fecha. Pulsa «FOTOGRAFIAR MI COMIDA» para añadir la primera.
      </div>
    `;
    return;
  }

  container.innerHTML = meals
    .map((meal) => {
      const itemNames = (meal.items || []).map((i) => `${i.name.split('(')[0].trim()} (${i.grams}g)`).join(' · ');
      return `
        <article class="meal-card">
          <img src="${meal.photo_url || '/assets/meals/pollo_arroz_ensalada.jpg'}" alt="${meal.title}" class="meal-thumb" />
          <div class="meal-info">
            <div class="meal-meta-row">
              <span class="meal-type-tag">${MEAL_TYPE_LABELS[meal.meal_type] || 'Comida'}</span>
              <span class="meal-time-text">${meal.meal_time}</span>
              <span class="badge badge-green" style="font-size:0.65rem; padding:1px 6px;">IA: ${meal.ai_confidence_label || 'Alta'}</span>
            </div>
            <div class="meal-title" title="${meal.title}">${meal.title}</div>
            <div class="meal-macros-inline">${itemNames}</div>
            <div class="meal-macros-inline" style="font-family:var(--font-mono); font-size:0.71rem;">
              P: ${meal.total_protein_g}g · H: ${meal.total_carbs_g}g · G: ${meal.total_fat_g}g · Fibra: ${meal.total_fiber_g}g
            </div>
          </div>
          <div class="meal-right-col">
            <div class="meal-kcal-badge">${meal.total_kcal} kcal</div>
            <div class="meal-actions-row">
              <button type="button" class="btn-sm meal-detail-btn" data-meal-id="${meal.id}" title="Ver detalle y editar">Detalle</button>
              <button type="button" class="btn-sm meal-delete-btn" data-meal-id="${meal.id}" style="color:var(--danger);" title="Eliminar comida">✕</button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  container.querySelectorAll('.meal-detail-btn').forEach((btn) => {
    btn.addEventListener('click', () => openMealDetailModal(btn.dataset.mealId));
  });
  container.querySelectorAll('.meal-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteMeal(btn.dataset.mealId));
  });
}

// ============================================================================
// CÁMARA MÓVIL, CAPTURA FOTOGRÁFICA Y ANÁLISIS IA (SECCIÓN 4)
// ============================================================================

async function startLiveCamera() {
  const video = document.getElementById('camera-video');
  const previewImg = document.getElementById('camera-preview-img');
  const captureBtn = document.getElementById('btn-capture-frame');
  const caption = document.getElementById('camera-status-caption');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Tu navegador no permite streaming directo; utiliza el botón «Subir / Hacer foto».', 'warning');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } },
      audio: false
    });
    state.cameraStream = stream;
    video.srcObject = stream;
    video.style.display = 'block';
    previewImg.style.display = 'none';
    captureBtn.style.display = 'flex';
    caption.textContent = 'Cámara activa: enfoca el plato y pulsa CAPTURAR FOTOGRAFÍA';
  } catch (_err) {
    showToast('No se pudo abrir la cámara en directo. Puedes subir una fotografía o elegir un plato de muestra.', 'warning');
  }
}

function stopLiveCamera() {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  const video = document.getElementById('camera-video');
  const previewImg = document.getElementById('camera-preview-img');
  const captureBtn = document.getElementById('btn-capture-frame');
  if (video) video.style.display = 'none';
  if (previewImg) previewImg.style.display = 'block';
  if (captureBtn) captureBtn.style.display = 'none';
}

function computeVisualSignatureFromCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let greenPixels = 0;
  let warmPixels = 0;
  let brightPixels = 0;
  const totalPixels = Math.max(1, data.length / 4);

  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (g > r * 1.12 && g > b * 1.12) greenPixels++;
    if (r > b * 1.3 && g > b * 1.1) warmPixels++;
    if (r + g + b > 520) brightPixels++;
  }
  const sampled = totalPixels / 4;
  return {
    greenRatio: Number((greenPixels / sampled).toFixed(2)),
    warmRatio: Number((warmPixels / sampled).toFixed(2)),
    brightRatio: Number((brightPixels / sampled).toFixed(2))
  };
}

async function captureFrameFromVideo() {
  const video = document.getElementById('camera-video');
  const previewImg = document.getElementById('camera-preview-img');
  if (!video) return;

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.84);
  const signature = computeVisualSignatureFromCanvas(canvas);
  stopLiveCamera();
  previewImg.src = dataUrl;

  await analyzePhotoWithServer({
    imageBase64: dataUrl,
    imageUrl: dataUrl,
    visualSignature: signature,
    userHint: document.getElementById('input-ai-hint').value
  });
}

async function runSampleAnalysis(presetId, imgUrl, silent = false) {
  const previewImg = document.getElementById('camera-preview-img');
  if (previewImg && imgUrl) previewImg.src = imgUrl;
  await analyzePhotoWithServer(
    {
      presetId,
      imageUrl: imgUrl,
      userHint: document.getElementById('input-ai-hint')?.value || ''
    },
    silent
  );
}

async function analyzePhotoWithServer(payload, silent = false) {
  try {
    if (!silent) {
      document.getElementById('camera-status-caption').textContent = 'Analizando fotografía con IA y consultando BEDCA/USDA...';
    }
    const result = await apiFetch('/api/ai/analyze-food', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        captureHour: new Date().getHours()
      })
    });

    state.currentAnalysis = {
      ...result,
      photo_url: payload.imageUrl || '/assets/meals/pollo_arroz_ensalada.jpg'
    };

    renderAiConfirmationPanel();
    if (!silent) {
      document.getElementById('camera-status-caption').textContent = `Análisis completado (${result.totals.total_kcal} kcal estimadas)`;
      showToast(`IA identificó ${result.items.length} alimentos (${result.totals.total_kcal} kcal). Revisa y confirma.`, 'success');
    }
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

function renderAiConfirmationPanel() {
  const analysis = state.currentAnalysis;
  if (!analysis) return;

  document.getElementById('confirm-meal-title').value = analysis.title || 'Comida analizada';
  document.getElementById('confirm-meal-type').value = analysis.suggestedMealType || 'lunch';

  const confPct = Math.round((analysis.confidence || 0.9) * 100);
  const confBadge = document.getElementById('ai-confidence-badge');
  confBadge.textContent = `Confianza IA: ${analysis.confidenceLabel || 'Alta'} (${confPct}%)`;
  confBadge.className = `badge ${confPct >= 85 ? 'badge-green' : 'badge-amber'}`;

  document.getElementById('ai-notes-text').textContent = analysis.aiNotes || '';
  const qList = document.getElementById('ai-questions-list');
  qList.innerHTML = (analysis.clarificationQuestions || []).map((q) => `<li>${q}</li>`).join('');

  renderAiItemsTable();
}

function renderAiItemsTable() {
  const analysis = state.currentAnalysis;
  if (!analysis) return;

  const tbody = document.getElementById('ai-items-tbody');
  const items = analysis.items || [];

  tbody.innerHTML = items
    .map((it, idx) => {
      const stateLabel =
        it.preparation_state === 'raw' ? 'Crudo' : it.preparation_state === 'cooked' ? 'Cocinado' : 'Listo';
      const canToggleState = Boolean(it.paired_food_id);
      return `
        <tr>
          <td>
            <div style="font-weight:700; color:var(--text-main);">${it.name}</div>
            <div style="font-size:0.7rem; color:var(--text-muted);">${it.source || 'BEDCA'} · ${Math.round((it.kcal / Math.max(1, it.grams)) * 100)} kcal/100g</div>
          </td>
          <td>
            ${
              canToggleState
                ? `<button type="button" class="btn-sm toggle-prep-btn" data-idx="${idx}" title="Alternar entre alimento crudo y cocinado">⇄ ${stateLabel}</button>`
                : `<span class="badge badge-blue" style="font-size:0.68rem;">${stateLabel}</span>`
            }
          </td>
          <td style="text-align:right;">
            <input type="number" class="grams-input item-grams-input" data-idx="${idx}" value="${it.grams}" min="1" max="2000" />
          </td>
          <td style="text-align:right; font-family:var(--font-mono); font-weight:800; color:var(--primary);">
            ${it.kcal} kcal
          </td>
          <td style="text-align:right; font-family:var(--font-mono); font-size:0.74rem; color:var(--text-secondary);">
            ${it.protein_g}P / ${it.carbs_g}H / ${it.fat_g}G
          </td>
          <td style="text-align:right;">
            <button type="button" class="btn-sm remove-ai-item-btn" data-idx="${idx}" style="color:var(--danger); padding:4px 8px;">✕</button>
          </td>
        </tr>
      `;
    })
    .join('');

  const tot = analysis.totals || { total_kcal: 0, total_protein_g: 0, total_carbs_g: 0, total_fat_g: 0 };
  document.getElementById('ai-total-kcal-cell').textContent = `${tot.total_kcal} kcal`;
  document.getElementById('ai-total-macros-cell').textContent = `${tot.total_protein_g}P / ${tot.total_carbs_g}H / ${tot.total_fat_g}G`;

  // Eventos de edición de gramos en tiempo real
  tbody.querySelectorAll('.item-grams-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const idx = Number(inp.dataset.idx);
      const newGrams = Math.max(1, Number(inp.value) || 100);
      state.currentAnalysis.items[idx].grams = newGrams;
      await recalculateCurrentAnalysisItems();
    });
  });

  // Alternar entre estado crudo y cocinado (Sección 10)
  tbody.querySelectorAll('.toggle-prep-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const currentItem = state.currentAnalysis.items[idx];
      if (currentItem && currentItem.paired_food_id) {
        currentItem.food_id = currentItem.paired_food_id;
        await recalculateCurrentAnalysisItems();
        showToast('Cambiado entre estado Crudo y Cocinado (recalculado según BEDCA).', 'info');
      }
    });
  });

  // Eliminar alimento de la tabla
  tbody.querySelectorAll('.remove-ai-item-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      state.currentAnalysis.items.splice(idx, 1);
      await recalculateCurrentAnalysisItems();
    });
  });
}

async function recalculateCurrentAnalysisItems() {
  if (!state.currentAnalysis) return;
  const res = await apiFetch('/api/ai/recalculate-items', {
    method: 'POST',
    body: JSON.stringify({ items: state.currentAnalysis.items })
  });
  state.currentAnalysis.items = res.items;
  state.currentAnalysis.totals = res.totals;
  renderAiItemsTable();
}

async function addFoodItemToConfirmation(foodId, grams) {
  if (!state.currentAnalysis) {
    state.currentAnalysis = {
      title: 'Comida personalizada',
      suggestedMealType: 'lunch',
      confidence: 0.98,
      confidenceLabel: 'Manual BEDCA',
      items: [],
      totals: {}
    };
  }
  const existing = state.currentAnalysis.items.find((i) => i.food_id === foodId);
  if (existing) {
    existing.grams += Number(grams) || 50;
  } else {
    state.currentAnalysis.items.push({ food_id: foodId, grams: Number(grams) || 100 });
  }
  await recalculateCurrentAnalysisItems();
  showToast('Ingrediente añadido y calorías actualizadas.', 'success');
}

async function saveConfirmedMeal() {
  if (!state.currentAnalysis || !state.currentAnalysis.items || state.currentAnalysis.items.length === 0) {
    showToast('Añade al menos un alimento a la tabla antes de confirmar.', 'warning');
    return;
  }

  const title = document.getElementById('confirm-meal-title').value.trim() || 'Comida registrada';
  const mealType = document.getElementById('confirm-meal-type').value;
  const isFavorite = document.getElementById('chk-save-favorite').checked;

  try {
    const res = await apiFetch('/api/meals', {
      method: 'POST',
      body: JSON.stringify({
        meal_date: state.selectedDate,
        meal_type: mealType,
        title,
        photo_url: state.currentAnalysis.photo_url || '/assets/meals/pollo_arroz_ensalada.jpg',
        items: state.currentAnalysis.items,
        ai_confidence: state.currentAnalysis.confidence || 0.92,
        ai_confidence_label: state.currentAnalysis.confidenceLabel || 'Confirmado',
        is_favorite: isFavorite
      })
    });

    state.daySummary = res.daySummary;
    renderDashboard(res.daySummary);
    renderHistoryScreen(res.daySummary);
    switchScreen('dashboard');
    showToast(
      `Comida registrada (-${state.currentAnalysis.totals.total_kcal} kcal). Te quedan ${res.daySummary.remaining_kcal} kcal hoy.`,
      'success'
    );
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

// ============================================================================
// BUSCADOR BEDCA / USDA Y ESCÁNER DE CÓDIGO DE BARRAS
// ============================================================================

function renderFoodSearchResults() {
  const query = (document.getElementById('input-food-search')?.value || '').trim().toLowerCase();
  const stateFilter = document.getElementById('select-food-state')?.value || 'all';
  const container = document.getElementById('search-results-list');
  if (!container) return;

  const filtered = state.foodsCatalog
    .filter((f) => {
      if (stateFilter !== 'all' && f.preparation_state !== stateFilter) return false;
      if (!query) return true;
      return (
        f.name.toLowerCase().includes(query) ||
        f.category.toLowerCase().includes(query) ||
        (f.barcode && f.barcode.includes(query))
      );
    })
    .slice(0, 25);

  container.innerHTML = filtered
    .map(
      (f) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 10px; background:var(--bg-subtle); border:1px solid var(--border); border-radius:10px; gap:8px;">
        <div>
          <div style="font-weight:700; font-size:0.83rem;">${f.name}</div>
          <div style="font-size:0.72rem; color:var(--text-muted);">
            ${f.source} · <strong>${f.kcal_per_100g} kcal/100g</strong> (P:${f.protein_per_100g}g H:${f.carbs_per_100g}g G:${f.fat_per_100g}g) · Ración: ${f.default_portion_g}g
          </div>
        </div>
        <button type="button" class="btn-sm btn-sm-primary add-catalog-food-btn" data-id="${f.id}" data-grams="${f.default_portion_g}">
          + Añadir (${f.default_portion_g}g)
        </button>
      </div>
    `
    )
    .join('');

  container.querySelectorAll('.add-catalog-food-btn').forEach((btn) => {
    btn.addEventListener('click', () => addFoodItemToConfirmation(btn.dataset.id, btn.dataset.grams));
  });
}

async function lookupBarcode(ean) {
  const cleanEan = String(ean || '').trim();
  if (!cleanEan) return;
  const { foods } = await apiFetch(`/api/foods?barcode=${encodeURIComponent(cleanEan)}`);
  if (foods && foods.length > 0) {
    const f = foods[0];
    await addFoodItemToConfirmation(f.id, f.default_portion_g);
    showToast(`Código EAN ${cleanEan}: ${f.name} añadido al plato.`, 'success');
  } else {
    showToast(`No se encontró el código EAN ${cleanEan} en el catálogo local; puedes crearlo manualmente.`, 'warning');
  }
}

// ============================================================================
// HISTORIAL DIARIO, COMIDAS HABITUALES Y EDICIÓN / REPETICIÓN
// ============================================================================

function renderHistoryScreen(summary) {
  const favContainer = document.getElementById('favorites-meals-list');
  if (favContainer) {
    const favs = summary.favorites || [];
    if (favs.length === 0) {
      favContainer.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted);">Marca la casilla «Guardar en mis comidas habituales» al confirmar un plato para repetirlo aquí con 1 clic.</div>`;
    } else {
      favContainer.innerHTML = favs
        .map(
          (f) => `
          <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; background:var(--bg-subtle); border:1px solid var(--border); border-radius:12px;">
            <div>
              <div style="font-weight:700; font-size:0.86rem;">⭐ ${f.title}</div>
              <div style="font-size:0.74rem; color:var(--text-muted); font-family:var(--font-mono);">
                ${f.total_kcal} kcal · P:${f.total_protein_g}g · H:${f.total_carbs_g}g · G:${f.total_fat_g}g
              </div>
            </div>
            <button type="button" class="btn-sm btn-sm-primary repeat-fav-btn" data-meal-id="${f.id}">
              ↻ Repetir hoy
            </button>
          </div>
        `
        )
        .join('');

      favContainer.querySelectorAll('.repeat-fav-btn').forEach((btn) => {
        btn.addEventListener('click', () => repeatMeal(btn.dataset.mealId));
      });
    }
  }

  const box = document.getElementById('history-day-summary-box');
  if (box) {
    box.innerHTML = `
      Fecha: <strong>${summary.date}</strong> · Consumidas: <strong>${summary.consumed_kcal} kcal</strong> de <strong>${summary.target_kcal} kcal</strong> · Balance disponible: <strong>${summary.remaining_kcal} kcal</strong>
    `;
  }
  renderMealsList('history-meals-list', summary.meals || []);
}

async function repeatMeal(mealId) {
  try {
    const res = await apiFetch(`/api/meals/${encodeURIComponent(mealId)}/repeat`, {
      method: 'POST',
      body: JSON.stringify({ meal_date: state.selectedDate })
    });
    state.daySummary = res.daySummary;
    renderDashboard(res.daySummary);
    renderHistoryScreen(res.daySummary);
    showToast('Comida habitual repetida e incorporada al contador de hoy.', 'success');
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

async function deleteMeal(mealId) {
  try {
    const res = await apiFetch(`/api/meals/${encodeURIComponent(mealId)}`, { method: 'DELETE' });
    state.daySummary = res.daySummary;
    renderDashboard(res.daySummary);
    renderHistoryScreen(res.daySummary);
    showToast('Comida eliminada. El balance calórico se ha actualizado.', 'info');
  } catch (err) {
    showToast(err.message, 'danger');
  }
}

function openMealDetailModal(mealId) {
  const meals = state.daySummary?.meals || [];
  const meal = meals.find((m) => m.id === mealId);
  if (!meal) return;

  const modal = document.getElementById('modal-meal-detail');
  document.getElementById('modal-meal-title').textContent = meal.title;
  const body = document.getElementById('modal-meal-body');

  body.innerHTML = `
    <img src="${meal.photo_url || '/assets/meals/pollo_arroz_ensalada.jpg'}" alt="${meal.title}" style="width:100%; height:170px; object-fit:cover; border-radius:14px;" />
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <span class="badge badge-green">${MEAL_TYPE_LABELS[meal.meal_type] || 'Comida'} · ${meal.meal_time}</span>
      <span style="font-family:var(--font-mono); font-weight:800; font-size:1.1rem; color:var(--primary);">${meal.total_kcal} kcal</span>
    </div>
    <div style="font-size:0.8rem; color:var(--text-secondary);">
      <strong>Desglose de ingredientes (puedes ajustar los gramos):</strong>
    </div>
    <div style="display:flex; flex-direction:column; gap:8px;" id="modal-edit-items-box">
      ${(meal.items || [])
        .map(
          (it, i) => `
          <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; background:var(--bg-subtle); padding:8px 10px; border-radius:10px;">
            <span style="font-size:0.82rem; font-weight:600;">${it.name}</span>
            <div style="display:flex; align-items:center; gap:6px;">
              <input type="number" class="grams-input modal-item-grams" data-idx="${i}" value="${it.grams}" min="1" max="2000" />
              <span style="font-size:0.75rem;">g (${it.kcal} kcal)</span>
            </div>
          </div>
        `
        )
        .join('')}
    </div>
    <div style="display:flex; gap:8px; margin-top:6px;">
      <button type="button" id="btn-modal-save-edit" class="btn-sm btn-sm-primary" style="flex:1; padding:10px;">Guardar cambios</button>
      <button type="button" id="btn-modal-repeat" class="btn-sm" style="padding:10px;">↻ Repetir comida</button>
    </div>
  `;

  modal.classList.add('open');

  document.getElementById('btn-modal-save-edit').onclick = async () => {
    const inputs = body.querySelectorAll('.modal-item-grams');
    const updatedItems = meal.items.map((it, idx) => ({
      ...it,
      grams: Math.max(1, Number(inputs[idx].value) || it.grams)
    }));
    const res = await apiFetch(`/api/meals/${encodeURIComponent(meal.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ items: updatedItems })
    });
    state.daySummary = res.daySummary;
    renderDashboard(res.daySummary);
    renderHistoryScreen(res.daySummary);
    modal.classList.remove('open');
    showToast('Cantidades actualizadas y calorías recalculadas.', 'success');
  };

  document.getElementById('btn-modal-repeat').onclick = async () => {
    modal.classList.remove('open');
    await repeatMeal(meal.id);
  };
}

// ============================================================================
// ESTADÍSTICAS SEMANALES Y MENSUALES (7, 30, 60 Y 90 DÍAS) + GRÁFICOS SVG
// ============================================================================

async function loadStats(days = 7) {
  state.statsRangeDays = days;
  document.querySelectorAll('.stats-range-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.days) === Number(days));
  });

  const data = await apiFetch(`/api/stats?days=${days}`);
  const s = data.summary || {};

  document.getElementById('stats-avg-kcal').textContent = `${formatNumber(s.avgKcal)} kcal`;
  const deltaSign = s.kcalDeltaVsPrev > 0 ? `+${s.kcalDeltaVsPrev}` : `${s.kcalDeltaVsPrev}`;
  document.getElementById('stats-vs-prev').textContent = `${deltaSign} kcal vs periodo previo`;
  document.getElementById('stats-compliance-pct').textContent = `${s.compliancePct}%`;
  const balSign = s.avgDailyBalance > 0 ? `+${s.avgDailyBalance}` : `${s.avgDailyBalance}`;
  document.getElementById('stats-balance-sub').textContent = `Balance medio: ${balSign} kcal/día`;
  document.getElementById('stats-avg-fruitveg').textContent = `${s.avgFruitVeg} g/día`;

  const md = s.macroDistribution || { proteinPct: 24, carbsPct: 46, fatPct: 30 };
  document.getElementById('stats-macro-p').textContent = `${s.avgProtein} g (${md.proteinPct}%)`;
  document.getElementById('stats-macro-c').textContent = `${s.avgCarbs} g (${md.carbsPct}%)`;
  document.getElementById('stats-macro-f').textContent = `${s.avgFat} g (${md.fatPct}%)`;

  renderCalorieBarChart(data.series || [], s.targetKcal || 2000);
  renderWeightLineChart(data.weights || [], state.user?.target_weight_kg || 63);
}

function renderCalorieBarChart(series, targetKcal) {
  const container = document.getElementById('stats-calorie-chart');
  if (!container || series.length === 0) return;

  const width = 460;
  const height = 175;
  const padLeft = 36;
  const padRight = 12;
  const padTop = 16;
  const padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxVal = Math.max(targetKcal * 1.25, ...series.map((d) => d.kcal || 0), 2200);
  const targetY = padTop + plotH - (targetKcal / maxVal) * plotH;
  const barStep = plotW / series.length;
  const barWidth = Math.max(3, Math.min(22, barStep * 0.66));

  const barsSvg = series
    .map((d, i) => {
      const h = ((d.kcal || 0) / maxVal) * plotH;
      const x = padLeft + i * barStep + (barStep - barWidth) / 2;
      const y = padTop + plotH - h;
      const color = d.kcal > targetKcal * 1.1 ? 'var(--warning)' : 'var(--primary)';
      const showLabel = series.length <= 10 || i % Math.ceil(series.length / 7) === 0;
      const shortDate = d.date.slice(5);
      return `
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(2, h).toFixed(1)}" rx="3" fill="${color}">
          <title>${d.date}: ${d.kcal} kcal (Objetivo: ${targetKcal} kcal)</title>
        </rect>
        ${
          showLabel
            ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="9" fill="var(--text-muted)">${shortDate}</text>`
            : ''
        }
      `;
    })
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto;">
      <line x1="${padLeft}" y1="${targetY.toFixed(1)}" x2="${width - padRight}" y2="${targetY.toFixed(1)}" stroke="var(--danger)" stroke-width="1.5" stroke-dasharray="4 4" />
      <text x="${padLeft + 4}" y="${(targetY - 4).toFixed(1)}" font-size="9" font-weight="700" fill="var(--danger)">Objetivo ${targetKcal} kcal</text>
      ${barsSvg}
    </svg>
  `;
}

function renderWeightLineChart(weights, targetWeight) {
  const container = document.getElementById('stats-weight-chart');
  if (!container) return;
  if (state.user?.target_weight_kg) {
    document.getElementById('weight-target-badge').textContent = `Meta: ${state.user.target_weight_kg} kg`;
  }

  if (!weights || weights.length === 0) {
    container.innerHTML = `<div style="font-size:0.8rem; color:var(--text-muted);">Sin registros de peso en este rango.</div>`;
    return;
  }

  const width = 460;
  const height = 150;
  const pad = 28;
  const vals = weights.map((w) => w.weight_kg);
  const minW = Math.min(...vals, targetWeight || vals[0]) - 1.2;
  const maxW = Math.max(...vals, targetWeight || vals[0]) + 1.2;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;

  const points = weights.map((w, idx) => {
    const x = pad + (idx / Math.max(1, weights.length - 1)) * plotW;
    const y = pad + plotH - ((w.weight_kg - minW) / Math.max(0.5, maxW - minW)) * plotH;
    return { x, y, ...w };
  });

  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const circles = points
    .map(
      (p) => `
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="var(--info)">
        <title>${p.log_date}: ${p.weight_kg} kg</title>
      </circle>
    `
    )
    .join('');

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto;">
      <polyline fill="none" stroke="var(--info)" stroke-width="2.5" points="${polyline}" />
      ${circles}
      <text x="${pad}" y="14" font-size="10" font-weight="700" fill="var(--text-secondary)">
        Inicio: ${weights[0].weight_kg} kg → Actual: ${weights[weights.length - 1].weight_kg} kg
      </text>
    </svg>
  `;
}

// ============================================================================
// PERFIL PERSONAL Y ASISTENTE DE CONFIGURACIÓN INICIAL (SECCIÓN 2 Y 3)
// ============================================================================

function populateProfileForm() {
  const u = state.user;
  if (!u) return;

  document.getElementById('prof-name').value = u.name || '';
  document.getElementById('prof-age').value = u.age || 30;
  document.getElementById('prof-sex').value = u.sex || 'female';
  document.getElementById('prof-height').value = u.height_cm || 166;
  document.getElementById('prof-weight').value = u.weight_kg || 67;
  document.getElementById('prof-target-weight').value = u.target_weight_kg || '';
  document.getElementById('prof-goal').value = u.goal || 'maintain';
  document.getElementById('prof-activity').value = u.activity_level || 'moderate';
  document.getElementById('prof-work').value = u.work_activity || 'sedentary';
  document.getElementById('prof-exercise').value = u.exercise_frequency || '3_4_days';

  const cond = u.special_conditions || {};
  document.getElementById('cond-pregnancy').checked = Boolean(cond.pregnancy);
  document.getElementById('cond-lactation').checked = Boolean(cond.lactation);
  document.getElementById('cond-tca').checked = Boolean(cond.eating_disorder);
  document.getElementById('cond-medical').checked = Boolean(cond.medical_condition);

  renderProfileMetabolicCard(u);
}

function renderProfileMetabolicCard(u) {
  const box = document.getElementById('profile-metabolic-results');
  if (!box || !u) return;

  const warningsHtml = (u.warnings || [])
    .map((w) => `<div class="tip-banner warning" style="margin-top:8px;"><div class="tip-message">⚠️ ${w}</div></div>`)
    .join('');

  box.innerHTML = `
    <div style="font-size:0.84rem; font-weight:700; margin-bottom:10px;">
      Resultados de tu Motor de Cálculo Nutricional:
    </div>
    <div class="macros-grid">
      <div class="macro-card">
        <span class="macro-name">IMC Actual</span>
        <span class="macro-value">${u.bmi}</span>
        <span class="macro-sub">${u.bmiCategory || 'Saludable'}</span>
      </div>
      <div class="macro-card">
        <span class="macro-name">TMB (Reposo)</span>
        <span class="macro-value">${formatNumber(u.bmr_kcal)} kcal</span>
        <span class="macro-sub">Mifflin-St Jeor</span>
      </div>
      <div class="macro-card">
        <span class="macro-name">GET (Total)</span>
        <span class="macro-value">${formatNumber(u.tdee_kcal)} kcal</span>
        <span class="macro-sub">Gasto diario</span>
      </div>
    </div>
    <div style="margin-top:10px; padding:12px; background:var(--primary-soft); border-radius:12px; font-size:0.82rem;">
      🎯 <strong>Objetivo calórico diario recomendado: ${formatNumber(u.daily_calorie_target)} kcal/día</strong>
      (Proteínas: ${u.macroTargets?.proteinGrams}g · Hidratos: ${u.macroTargets?.carbsGrams}g · Grasas: ${u.macroTargets?.fatGrams}g · Agua: ${u.water_target_ml}ml)
    </div>
    ${warningsHtml}
    <p style="font-size:0.73rem; color:var(--text-muted); margin-top:8px;">
      ${u.methodologyNote || ''}
    </p>
  `;
}

async function updateWizardLivePreview() {
  const previewEl = document.getElementById('wiz-live-preview');
  if (!previewEl) return;

  try {
    const res = await apiFetch('/api/metabolism/preview', {
      method: 'POST',
      body: JSON.stringify({
        age: Number(document.getElementById('wiz-age').value) || 34,
        sex: document.getElementById('wiz-sex').value,
        height_cm: Number(document.getElementById('wiz-height').value) || 175,
        weight_kg: Number(document.getElementById('wiz-weight').value) || 78,
        target_weight_kg: Number(document.getElementById('wiz-target-weight').value) || null,
        activity_level: document.getElementById('wiz-activity').value,
        goal: document.getElementById('wiz-goal').value
      })
    });

    previewEl.innerHTML = `
      <strong>Cálculo instantáneo:</strong> IMC <strong>${res.bmi}</strong> (${res.bmiCategory}) ·
      TMB: <strong>${res.bmrKcal} kcal</strong> · GET: <strong>${res.tdeeKcal} kcal</strong> →
      🎯 <strong>Objetivo recomendado: ${res.dailyCalorieTarget} kcal/día</strong>
    `;
  } catch (_e) {}
}

// ============================================================================
// REGISTRO DE EVENTOS DE INTERFAZ
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
  initApp();

  // Navegación inferior de 5 apartados
  document.querySelectorAll('.bottom-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchScreen(btn.dataset.screen));
  });

  document.getElementById('brand-home-trigger')?.addEventListener('click', () => switchScreen('dashboard'));

  // Botones directos a Fotografiar Comida
  document.getElementById('btn-hero-photograph')?.addEventListener('click', () => {
    switchScreen('camera');
    document.getElementById('tab-mode-photo').click();
  });

  document.getElementById('btn-add-meal-from-list')?.addEventListener('click', () => switchScreen('camera'));

  document.getElementById('btn-quick-manual-add')?.addEventListener('click', () => {
    switchScreen('camera');
    document.getElementById('tab-mode-search').click();
  });

  // Alternar tema claro/oscuro y modo expandido
  document.getElementById('btn-toggle-theme')?.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  document.getElementById('btn-toggle-layout')?.addEventListener('click', () => {
    document.getElementById('app-shell')?.classList.toggle('wide-mode');
  });

  // Navegador de fecha diaria
  document.getElementById('input-date-picker')?.addEventListener('change', (e) => {
    if (e.target.value) loadDaySummary(e.target.value);
  });

  document.getElementById('btn-prev-day')?.addEventListener('click', () => {
    const dt = new Date(state.selectedDate + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    loadDaySummary(dt.toISOString().slice(0, 10));
  });

  document.getElementById('btn-next-day')?.addEventListener('click', () => {
    const dt = new Date(state.selectedDate + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    loadDaySummary(dt.toISOString().slice(0, 10));
  });

  // Controles de Agua
  document.getElementById('btn-water-plus')?.addEventListener('click', async () => {
    const res = await apiFetch('/api/water', {
      method: 'POST',
      body: JSON.stringify({ date: state.selectedDate, delta_ml: 250 })
    });
    renderDashboard(res.daySummary);
    showToast('+250 ml de agua registrados.', 'info');
  });

  document.getElementById('btn-water-minus')?.addEventListener('click', async () => {
    const res = await apiFetch('/api/water', {
      method: 'POST',
      body: JSON.stringify({ date: state.selectedDate, delta_ml: -250 })
    });
    renderDashboard(res.daySummary);
  });

  // Sub-modos de Registrar Comida (Foto IA / Buscador / Código de barras)
  document.querySelectorAll('[data-cam-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.camMode;
      document.querySelectorAll('[data-cam-mode]').forEach((b) => b.classList.toggle('active', b === btn));
      document.getElementById('submode-photo').style.display = mode === 'photo' ? 'flex' : 'none';
      document.getElementById('submode-search').style.display = mode === 'search' ? 'flex' : 'none';
      document.getElementById('submode-barcode').style.display = mode === 'barcode' ? 'flex' : 'none';
      if (mode !== 'photo') stopLiveCamera();
    });
  });

  // Cámara móvil en vivo y subida de fotografía
  document.getElementById('btn-start-live-camera')?.addEventListener('click', startLiveCamera);
  document.getElementById('btn-capture-frame')?.addEventListener('click', captureFrameFromVideo);

  document.getElementById('file-camera-input')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      const previewImg = document.getElementById('camera-preview-img');
      if (previewImg) previewImg.src = dataUrl;
      await analyzePhotoWithServer({
        imageBase64: dataUrl,
        imageUrl: dataUrl,
        userHint: document.getElementById('input-ai-hint').value || file.name.replace(/\.[^.]+$/, '')
      });
    };
    reader.readAsDataURL(file);
  });

  // Platos reales de demostración
  document.querySelectorAll('.sample-plate-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      runSampleAnalysis(btn.dataset.preset, btn.dataset.img, false);
    });
  });

  // Botón Analizar con IA (con pista o aclaración del usuario)
  document.getElementById('btn-run-ai-analysis')?.addEventListener('click', () => {
    const hint = document.getElementById('input-ai-hint').value;
    const currentImg = document.getElementById('camera-preview-img').src;
    analyzePhotoWithServer({
      imageUrl: currentImg,
      userHint: hint
    });
  });

  // Botones rápidos de aceites, salsas y acompañamientos
  document.querySelectorAll('.quick-add-item-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      addFoodItemToConfirmation(btn.dataset.foodId, Number(btn.dataset.grams));
    });
  });

  // Confirmar y descontar calorías
  document.getElementById('btn-confirm-save-meal')?.addEventListener('click', saveConfirmedMeal);

  // Buscador BEDCA / USDA y creación manual
  document.getElementById('input-food-search')?.addEventListener('input', renderFoodSearchResults);
  document.getElementById('select-food-state')?.addEventListener('change', renderFoodSearchResults);

  document.getElementById('btn-save-custom-food')?.addEventListener('click', async () => {
    const name = document.getElementById('custom-food-name').value.trim();
    const kcal = Number(document.getElementById('custom-food-kcal').value) || 100;
    const protein = Number(document.getElementById('custom-food-protein').value) || 0;
    const carbs = Number(document.getElementById('custom-food-carbs').value) || 0;
    const fat = Number(document.getElementById('custom-food-fat').value) || 0;

    if (!name) {
      showToast('Introduce el nombre del alimento personalizado.', 'warning');
      return;
    }

    const { food } = await apiFetch('/api/foods', {
      method: 'POST',
      body: JSON.stringify({
        name,
        kcal_per_100g: kcal,
        protein_per_100g: protein,
        carbs_per_100g: carbs,
        fat_per_100g: fat
      })
    });
    state.foodsCatalog.unshift(food);
    renderFoodSearchResults();
    await addFoodItemToConfirmation(food.id, 100);
    document.getElementById('custom-food-name').value = '';
  });

  // Escáner de código de barras EAN
  document.getElementById('btn-lookup-barcode')?.addEventListener('click', () => {
    lookupBarcode(document.getElementById('input-barcode-ean').value);
  });
  document.querySelectorAll('.barcode-sample-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.getElementById('input-barcode-ean').value = chip.dataset.ean;
      lookupBarcode(chip.dataset.ean);
    });
  });

  // Rango de estadísticas (7, 30, 60, 90 días)
  document.querySelectorAll('.stats-range-btn').forEach((btn) => {
    btn.addEventListener('click', () => loadStats(Number(btn.dataset.days)));
  });

  // Registro periódico de peso
  document.getElementById('form-log-weight')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const weightKg = Number(document.getElementById('input-new-weight').value);
    const note = document.getElementById('input-weight-note').value;
    try {
      const res = await apiFetch('/api/weight', {
        method: 'POST',
        body: JSON.stringify({ weight_kg: weightKg, note })
      });
      state.user = res.user;
      renderUserProfileHeader();
      populateProfileForm();
      await loadStats(state.statsRangeDays);
      await loadDaySummary(state.selectedDate);
      showToast(`Peso registrado (${weightKg} kg) y objetivo metabólico actualizado.`, 'success');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  // Guardar Perfil y Recalcular Motor Metabólico
  document.getElementById('form-user-profile')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: document.getElementById('prof-name').value,
        age: Number(document.getElementById('prof-age').value),
        sex: document.getElementById('prof-sex').value,
        height_cm: Number(document.getElementById('prof-height').value),
        weight_kg: Number(document.getElementById('prof-weight').value),
        target_weight_kg: document.getElementById('prof-target-weight').value
          ? Number(document.getElementById('prof-target-weight').value)
          : null,
        goal: document.getElementById('prof-goal').value,
        activity_level: document.getElementById('prof-activity').value,
        work_activity: document.getElementById('prof-work').value,
        exercise_frequency: document.getElementById('prof-exercise').value,
        special_conditions: {
          pregnancy: document.getElementById('cond-pregnancy').checked,
          lactation: document.getElementById('cond-lactation').checked,
          eating_disorder: document.getElementById('cond-tca').checked,
          medical_condition: document.getElementById('cond-medical').checked
        }
      };

      const { user } = await apiFetch('/api/user/profile', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      state.user = user;
      renderUserProfileHeader();
      populateProfileForm();
      await loadDaySummary(state.selectedDate);
      showToast(`Perfil actualizado. Nuevo objetivo diario: ${user.daily_calorie_target} kcal.`, 'success');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  // Probar recordatorio inteligente
  document.getElementById('btn-test-reminder')?.addEventListener('click', () => {
    showToast('🔔 Recordatorio NutriVital: Es buen momento para beber un vaso de agua (250 ml) y registrar tu comida.', 'info');
  });

  // Eliminar cuenta y datos (Derecho al olvido RGPD)
  document.getElementById('btn-delete-account')?.addEventListener('click', async () => {
    if (!confirm('¿Confirmas la eliminación irreversible de tu cuenta, historial y fotografías según el RGPD?')) {
      return;
    }
    const res = await apiFetch('/api/user/account', { method: 'DELETE' });
    showToast(res.message, 'info');
    setTimeout(() => window.location.reload(), 1200);
  });

  // Modal de Bienvenida, Registro y Login
  const onboardingModal = document.getElementById('modal-onboarding');
  document.getElementById('btn-open-onboarding')?.addEventListener('click', () => {
    onboardingModal.classList.add('open');
    updateWizardLivePreview();
  });
  document.getElementById('btn-close-onboarding')?.addEventListener('click', () => {
    onboardingModal.classList.remove('open');
  });
  document.getElementById('btn-close-meal-modal')?.addEventListener('click', () => {
    document.getElementById('modal-meal-detail').classList.remove('open');
  });

  document.getElementById('tab-auth-wizard')?.addEventListener('click', () => {
    document.getElementById('tab-auth-wizard').classList.add('active');
    document.getElementById('tab-auth-login').classList.remove('active');
    document.getElementById('form-onboarding-wizard').style.display = 'grid';
    document.getElementById('form-login').style.display = 'none';
  });

  document.getElementById('tab-auth-login')?.addEventListener('click', () => {
    document.getElementById('tab-auth-login').classList.add('active');
    document.getElementById('tab-auth-wizard').classList.remove('active');
    document.getElementById('form-login').style.display = 'grid';
    document.getElementById('form-onboarding-wizard').style.display = 'none';
  });

  ['wiz-age', 'wiz-sex', 'wiz-height', 'wiz-weight', 'wiz-target-weight', 'wiz-goal', 'wiz-activity'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updateWizardLivePreview);
    document.getElementById(id)?.addEventListener('change', updateWizardLivePreview);
  });

  document.getElementById('form-onboarding-wizard')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const payload = {
        name: document.getElementById('wiz-name').value,
        email: document.getElementById('wiz-email').value || `usuario_${Date.now()}@nutrivital.es`,
        age: Number(document.getElementById('wiz-age').value),
        sex: document.getElementById('wiz-sex').value,
        height_cm: Number(document.getElementById('wiz-height').value),
        weight_kg: Number(document.getElementById('wiz-weight').value),
        target_weight_kg: Number(document.getElementById('wiz-target-weight').value) || null,
        goal: document.getElementById('wiz-goal').value,
        activity_level: document.getElementById('wiz-activity').value,
        gdpr_consent: document.getElementById('wiz-gdpr-consent').checked
      };

      const { user } = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      state.user = user;
      onboardingModal.classList.remove('open');
      renderUserProfileHeader();
      populateProfileForm();
      await loadDaySummary(state.todayDate);
      showToast(`¡Bienvenido, ${user.name}! Tu objetivo diario es ${user.daily_calorie_target} kcal.`, 'success');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  document.getElementById('form-login')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const email = document.getElementById('login-email').value;
      const password = document.getElementById('login-password').value;
      const { user } = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.user = user;
      onboardingModal.classList.remove('open');
      renderUserProfileHeader();
      populateProfileForm();
      await loadDaySummary(state.todayDate);
      showToast(`Sesión iniciada como ${user.name}.`, 'success');
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });
});
