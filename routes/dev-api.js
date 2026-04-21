const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');

const router = express.Router();
const ROOT = path.resolve(__dirname, '..');

router.use(express.json({ limit: '20mb' }));

router.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production') return res.status(403).json({ error: 'not available in production' });
  if (!process.env.DEV_API_TOKEN) return res.status(500).json({ error: 'DEV_API_TOKEN not set' });
  if (req.get('X-Dev-Token') !== process.env.DEV_API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

function safePath(p) {
  if (typeof p !== 'string' || !p.length) throw new Error('invalid path');
  const abs = path.resolve(ROOT, p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('path escape');
  return abs;
}

router.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now(), root: ROOT }));

router.get('/ls', async (req, res) => {
  try {
    const p = safePath(req.query.path || '.');
    const entries = await fs.readdir(p, { withFileTypes: true });
    res.json({ path: req.query.path || '.', entries: entries.map(e => ({ name: e.name, dir: e.isDirectory() })) });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

router.get('/read', async (req, res) => {
  try {
    const p = safePath(req.query.path);
    const content = await fs.readFile(p, 'utf8');
    const range = req.query.range;
    if (range) {
      const m = /^(\d+)-(\d+)$/.exec(range);
      if (m) return res.json({ path: req.query.path, range, size: content.length, content: content.slice(+m[1], +m[2]) });
    }
    res.json({ path: req.query.path, size: content.length, content });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

router.post('/write', async (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    if (!p || typeof content !== 'string') return res.status(400).json({ error: 'path and content required' });
    const abs = safePath(p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    res.json({ ok: true, path: p, size: content.length });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

router.post('/patch', async (req, res) => {
  try {
    const { path: p, find, replace } = req.body || {};
    if (!p || typeof find !== 'string' || typeof replace !== 'string') return res.status(400).json({ error: 'path, find, replace required' });
    const abs = safePath(p);
    const src = await fs.readFile(abs, 'utf8');
    const count = src.split(find).length - 1;
    if (count === 0) return res.status(400).json({ error: 'find not found' });
    if (count > 1) return res.status(400).json({ error: `find matches ${count} times` });
    const out = src.split(find).join(replace);
    await fs.writeFile(abs, out, 'utf8');
    res.json({ ok: true, path: p, newSize: out.length });
  } catch (e) { res.status(400).json({ error: String(e) }); }
});

router.post('/exec', (req, res) => {
  const { cmd } = req.body || {};
  if (!cmd) return res.status(400).json({ error: 'cmd required' });
  exec(cmd, { cwd: ROOT, timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
    res.json({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || '').slice(0, 500000), stderr: String(stderr || '').slice(0, 500000) });
  });
});

router.post('/restart', (req, res) => {
  res.json({ ok: true, restarting: true });
  setTimeout(() => process.kill(1, 'SIGTERM'), 200);
});

module.exports = router;
