# NutriVital AI — Aplicación Web de Control Inteligente de Calorías con IA

Aplicación web **Mobile-First**, progresiva (**PWA**) y multiusuario diseñada para ayudar al usuario a controlar diariamente su ingesta calórica y calidad nutricional mediante **reconocimiento fotográfico con Inteligencia Artificial**, **cálculos metabólicos validados** y **recomendaciones oficiales de la Organización Mundial de la Salud (OMS)**.

---

## 1. Arquitectura del Proyecto

```text
/home/antigravity/nutriai/
├── server.js                  # Servidor HTTP/REST API, autenticación de sesiones y seguridad RGPD
├── schema.postgres.sql        # Esquema SQL relacional (compatible con SQLite y PostgreSQL)
├── .env.example               # Variables de entorno (GEMINI_API_KEY, OPENAI_API_KEY, DATABASE_URL)
├── src/
│   ├── metabolism.js          # Motor metabólico (IMC, TMB Mifflin-St Jeor, GET) y evaluador OMS
│   ├── foods-catalog.js       # Catálogo verificado BEDCA y USDA con pares Crudo/Cocinado y EAN-13
│   ├── ai-vision.js           # Motor multimodal de reconocimiento visual de platos en servidor
│   └── db.js                  # Capa de persistencia SQLite, historial de 90 días y copias de seguridad
├── public/
│   ├── index.html             # Interfaz Mobile-First con las 10 pantallas y modales
│   ├── styles.css             # Sistema de diseño visual en Vanilla CSS con Modo Claro y Modo Oscuro
│   ├── app.js                 # Lógica SPA, cámara en vivo, gráficos SVG y sincronización en tiempo real
│   ├── manifest.json          # Manifiesto de instalación PWA para dispositivos móviles
│   ├── sw.js                  # Service Worker para funcionamiento ágil e instalable
│   └── assets/                # Iconografía SVG y fotografías de referencia de platos mediterráneos
└── test/
    └── verify-all.js          # Suite de verificación integral (cálculos, endpoints, seguridad y OMS)
```

---

## 2. Rigor Científico y Separación entre Ecuaciones Metabólicas y Directrices OMS

1. **Ecuaciones Metabólicas Individuales (Literatura Clínica)**:
   - El **Metabolismo Basal (TMB)** se estima mediante la ecuación clínica validada de **Mifflin-St Jeor (1990)** (sin atribuirla a la OMS):
     - Hombres: $\text{TMB} = (10 \times \text{peso kg}) + (6.25 \times \text{altura cm}) - (5 \times \text{edad}) + 5$
     - Mujeres: $\text{TMB} = (10 \times \text{peso kg}) + (6.25 \times \text{altura cm}) - (5 \times \text{edad}) - 161$
   - El **Gasto Energético Total (GET)** pondera el TMB según el nivel de actividad física diaria (`1.2` a `1.9`), el tipo de actividad laboral y la frecuencia semanal de ejercicio.
   - **Límites de seguridad y protección clínica**: Nunca se establecen objetivos por debajo del TMB ni de umbrales mínimos de seguridad, y se bloquea cualquier déficit calórico en perfiles de **menores de 18 años, embarazo, lactancia, TCA o patologías bajo supervisión médica**.

2. **Directrices Oficiales de la OMS (Calidad de la Dieta)**:
   - **Frutas y verduras**: $\ge 400\text{ g/día}$ (5 raciones de $80\text{ g}$, excluyendo tubérculos feculentos).
   - **Azúcares libres**: $< 10\%$ de la ingesta energética total (e idealmente $< 5\%$ para beneficios adicionales).
   - **Grasas saturadas y trans**: Saturadas $< 10\%$ y grasas trans $< 1\%$ de la energía total, priorizando grasas insaturadas (AOVE, aguacate, pescado azul, frutos secos).
   - **Sal / Sodio**: $< 5\text{ g/día}$ de sal ($< 2\text{ g/día}$ de sodio).
   - **Fibra dietética, legumbres y cereales integrales**: $\ge 25\text{ g/día}$ de fibra alimentaria.

---

## 3. Ejecución y Verificación

```bash
# Iniciar el servidor en el puerto 3000
npm start

# Ejecutar la batería de pruebas automatizadas (Fase 6)
npm test
```
