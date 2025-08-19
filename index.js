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

// ---- Static uploads
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOAD_DIR));

// ---- Multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg') || '.jpg';
    cb(null, `img_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 12 * 1024 * 1024 } });

// ---- In-memory store (demo)
const store = {
  uploads: [],      // [{ id, filename, url, absoluteUrl, createdAt }]
  mealsByDate: {},  // { 'YYYY-MM-DD': [{ id, type, title, imageAbsoluteUrl?, macros, createdAt }] }
};

// Helpers
const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

// ---- Bootstrap (unchanged shape)
app.post('/v1/users/bootstrap', (req, res) => {
  const { goal, timezone } = req.body || {};
  const goals = {
    caloriesKcal: goal === 'gain' ? 2600 : goal === 'lose' ? 1800 : 2200,
    proteinG: goal === 'gain' ? 120 : 100,
    carbsG: 275,
    fatG: 70,
    fiberG: 30
  };
  res.json({ ok: true, goals, timezone });
});

// ---- Analyze: save file, return suggestions
app.post('/v1/scan/analyze', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: { code: 'no_file', message: 'image is required' } });

  const filename = req.file.filename;
  const publicUrl = `/uploads/${filename}`;
  const absoluteUrl = `${req.protocol}://${req.get('host')}${publicUrl}`;
  const rec = { id: filename, filename, url: publicUrl, absoluteUrl, createdAt: new Date().toISOString() };

  store.uploads.unshift(rec);

  // Fake AI
  const suggestions = [
    { id: 's1', foodName: 'Chicken & Rice Bowl', serving: '1 bowl (350g)', confidence: 0.86,
      macros: { caloriesKcal: 520, proteinG: 38, carbsG: 62, fatG: 12, fiberG: 4 } },
    { id: 's2', foodName: 'Greek Yogurt + Banana', serving: '1 cup + 1 medium', confidence: 0.74,
      macros: { caloriesKcal: 260, proteinG: 18, carbsG: 36, fatG: 4, fiberG: 3 } },
    { id: 's3', foodName: 'Protein Shake', serving: '1 scoop + water', confidence: 0.63,
      macros: { caloriesKcal: 180, proteinG: 25, carbsG: 6, fatG: 2, fiberG: 1 } },
  ];

  res.json({ image: rec, suggestions });
});

// ---- List uploads (for “Recent Captures”)
app.get('/v1/uploads', (req, res) => {
  const limit = Math.min(100, Number(req.query.limit || 20));
  res.json({ items: store.uploads.slice(0, limit) });
});

// ---- Log meal
app.post('/v1/meals', (req, res) => {
  const { date, type, title, imageAbsoluteUrl, macros } = req.body || {};
  if (!date || !type || !macros) {
    return res.status(400).json({ error: { code: 'bad_request', message: 'date, type, macros are required' } });
  }
  if (!store.mealsByDate[date]) store.mealsByDate[date] = [];

  const item = {
    id: `meal_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type,                                // 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack'
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

  // Return new running totals for that day
  const totals = store.mealsByDate[date].reduce((acc, m) => {
    acc.caloriesKcal += m.macros.caloriesKcal;
    acc.proteinG += m.macros.proteinG;
    acc.carbsG += m.macros.carbsG;
    acc.fatG += m.macros.fatG;
    acc.fiberG += m.macros.fiberG;
    return acc;
  }, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });

  res.json({ id: item.id, accepted: true, item, totals });
});

// ---- Get meals for a date (?date=YYYY-MM-DD)
app.get('/v1/meals', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : isoDate();
  const items = (store.mealsByDate[date] || []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const totals = items.reduce((acc, m) => {
    acc.caloriesKcal += m.macros.caloriesKcal;
    acc.proteinG += m.macros.proteinG;
    acc.carbsG += m.macros.carbsG;
    acc.fatG += m.macros.fatG;
    acc.fiberG += m.macros.fiberG;
    return acc;
  }, { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0, fiberG: 0 });

  res.json({ date, items, totals });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Calgooo server on http://localhost:${PORT}`);
});
