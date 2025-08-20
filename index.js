// server/index.js
// Calgooo server – onboarding plans + streaks + scans
// - Accepts onboarding payload, fabricates a plan for goal (gain/lose/maintain),
//   stores it, and returns macros. (In prod this would call AI).
// - Auto-marks streak "done" whenever a scan is received.
// - Integer-only counters everywhere.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ------------------------- uploads ------------------------- */
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 } });

/* -------------------------- store -------------------------- */
const store = {
  user: {
    planGoal: 'maintain', // 'gain' | 'lose' | 'maintain'
    timezone: 'UTC',
    goals: { caloriesKcal: 2200, proteinG: 100, carbsG: 275, fatG: 70, fiberG: 30 }, // macros target
    profile: {
      units: 'metric',
      age: 25,
      weightKg: 70,
      heightM: 1.75,
    },
  },
  uploads: [],
  mealsByDate: {},     // { 'YYYY-MM-DD': [...] }
  streakOverrides: {}, // { 'YYYY-MM-DD': boolean }
};

/* -------------------------- utils -------------------------- */
const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lbToKg = (lb) => lb / 2.20462262;
const ftInToMeters = (ft, inch) => ((ft * 12 + inch) * 2.54) / 100;

// daily totals
const totalsForDate = (date) => {
  const items = store.mealsByDate[date] || [];
  return items.reduce((acc, m) => {
    acc.caloriesKcal += m.macros.caloriesKcal;
    acc.proteinG += m.macros.proteinG;
    acc.carbsG += m.macros.carbsG;
    acc.fatG += m.macros.fatG;
    acc.fiberG += m.macros.fiberG;
    return acc;
  }, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });
};

/* -------------------- plan fabrication --------------------- */
// super-light “AI placeholder”
function fabricatePlan({ goal, age, weightKg, heightM }) {
  // baseline kcal (very rough; no sex/BMR captured here)
  // Use 30 * kg as neutral maintenance baseline
  const maintain = Math.round(weightKg * 30);
  let calories = maintain;
  if (goal === 'gain') calories = Math.round(maintain * 1.15);
  if (goal === 'lose') calories = Math.round(maintain * 0.80);

  // macros (integers)
  const proteinG = Math.round(weightKg * 1.8);   // ~1.8g/kg
  const fatG = Math.round(weightKg * 0.8);       // ~0.8g/kg
  const kcalFromPF = proteinG * 4 + fatG * 9;
  const carbsG = Math.max(0, Math.round((calories - kcalFromPF) / 4));
  const fiberG = 30;

  return {
    goal,
    caloriesKcal: calories,
    proteinG,
    carbsG,
    fatG,
    fiberG,
    notes: `Auto plan for ${goal}. Tweak anytime in Profile.`,
  };
}

/* -------------------- streak scoring ----------------------- */
function dayStat(date) {
  const override = store.streakOverrides[date];
  const goals = store.user.goals || { caloriesKcal: 2200 };
  const totals = totalsForDate(date);
  const hasMeals = totals.caloriesKcal > 0;

  const hit = typeof override === 'boolean' ? override : hasMeals;
  if (!hit) return { date, hit: false, score: 0 };

  const diff = Math.abs(totals.caloriesKcal - goals.caloriesKcal) / Math.max(1, goals.caloriesKcal);
  let score = 1;
  if (diff <= 0.25) score = 1;
  if (diff <= 0.12) score = 2;
  if (diff <= 0.08) score = 3;
  if (diff <= 0.05) score = 4;
  score = Math.max(0, Math.min(4, Math.round(score)));

  return { date, hit: true, score };
}

const BADGE_Tiers = [7, 14, 30, 60, 90, 120];

function buildSummary(weeks = 12) {
  const w = clamp(parseInt(weeks, 10) || 12, 1, 26);
  const daysCount = w * 7;

  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (daysCount - 1));

  const days = [];
  const goals = store.user.goals || { caloriesKcal: 2200 };

  for (let i = 0; i < daysCount; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(dayStat(d.toISOString().slice(0, 10)));
  }

  // best/current streak
  let cur = 0, best = 0;
  for (let i = 0; i < days.length; i++) {
    if (days[i].hit) { cur++; best = Math.max(best, cur); } else { cur = 0; }
  }
  let trailing = 0;
  for (let i = days.length - 1; i >= 0; i--) { if (days[i].hit) trailing++; else break; }

  const last7 = days.slice(-7);
  const last30 = days.slice(-30);
  const hits7 = last7.filter(d => d.hit).length;
  const hits30 = last30.filter(d => d.hit).length;

  return {
    range: { start: days[0]?.date, end: days[days.length - 1]?.date, weeks: w },
    goals: { caloriesKcal: Math.round(goals.caloriesKcal) },
    days,
    currentStreak: Math.round(trailing),
    bestStreak: Math.round(best),
    hits7: Math.round(hits7),
    hits30: Math.round(hits30),
    earnedTiers: BADGE_Tiers.filter(t => best >= t),
  };
}

/* ------------------------- routes -------------------------- */

// Onboarding + plan
app.post('/v1/users/bootstrap', (req, res) => {
  try {
    const { units, age, weight, height, goal, timezone } = req.body || {};
    // normalize
    let weightKg = 70;
    if (weight?.unit === 'kg') weightKg = Number(weight.value) || 70;
    else if (weight?.unit === 'lb') weightKg = lbToKg(Number(weight.value) || 154);

    let heightM = 1.75;
    if (height?.unit === 'cm') heightM = (Number(height.value) || 175) / 100;
    else if (height?.unit === 'imperial') {
      const ft = Number(height.ft) || 5; const inch = Number(height.in) || 9;
      heightM = ftInToMeters(ft, inch);
    }

    const planGoal = goal === 'gain' || goal === 'lose' || goal === 'maintain' ? goal : 'maintain';
    const plan = fabricatePlan({ goal: planGoal, age: Math.round(Number(age) || 25), weightKg, heightM });

    // persist lightweight profile + goals
    store.user = {
      ...store.user,
      planGoal,
      timezone: timezone || 'UTC',
      profile: {
        units: units === 'imperial' ? 'imperial' : 'metric',
        age: Math.round(Number(age) || 25),
        weightKg: Math.round(weightKg),
        heightM: Math.round(heightM * 100) / 100,
      },
      goals: {
        caloriesKcal: Math.round(plan.caloriesKcal),
        proteinG: Math.round(plan.proteinG),
        carbsG: Math.round(plan.carbsG),
        fatG: Math.round(plan.fatG),
        fiberG: Math.round(plan.fiberG),
      }
    };

    res.json({ ok: true, timezone: store.user.timezone, plan, goals: store.user.goals });
  } catch (e) {
    res.status(400).json({ ok: false, error: { message: 'Invalid onboarding payload' } });
  }
});

// Consistency: summary
app.get('/v1/streaks/summary', (req, res) => {
  const weeks = req.query.weeks;
  res.json(buildSummary(weeks));
});

// Optional manual toggle/log for a date
app.post('/v1/streaks/log', (req, res) => {
  const date = (req.body && req.body.date) || isoDate();
  const cur = dayStat(date).hit;
  store.streakOverrides[date] = typeof req.body?.hit === 'boolean' ? !!req.body.hit : !cur;
  res.json({ date, hit: store.streakOverrides[date] });
});

// Analyze Scan → automatically mark today as done
app.post('/v1/scan/analyze', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: { code: 'no_file', message: 'image is required' } });

  const filename = req.file.filename;
  const publicUrl = `/uploads/${filename}`;
  const absoluteUrl = `${req.protocol}://${req.get('host')}${publicUrl}`;
  const rec = { id: filename, filename, url: publicUrl, absoluteUrl, createdAt: new Date().toISOString() };
  store.uploads.unshift(rec);

  const today = isoDate();
  store.streakOverrides[today] = true; // mark done on scan

  // mock suggestions
  const suggestions = [
    { id: 's1', foodName: 'Chicken & Rice Bowl', serving: '1 bowl (350g)', confidence: 0.86,
      macros: { caloriesKcal: 520, proteinG: 38, carbsG: 62, fatG: 12, fiberG: 4 } },
    { id: 's2', foodName: 'Greek Yogurt + Banana', serving: '1 cup + 1 medium', confidence: 0.74,
      macros: { caloriesKcal: 260, proteinG: 18, carbsG: 36, fatG: 4, fiberG: 3 } },
  ];

  res.json({ image: rec, suggestions });
});

// Meals
app.get('/v1/uploads', (_req, res) => {
  res.json({ items: store.uploads.slice(0, 20) });
});

app.post('/v1/meals', (req, res) => {
  const { date, type, title, imageAbsoluteUrl, macros } = req.body || {};
  if (!date || !type || !macros) return res.status(400).json({ error: { code: 'bad_request', message: 'date, type, macros are required' } });
  if (!store.mealsByDate[date]) store.mealsByDate[date] = [];

  const item = {
    id: `meal_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type,
    title: title || 'Meal',
    imageAbsoluteUrl: imageAbsoluteUrl || null,
    macros: {
      caloriesKcal: Math.round(macros.caloriesKcal || 0),
      proteinG: Math.round(macros.proteinG || 0),
      carbsG: Math.round(macros.carbsG || 0),
      fatG: Math.round(macros.fatG || 0),
      fiberG: Math.round(macros.fiberG || 0),
    },
    createdAt: new Date().toISOString(),
  };
  store.mealsByDate[date].unshift(item);

  const totals = totalsForDate(date);
  res.json({ id: item.id, accepted: true, item, totals });
});

app.get('/v1/meals', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : isoDate();
  const items = (store.mealsByDate[date] || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const totals = totalsForDate(date);
  res.json({ date, items, totals });
});

/* ------------------------- start --------------------------- */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Calgooo server running at http://localhost:${PORT}`);
});
