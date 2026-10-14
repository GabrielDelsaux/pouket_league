'use strict';
// Pouket League 3D — serveur autoritatif + comptes (profils), voitures, matchmaking classé
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3001;
const PUB = path.join(__dirname, 'public');
const THREE_JS = path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js');
const DATA_DIR = process.env.PL_DATA || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'profiles.json');

// ---------- dimensions de l'arène (unités ≈ mètres) ----------
// Arène agrandie 88 x 130 x 34 avec coins arrondis (le client lit ces dimensions dans le message "ar").
// Lancer avec PL_CLIENT_V2=0 pour revenir à l'ancienne arène 80 x 120 x 32 sans coins arrondis.
const V2 = process.env.PL_CLIENT_V2 !== '0';
const AW = V2 ? 88 : 80, AL = V2 ? 130 : 120, AH = V2 ? 34 : 32;   // largeur (X), longueur (Z), hauteur (Y)
const GW = V2 ? 20 : 16, GH = V2 ? 9.5 : 8, GD = V2 ? 9 : 8;   // but : largeur, hauteur, profondeur (avant : 16 x 8 x 8)
const GR = V2 ? 4 : 0;                     // rayon d'arrondi des deux coins du haut de l'ouverture du but
const CR = V2 ? 14 : 0;                    // rayon des coins arrondis (vus de dessus) ; 0 = coins carrés
const BR = 2.8;                              // rayon du ballon
const DT = 1 / 60, MAXP = 6, MATCH = +process.env.PL_MATCH || 180;
const hw = AW / 2, hl = AL / 2;
const ARENA = [AW, AL, AH, GW, GH, GD, CR, GR];  // envoyé au client à l'entrée dans un salon
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = v => Math.round(v * 100) / 100;
const wrap = d => { d %= 6.28319; if (d > 3.14159) d -= 6.28319; if (d < -3.14159) d += 6.28319; return d; };

// voitures : mêmes réglages de conduite, seule la hitbox change (demi-dimensions X, Y, Z)
const CARS = { octane: { hx: 1.28, hy: 0.55, hz: 1.8 }, fennec: { hx: 1.3, hy: 0.65, hz: 1.7 }, dominus: { hx: 1.27, hy: 0.48, hz: 1.95 } };
const carType = t => (CARS[t] ? t : 'octane');

const PADS = [];
[[-38, 0], [38, 0], [-38, -55], [38, -55], [-38, 55], [38, 55]].forEach(([x, z]) => PADS.push({ x, z, a: 100, cd: 0 }));
for (const x of [-17, 17]) for (const z of [-44, -28, -13, 13, 28, 44]) PADS.push({ x, z, a: 12, cd: 0 });
for (const z of [-50, -22, 0, 22, 50]) PADS.push({ x: 0, z, a: 12, cd: 0 });
const PADLIST = PADS.map(q => [q.x, q.z, q.a]);
const BOTS = ['Turbo', 'Fusée', 'Nitro', 'Blitz', 'Comète', 'Éclair'];

// ---------- profils & rangs ----------
let DB = { players: {} };
try { DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { /* premier lancement */ }
if (!DB.players) DB.players = {};
let saveT = null;
function saveDB() {
  if (saveT) return;
  saveT = setTimeout(() => {
    saveT = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFile(tmp, JSON.stringify(DB), e => { if (!e) fs.rename(tmp, DATA_FILE, () => { }); });
    } catch (e) { console.error('sauvegarde impossible :', e.message); }
  }, 1500);
}
const cleanName = s => String(s || '').replace(/[<>&"'\\]/g, '').trim().slice(0, 14);
function getProfile(tok, name) {
  let p = DB.players[tok];
  if (!p) p = DB.players[tok] = {
    id: crypto.randomBytes(4).toString('hex'), name: name || 'Joueur', car: 'octane', created: Date.now(),
    mmr: { 1: 300, 2: 300 }, rk: { 1: 0, 2: 0 }, rw: { 1: 0, 2: 0 }, st: { m: 0, w: 0, l: 0, g: 0, streak: 0, best: 0, dm: 0 }, cars: {}, hist: [], keys: null
  };
  return p;
}
const TIERS = [['Bronze', '#c8814a'], ['Argent', '#c3cbdc'], ['Or', '#ffd24a'], ['Platine', '#5fe0d0'], ['Diamant', '#5aa2ff'], ['Champion', '#c07bff'], ['Grand Champion', '#ff5a5a']];
function rank(mmr) {
  const t = Math.min(6, Math.floor(Math.max(0, mmr) / 300)), d = t === 6 ? 0 : Math.floor((mmr % 300) / 100);
  return { name: TIERS[t][0], col: TIERS[t][1], div: d, label: TIERS[t][0] + (t === 6 ? '' : ' ' + ['I', 'II', 'III'][d]), prog: t === 6 ? 100 : Math.floor(mmr % 100) };
}
function pub(p) {
  return { id: p.id, name: p.name, car: p.car, mmr: p.mmr, rank: [null, rank(p.mmr[1]), rank(p.mmr[2])], place: p.rk, rw: p.rw, st: p.st, cars: p.cars, hist: p.hist.slice(-8).reverse(), keys: p.keys || null };
}

// ---------- serveur HTTP statique ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400).end(); return; }
  if (p === '/') p = '/index.html';
  const f = p === '/vendor/three.min.js' ? THREE_JS : path.join(PUB, path.normalize(p));
  if (f !== THREE_JS && !f.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }).end(d);
  });
});

// ---------- physique ----------
function makeCar(team, slot, type) {
  const h = CARS[carType(type)], x = [0, -9, 9][slot % 3];
  return {
    x, y: h.hy, z: team ? 38 : -38, vx: 0, vy: 0, vz: 0, yw: team ? Math.PI : 0, p: 0, r: 0, boost: 33, hx: h.hx, hy: h.hy, hz: h.hz,
    jumps: 0, pj: false, on: true, fl: 0, flipT: 0, fpd: 0, frd: 0, fp: 0, fr: 0, jT: 0, jh: 0, slide: 0, dr: 0, dead: 0
  };
}

// axes locaux de la voiture dans le monde (ordre d'Euler YXZ : yaw, pitch, roll) ; X = gauche, Y = haut, Z = avant
function axes(c) {
  const a = Math.cos(c.p), b = Math.sin(c.p), cy = Math.cos(c.yw), d = Math.sin(c.yw), e = Math.cos(c.r), f = Math.sin(c.r);
  const ce = cy * e, cf = cy * f, de = d * e, df = d * f;
  return { X: [ce + df * b, a * f, cf * b - de], Y: [de * b - cf, a * e, df + ce * b], Z: [a * d, -b, a * cy] };
}
function extents(A, c) {
  return [Math.abs(A.X[0]) * c.hx + Math.abs(A.Y[0]) * c.hy + Math.abs(A.Z[0]) * c.hz,
  Math.abs(A.X[1]) * c.hx + Math.abs(A.Y[1]) * c.hy + Math.abs(A.Z[1]) * c.hz,
  Math.abs(A.X[2]) * c.hx + Math.abs(A.Y[2]) * c.hy + Math.abs(A.Z[2]) * c.hz];
}

// coins arrondis (vus de dessus) : repousse l'objet o (x, z) à l'intérieur de l'arc de rayon CR,
// avec une marge m (rayon de l'objet). Renvoie la normale sortante du mur si une correction a eu lieu.
function cornerFix(o, m) {
  const cx = hw - CR, cz = hl - CR, ax = Math.abs(o.x), az = Math.abs(o.z);
  if (ax <= cx || az <= cz) return null;
  const dx = ax - cx, dz = az - cz, d = Math.hypot(dx, dz), lim = CR - m;
  if (d <= lim || d < 1e-6) return null;
  const sx = Math.sign(o.x), sz = Math.sign(o.z);
  o.x = sx * (cx + dx * lim / d); o.z = sz * (cz + dz * lim / d);
  return [sx * dx / d, sz * dz / d];
}

// ---- réglages de conduite (unités/s) ----
const V_DRIVE = 24, V_BOOST = 36, V_CAP = 42;   // vitesse max normale / avec turbo / absolue (dashs inclus)
const ACC = 30, ACC_BOOST_G = 26, ACC_BOOST_A = 30, BRAKE = 55, COAST = 7;
const TURN = 3.8, TURN_DRIFT = 2.5;             // braquage (rad/s) à basse vitesse / minimum en dérapage
const GRIP = 0.62, GRIP_DRIFT = 0.975, GRIP_SLIDE = 0.985;   // adhérence latérale par tick (plus c'est haut, plus on glisse)
const ROLL_FRIC = 0.18, ROLL_STOP = 0.15;       // friction de la balle au sol : proportionnelle (par s) + freinage constant (unités/s²) — très réduite
const DASH = 16;                                // impulsion d'un dash
const BALL_MAX = 46;                            // vitesse max de la balle (avant : 60)
const DEMO_V = 32, DEMO_ALONG = 22;             // vitesse mini de l'attaquant (≈ turbo à fond) et vitesse d'approche mini pour démolir
const DEMO_TICKS = 150;                         // 2,5 s avant la réapparition

function stepCar(c, i) {
  let A = axes(c), [ex, ey, ez] = extents(A, c);
  c.on = c.y - ey <= 0.12; c.fl = 0; c.dr = 0;
  const th = (i.w ? 1 : 0) - (i.s ? 1 : 0), st = (i.a ? 1 : 0) - (i.d ? 1 : 0), ro = (i.e ? 1 : 0) - (i.q ? 1 : 0);
  const bo = i.b && c.boost > 0, hb = !!i.h;
  if (bo) { c.boost = Math.max(0, c.boost - 33 * DT); c.fl = 1; }

  if (c.on) {
    c.jumps = 0; c.flipT = 0; c.fp = 0; c.fr = 0; c.jh = 0;
    // 1) braquage : plus la voiture est lente, plus elle tourne ; le frein à main (dérapage) l'augmente
    let sp = c.vx * Math.sin(c.yw) + c.vz * Math.cos(c.yw);
    const asp = Math.abs(sp);
    let turn = TURN / (1 + asp / 16) * Math.min(1, asp / 3);
    if (hb) turn = Math.max(turn * 1.5, TURN_DRIFT * Math.min(1, asp / 4));
    c.yw += st * turn * (sp < -0.5 ? -1 : 1) * DT;
    // 2) on décompose la vitesse selon le NOUVEAU cap : avant / latéral
    const fx = Math.sin(c.yw), fz = Math.cos(c.yw);
    let fwd = c.vx * fx + c.vz * fz, latx = c.vx - fx * fwd, latz = c.vz - fz * fwd;
    const max = bo ? V_BOOST : V_DRIVE;
    if (th) {
      if ((th > 0) === (fwd >= 0) || Math.abs(fwd) < 0.5 || hb) fwd += th * ACC * (1 - 0.7 * clamp(Math.abs(fwd) / max, 0, 1)) * DT;
      else fwd += th * BRAKE * DT;
    } else { const d = COAST * DT; fwd = Math.abs(fwd) <= d ? 0 : fwd - Math.sign(fwd) * d; }
    if (bo) fwd += ACC_BOOST_G * DT;
    if (hb) fwd *= 0.998;
    if (fwd > max) fwd = Math.max(max, fwd - 40 * DT);   // dépassement de vitesse : décélération plus douce
    fwd = Math.max(fwd, -14);
    // 3) adhérence : en dérapage (ou juste après un dash) la vitesse latérale se conserve, donc la voiture glisse
    if (c.slide > 0) c.slide -= DT;
    const grip = hb ? GRIP_DRIFT : (c.slide > 0 ? GRIP_SLIDE : GRIP);
    c.vx = fx * fwd + latx * grip; c.vz = fz * fwd + latz * grip;
    if (hb && asp > 6) c.dr = 1;
    if (c.vy < 0) c.vy = 0;
    const k = Math.min(1, 12 * DT);
    c.p -= c.p * k; c.r = wrap(c.r) * (1 - k);
  } else {
    c.vy -= 24 * DT;
    if (c.flipT > 0) {   // pendant un dash, la rotation du flip prime sur les commandes
      c.flipT -= DT;
      const ang = (1 - Math.max(0, c.flipT) / 0.45) * 6.28319;
      c.fp = c.fpd * ang; c.fr = c.frd * ang;
      if (c.flipT <= 0) { c.fp = 0; c.fr = 0; }
    } else {
      c.yw += st * 3.0 * DT;
      c.p = clamp(c.p + th * 3.5 * DT, -1.25, 1.25);
      c.r += ro * 4 * DT;
      // stabilisation douce sans commande : la voiture retombe plus à plat
      if (!th) c.p -= c.p * 0.8 * DT;
      if (!ro) c.r = wrap(c.r) * (1 - 0.8 * DT);
    }
    if (c.jT > 0) c.jT -= DT;
    // saut variable : maintenir la touche juste après le saut donne un peu plus de hauteur
    if (c.jh > 0) { if (i.j) { c.vy += 15 * DT; c.jh -= DT; } else c.jh = 0; }
    if (bo) { c.vx += A.Z[0] * ACC_BOOST_A * DT; c.vy += A.Z[1] * ACC_BOOST_A * DT; c.vz += A.Z[2] * ACC_BOOST_A * DT; }
  }

  if (i.j && !c.pj) {
    if (c.on) { c.vy = 9.5; c.jumps = 1; c.on = false; c.jT = 1.6; c.jh = 0.18; }
    else if (c.jumps < 2 && (c.jT > 0 || c.jumps === 0)) {
      c.jumps = 2; c.jh = 0;
      if (th || st) {
        // dash dans la direction demandée, par rapport à la voiture : avant, arrière, gauche, droite (et diagonales)
        let fx = A.Z[0], fz = A.Z[2]; const fl = Math.hypot(fx, fz);
        if (fl < 0.2) { fx = Math.sin(c.yw); fz = Math.cos(c.yw); } else { fx /= fl; fz /= fl; }
        const lx = fz, lz = -fx;                      // vecteur « gauche » de la voiture
        let dx = fx * th + lx * st, dz = fz * th + lz * st; const dl = Math.hypot(dx, dz); dx /= dl; dz /= dl;
        c.vx += dx * DASH; c.vz += dz * DASH; c.vy = Math.max(c.vy * 0.3, 2);
        c.flipT = 0.45; c.slide = 0.9;
        c.fpd = th / Math.hypot(th, st); c.frd = -st / Math.hypot(th, st);
      } else c.vy = Math.max(c.vy, 0) + 9;            // double saut simple
    }
  }
  c.pj = !!i.j;

  const sp3 = Math.hypot(c.vx, c.vy, c.vz); if (sp3 > V_CAP) { const k = V_CAP / sp3; c.vx *= k; c.vy *= k; c.vz *= k; }
  c.x += c.vx * DT; c.y += c.vy * DT; c.z += c.vz * DT;

  A = axes(c); [ex, ey, ez] = extents(A, c);
  if (c.y < ey || (c.on && c.vy <= 0.01)) { c.y = ey; if (c.vy < 0) c.vy = 0; }
  if (c.y > AH - ey) { c.y = AH - ey; if (c.vy > 0) c.vy = 0; }
  if (c.x > hw - ex) { c.x = hw - ex; if (c.vx > 0) c.vx = 0; }
  if (c.x < -hw + ex) { c.x = -hw + ex; if (c.vx < 0) c.vx = 0; }
  const gax = Math.abs(c.x) + ex, gay = c.y + ey;
  let inOpen = gax <= GW / 2 && gay <= GH;
  if (inOpen && GR > 0) { const gcx = GW / 2 - GR, gcy = GH - GR; if (gax > gcx && gay > gcy && Math.hypot(gax - gcx, gay - gcy) > GR) inOpen = false; }
  const zl = inOpen ? hl + GD - ez : hl - ez;
  if (c.z > zl) { c.z = zl; if (c.vz > 0) c.vz = 0; }
  if (c.z < -zl) { c.z = -zl; if (c.vz < 0) c.vz = 0; }
  // coins arrondis : la voiture glisse le long de l'arc au lieu de s'arrêter net
  const cn = cornerFix(c, Math.max(ex, ez));
  if (cn) { const vn = c.vx * cn[0] + c.vz * cn[1]; if (vn > 0) { c.vx -= vn * cn[0]; c.vz -= vn * cn[1]; } }
}

function carHit(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz), M = 3.6;
  if (d >= M || d < 0.01) return;
  const nx = dx / d, ny = dy / d, nz = dz / d, o = (M - d) / 2;
  a.x -= nx * o; a.y -= ny * o; a.z -= nz * o; b.x += nx * o; b.y += ny * o; b.z += nz * o;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
  if (vn < 0) { const k = vn * 0.6; a.vx += nx * k; a.vy += ny * k; a.vz += nz * k; b.vx -= nx * k; b.vy -= ny * k; b.vz -= nz * k; }
}

// frappe de balle : la vitesse de sortie est proportionnelle à la vitesse d'impact,
// avec un « effet puissance » qui grandit un peu avec la vitesse (touche lente = balle lente)
// Gain réduit par rapport à avant (1.2 → 0.95 de base) : la balle part moins vite.
function ballHit(c, B) {
  const A = axes(c), dx = B.x - c.x, dy = B.y - c.y, dz = B.z - c.z;
  const lx = dx * A.X[0] + dy * A.X[1] + dz * A.X[2], ly = dx * A.Y[0] + dy * A.Y[1] + dz * A.Y[2], lz = dx * A.Z[0] + dy * A.Z[1] + dz * A.Z[2];
  let ex = lx - clamp(lx, -c.hx, c.hx), ey = ly - clamp(ly, -c.hy, c.hy), ez = lz - clamp(lz, -c.hz, c.hz), d = Math.hypot(ex, ey, ez);
  if (d >= BR) return 0;
  if (d < 1e-4) { ex = 0; ey = 1; ez = 0; d = 1; }
  ex /= d; ey /= d; ez /= d;
  const toW = (a, b, cc) => [A.X[0] * a + A.Y[0] * b + A.Z[0] * cc, A.X[1] * a + A.Y[1] * b + A.Z[1] * cc, A.X[2] * a + A.Y[2] * b + A.Z[2] * cc];
  const ns = toW(ex, ey, ez);                                   // normale de la surface touchée
  B.x += ns[0] * (BR - d); B.y += ns[1] * (BR - d); B.z += ns[2] * (BR - d);
  let ox = lx, oy = ly * 0.35, oz = lz; const ol = Math.hypot(ox, oy, oz) || 1;
  const nd = toW(ox / ol, oy / ol, oz / ol);                    // direction centre voiture -> balle, aplatie en hauteur
  let nx = ns[0] * 0.4 + nd[0] * 0.6, ny = ns[1] * 0.4 + nd[1] * 0.6, nz = ns[2] * 0.4 + nd[2] * 0.6;
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  const vn = (B.vx - c.vx) * nx + (B.vy - c.vy) * ny + (B.vz - c.vz) * nz;
  if (vn < 0) {
    const rel = -vn, gain = 0.95 + 0.35 * Math.min(1, rel / 30) + (c.flipT > 0 ? 0.2 : 0);
    B.vx += nx * rel * gain; B.vy += ny * rel * gain; B.vz += nz * rel * gain;
  }
  const s = Math.hypot(B.vx, B.vy, B.vz); if (s > BALL_MAX) { const k = BALL_MAX / s; B.vx *= k; B.vy *= k; B.vz *= k; }
  return -vn;
}

// la balle (centre) est-elle dans l'ouverture du but, avec une marge m ? coins du haut arrondis (rayon GR)
function inMouth(x, y, m) {
  const ax = Math.abs(x);
  if (ax > GW / 2 - m || y > GH - m) return false;
  const cx = GW / 2 - GR, cy = GH - GR;
  if (GR > 0 && ax > cx && y > cy) return Math.hypot(ax - cx, y - cy) <= GR - m;
  return true;
}

function ballWalls(B) {
  if (B.y < BR) { B.y = BR; B.vy = -B.vy * 0.7; if (Math.abs(B.vy) < 1.2) B.vy = 0; B.vx *= 0.9985; B.vz *= 0.9985; }
  if (B.y > AH - BR) { B.y = AH - BR; B.vy = -Math.abs(B.vy) * 0.6; }
  const open = inMouth(B.x, B.y, BR - 0.01);
  if (Math.abs(B.z) > hl - BR && open) {
    B.x = clamp(B.x, -(GW / 2 - BR), GW / 2 - BR); B.y = Math.min(B.y, GH - BR);
    const lim = hl + GD - BR;
    if (B.z > lim) { B.z = lim; B.vz = -Math.abs(B.vz) * 0.4; }
    if (B.z < -lim) { B.z = -lim; B.vz = Math.abs(B.vz) * 0.4; }
  } else {
    if (B.z > hl - BR) { B.z = hl - BR; B.vz = -Math.abs(B.vz) * 0.65; }
    if (B.z < -hl + BR) { B.z = -hl + BR; B.vz = Math.abs(B.vz) * 0.65; }
  }
  if (B.x > hw - BR) { B.x = hw - BR; B.vx = -Math.abs(B.vx) * 0.65; }
  if (B.x < -hw + BR) { B.x = -hw + BR; B.vx = Math.abs(B.vx) * 0.65; }
  // coins arrondis : la balle rebondit sur l'arc, elle ne reste plus coincée dans l'angle
  const cn = cornerFix(B, BR);
  if (cn) { const vn = B.vx * cn[0] + B.vz * cn[1]; if (vn > 0) { B.vx -= 1.65 * vn * cn[0]; B.vz -= 1.65 * vn * cn[1]; } }
}

function botInput(p, ball) {
  const c = p.car, i = { w: 0, s: 0, a: 0, d: 0, j: 0, b: 0, q: 0, e: 0, h: 0 };
  const dir = p.team === 0 ? 1 : -1;
  let ux = -ball.x, uz = dir * hl - ball.z; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
  const dist = Math.hypot(ball.x - c.x, ball.z - c.z);
  let tx = ball.x - ux * 5, tz = ball.z - uz * 5;
  const behind = (c.x - ball.x) * ux + (c.z - ball.z) * uz < -2;
  if (behind && dist < 30) { tx = ball.x; tz = ball.z; }
  if (!c.on) {
    if (c.p < -0.1) i.w = 1; else if (c.p > 0.1) i.s = 1;
    i.j = +(c.jumps === 1 && !c.pj && dist < 9 && c.jT > 0);
    if (i.j) i.w = 1;
  } else {
    const d = wrap(Math.atan2(tx - c.x, tz - c.z) - c.yw);
    if (d > 0.08) i.a = 1; else if (d < -0.08) i.d = 1;
    if (Math.abs(d) < 1.4) i.w = 1; else i.s = 1;
    if (Math.abs(d) < 0.25 && dist > 22) i.b = 1;
    if (dist < 9 && ball.y > 3.2) i.j = 1;
  }
  return i;
}

// ---------- salons ----------
const rooms = new Map();
const rndCode = n => { let s = ''; for (let i = 0; i < n; i++) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]; return s; };
class Room {
  constructor(code, opts = {}) {
    Object.assign(this, {
      code, ranked: !!opts.ranked, pl: opts.pl || 0, players: new Map(), nid: 1, state: 'wait', timer: 0, sc: [0, 0], tm: MATCH, ot: false,
      tick: 0, last: 0, lt: [0, 0], hitT: 0, fin: false, settled: false, winner: -1
    });
    this.pads = PADS.map(p => ({ ...p }));
    this.resetBall();
  }
  resetBall() { this.ball = { x: 0, y: BR, z: 0, vx: 0, vy: 0, vz: 0 }; }
  humans() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  send(p, o) { if (p.ws && p.ws.readyState === 1) p.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  all(o) { const s = JSON.stringify(o); for (const p of this.players.values()) this.send(p, s); }
  roster() {
    const key = this.pl || 1;
    this.all({ t: 'r', pl: [...this.players.values()].map(p => ({ id: p.id, n: p.name, tm: p.team, b: p.bot ? 1 : 0, c: p.carType, k: p.prof ? rank(p.prof.mmr[key]).label : '' })) });
  }
  add(o) {
    if (this.players.size >= MAXP) return null;
    const cnt = [0, 0]; for (const p of this.players.values()) cnt[p.team]++;
    const team = o.team != null ? o.team : (cnt[0] <= cnt[1] ? 0 : 1), type = carType(o.carType);
    const p = { id: this.nid++, name: o.name, ws: o.ws || null, bot: !!o.bot, team, carType: type, car: makeCar(team, cnt[team], type), inp: {}, prof: o.prof || null, conn: o.conn || null };
    this.players.set(p.id, p);
    if (!o.quiet) this.roster();
    return p;
  }
  begin() {
    this.state = 'count'; this.timer = 180; this.last = 0; this.lt = [0, 0]; this.resetBall();
    const cnt = [0, 0]; for (const p of this.players.values()) p.car = makeCar(p.team, cnt[p.team]++, p.carType);
  }
  start() { this.sc = [0, 0]; this.tm = MATCH; this.ot = false; this.settled = false; this.winner = -1; this.begin(); }
  finish() { this.state = 'over'; this.timer = 480; this.winner = this.sc[0] > this.sc[1] ? 0 : 1; this.settle(null); }
  abandon(p) { // un joueur classé quitte avant la fin : il perd, l'adversaire gagne
    if (this.settled || this.state === 'over') return;
    this.settle(p); this.state = 'over'; this.timer = 240; this.winner = 1 - p.team;
  }
  // mise à jour des statistiques (et du MMR en classé) pour les joueurs humains
  settle(leaver) {
    if (this.settled) return; this.settled = true;
    const hs = [...this.players.values()].filter(p => !p.bot && p.prof), key = this.pl || 1;
    const won = t => (leaver ? leaver.team !== t : this.winner === t);
    let avg = [300, 300];
    if (this.ranked) { const n = [0, 0], s = [0, 0]; for (const p of hs) { n[p.team]++; s[p.team] += p.prof.mmr[key]; } avg = [n[0] ? s[0] / n[0] : 300, n[1] ? s[1] / n[1] : 300]; }
    for (const p of hs) {
      if (leaver && this.ranked && p !== leaver && p.team === leaver.team) continue; // coéquipier d'un abandon : pas de changement
      const w = won(p.team), pr = p.prof, st = pr.st;
      st.m++; if (w) { st.w++; st.streak++; st.best = Math.max(st.best, st.streak); } else { st.l++; st.streak = 0; }
      pr.cars[p.carType] = (pr.cars[p.carType] || 0) + 1;
      if (this.ranked) {
        const before = pr.mmr[key], n = pr.rk[key] || 0, k = n < 5 ? 60 : 28;
        const exp = 1 / (1 + Math.pow(10, (avg[1 - p.team] - avg[p.team]) / 400));
        let d = Math.round(k * ((w ? 1 : 0) - exp)); if (w && d < 4) d = 4; if (!w && d > -4) d = -4;
        pr.mmr[key] = Math.max(0, before + d); pr.rk[key] = n + 1; pr.rw[key] = (pr.rw[key] || 0) + (w ? 1 : 0);
        const opp = [...this.players.values()].filter(o => o.team !== p.team).map(o => o.name).join(' & ');
        pr.hist.push({ w, d: pr.mmr[key] - before, pl: key, opp, sc: this.sc.slice(), t: Date.now() }); if (pr.hist.length > 20) pr.hist.shift();
        this.send(p, { t: 'res', win: w, delta: pr.mmr[key] - before, pl: key, before: rank(before), after: rank(pr.mmr[key]), mmr: pr.mmr[key], place: pr.rk[key] });
      }
      this.send(p, { t: 'prof', p: pub(pr) });
    }
    saveDB();
  }
  close() {
    for (const p of this.players.values()) if (p.conn) { this.send(p, { t: 'back' }); p.conn.room = null; p.conn.me = null; }
    this.players.clear(); rooms.delete(this.code);
  }
  score(team) {
    this.sc[team]++; this.state = 'goal'; this.timer = 200; this.fin = this.ot;
    let sp = this.players.get(this.lt[team]), own = 0;
    if (!sp) { sp = this.players.get(this.last); own = sp ? 1 : 0; }
    if (sp && !own && sp.prof) { sp.prof.st.g++; saveDB(); }
    this.all({ t: 'g', tm: team, n: sp ? sp.name : '', own });
  }

  // ---- démolitions ----
  // l'attaquant doit rouler à (presque) vitesse max et foncer sur un adversaire : la victime explose
  tryDemo(P, Q) {
    const a = P.car, b = Q.car;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
    if (d >= 3.6 || d < 0.01) return false;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const aAlong = a.vx * nx + a.vy * ny + a.vz * nz, bAlong = -(b.vx * nx + b.vy * ny + b.vz * nz);
    const ka = (Math.hypot(a.vx, a.vz) >= DEMO_V && aAlong >= DEMO_ALONG) ? aAlong : 0;
    const kb = (Math.hypot(b.vx, b.vz) >= DEMO_V && bAlong >= DEMO_ALONG) ? bAlong : 0;
    if (!ka && !kb) return false;
    if (ka >= kb) this.demolish(Q, P); else this.demolish(P, Q);
    return true;
  }
  demolish(victim, by) {
    const c = victim.car;
    c.dead = DEMO_TICKS; c.vx = c.vy = c.vz = 0; c.boost = 0; c.fl = 0; c.dr = 0; c.flipT = 0;
    this.all({ t: 'd', v: victim.id, by: by.id, x: r2(c.x), y: r2(c.y), z: r2(c.z) });
    if (by.prof) { by.prof.st.dm = (by.prof.st.dm || 0) + 1; saveDB(); }
  }
  // réapparition dans un coin aléatoire de son propre camp, face au centre
  respawn(p) {
    const c = makeCar(p.team, 0, p.carType), sx = Math.random() < 0.5 ? -1 : 1;
    c.x = sx * (hw - 9); c.z = (p.team ? 1 : -1) * (hl - 9);
    c.yw = Math.atan2(-c.x, -c.z);
    p.car = c;
  }

  phys() {
    const ps = [...this.players.values()];
    for (const p of ps) {
      if (p.car.dead > 0) { if (--p.car.dead <= 0) this.respawn(p); continue; }
      stepCar(p.car, p.inp || {}); if (p.bot) p.car.boost = Math.min(100, p.car.boost + 2 * DT);
    }
    for (const pd of this.pads) {
      if (pd.cd > 0) { pd.cd--; continue; }
      for (const p of ps) {
        const c = p.car;
        if (c.dead > 0) continue;
        if (c.on && c.boost < 100 && Math.hypot(c.x - pd.x, c.z - pd.z) < (pd.a >= 100 ? 3 : 2)) { c.boost = Math.min(100, c.boost + pd.a); pd.cd = pd.a >= 100 ? 600 : 240; break; }
      }
    }
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
      const P = ps[a], Q = ps[b];
      if (P.car.dead > 0 || Q.car.dead > 0) continue;
      if (this.state === 'play' && P.team !== Q.team && this.tryDemo(P, Q)) continue;
      carHit(P.car, Q.car);
    }
    const B = this.ball;
    B.vy -= 18 * DT; B.vx *= 1 - 0.008 * DT; B.vy *= 1 - 0.008 * DT; B.vz *= 1 - 0.008 * DT;   // frottement de l'air très réduit
    B.x += B.vx * DT; B.y += B.vy * DT; B.z += B.vz * DT;
    ballWalls(B);
    // friction de roulement : si la balle roule au sol, elle ralentit doucement jusqu'à s'arrêter
    if (B.y <= BR + 0.05 && Math.abs(B.vy) < 3) {
      const s = Math.hypot(B.vx, B.vz);
      if (s > 0) { const k = Math.max(0, s * (1 - ROLL_FRIC * DT) - ROLL_STOP * DT) / s; B.vx *= k; B.vz *= k; }
    }
    for (const p of ps) {
      if (p.car.dead > 0) continue;
      const v = ballHit(p.car, B);
      if (v > 0) {
        this.last = p.id; this.lt[p.team] = p.id;
        if (v > 3 && this.tick - this.hitT > 8) { this.hitT = this.tick; this.all({ t: 'h', v: r2(Math.min(1, v / 30)) }); }
      }
    }
    ballWalls(B);
    const g = B.z < -hl - BR ? 1 : B.z > hl + BR ? 0 : -1;
    if (g >= 0) { if (this.state === 'play') this.score(g); else if (this.state !== 'goal') this.resetBall(); }
  }
  step() {
    this.tick++;
    for (const p of this.players.values()) if (p.bot) p.inp = botInput(p, this.ball);
    const s = this.state;
    if (s === 'wait') {
      if (this.players.size >= 2) this.start(); else this.phys();
    } else if (s === 'count') {
      if (--this.timer <= 0) this.state = 'play';
    } else {
      this.phys();
      if (s === 'play') {
        if (this.ot) this.tm += DT;
        else { this.tm -= DT; if (this.tm <= 0) { this.tm = 0; if (this.sc[0] !== this.sc[1]) this.finish(); else this.ot = true; } }
      } else if (--this.timer <= 0) {
        if (s === 'goal') { if (this.fin) this.finish(); else this.begin(); }
        else if (s === 'over') { if (this.ranked) { this.close(); return; } this.state = 'wait'; }
      }
    }
    if (this.tick % 2 === 0) this.all(this.snap());
  }
  snap() {
    const B = this.ball, cars = [];
    for (const p of this.players.values()) {
      const c = p.car;
      // drapeaux : 1 = turbo, 2 = dash, 4 = au sol, 8 = dérapage, 16 = démolie (à cacher côté client)
      cars.push([p.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yw), r2(c.p), r2(c.r), Math.round(c.boost), (c.fl ? 1 : 0) | (c.flipT > 0 ? 2 : 0) | (c.on ? 4 : 0) | (c.dr ? 8 : 0) | (c.dead > 0 ? 16 : 0), r2(c.fp), r2(c.fr)]);
    }
    return { t: 's', st: this.state, w: this.winner, tm: Math.ceil(this.tm), ot: +this.ot, sc: this.sc, cd: Math.ceil(this.timer / 60), b: [r2(B.x), r2(B.y), r2(B.z)], c: cars, p: this.pads.map(p => (p.cd > 0 ? '0' : '1')).join('') };
  }
}

// ---------- matchmaking classé ----------
const queues = { 1: [], 2: [] };
function unqueue(conn) { if (!conn.q) return; queues[conn.q] = queues[conn.q].filter(e => e.conn !== conn); conn.q = null; }
function matchmake() {
  for (const pl of [1, 2]) {
    const q = queues[pl], need = pl * 2; if (q.length < need) continue;
    q.sort((a, b) => a.since - b.since);
    const a = q[0], span = 150 + (Date.now() - a.since) / 1000 * 12;
    const cand = q.filter(e => Math.abs(e.mmr - a.mmr) <= span).sort((x, y) => Math.abs(x.mmr - a.mmr) - Math.abs(y.mmr - a.mmr)).slice(0, need);
    if (cand.length === need) startRanked(pl, cand);
  }
}
function startRanked(pl, cs) {
  let code; do code = 'R' + rndCode(4); while (rooms.has(code));
  const room = new Room(code, { ranked: true, pl }); rooms.set(code, room);
  cs.sort((a, b) => b.mmr - a.mmr);
  const teams = pl === 1 ? (Math.random() < 0.5 ? [0, 1] : [1, 0]) : [0, 1, 1, 0];
  cs.forEach((e, i) => {
    const c = e.conn; unqueue(c);
    const p = room.add({ name: c.prof.name, ws: c.ws, team: teams[i], carType: c.prof.car, prof: c.prof, conn: c, quiet: true });
    c.room = room; c.me = p;
  });
  room.start(); room.roster();
  for (const p of room.players.values()) room.send(p, { t: 'w', id: p.id, room: code, team: p.team, ranked: 1, pl, pads: PADLIST, ar: ARENA });
}

// ---------- WebSocket ----------
function leaveRoom(conn) {
  const room = conn.room, me = conn.me; if (!room || !me) return;
  if (room.ranked) room.abandon(me);
  room.players.delete(me.id); conn.room = null; conn.me = null;
  if (!room.humans()) rooms.delete(room.code); else room.roster();
}

const wss = new WebSocketServer({ server, maxPayload: 2048, perMessageDeflate: false });
wss.on('connection', ws => {
  console.log('✅ Nouveau client connecté');
  ws.on('error', err => console.error('❌ WebSocket ERROR :', err));

  const conn = { ws, prof: null, room: null, me: null, q: null };
  const tell = o => ws.readyState === 1 && ws.send(JSON.stringify(o));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') { tell({ t: 'pong', ts: m.ts }); return; }
    if (m.t === 'hello') {
      if (conn.prof) return;
      const tok = /^[a-f0-9]{32}$/.test(m.tok) ? m.tok : crypto.randomBytes(16).toString('hex');
      conn.prof = getProfile(tok, cleanName(m.n) || 'Joueur'); saveDB(); tell({ t: 'prof', p: pub(conn.prof), ar: ARENA }); return;
    }
    const prof = conn.prof; if (!prof) return;
    if (m.t === 'name') { prof.name = cleanName(m.n) || prof.name; saveDB(); return; }
    if (m.t === 'car') { prof.car = carType(m.c); saveDB(); return; }
    // touches personnalisées : { action: "KeyW", ... } sauvegardées avec le compte
    if (m.t === 'keys') {
      if (m.k && typeof m.k === 'object') {
        const k = {}; let n = 0;
        for (const a of Object.keys(m.k)) {
          if (n >= 16) break;
          if (/^[a-zA-Z]{1,12}$/.test(a) && typeof m.k[a] === 'string') { k[a] = m.k[a].replace(/[<>&"'\\]/g, '').slice(0, 40); n++; }
        }
        prof.keys = k; saveDB();
      }
      return;
    }
    if (m.t === 'lb') {
      const key = m.pl === 2 ? 2 : 1;
      const rows = Object.values(DB.players).filter(p => (p.rk[key] || 0) > 0).sort((a, b) => b.mmr[key] - a.mmr[key]).slice(0, 10)
        .map(p => ({ n: p.name, mmr: p.mmr[key], r: rank(p.mmr[key]), w: p.rw[key] || 0, g: p.rk[key] || 0, me: p === prof ? 1 : 0 }));
      tell({ t: 'lb', pl: key, rows }); return;
    }
    if (m.t === 'queue') {
      if (conn.room || conn.q) return;
      const pl = m.pl === 2 ? 2 : 1; prof.name = cleanName(m.n) || prof.name; prof.car = carType(m.c || prof.car);
      queues[pl].push({ conn, mmr: prof.mmr[pl], since: Date.now() }); conn.q = pl; tell({ t: 'q', s: 1, pl }); return;
    }
    if (m.t === 'unq') { unqueue(conn); tell({ t: 'q', s: 0 }); return; }
    if (m.t === 'join') {
      if (conn.room || conn.q) return;
      prof.name = cleanName(m.n) || prof.name; prof.car = carType(m.c || prof.car);
      const code = String(m.r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || rndCode(4);
      const ex = rooms.get(code);
      if (ex && ex.ranked) { tell({ t: 'err', m: 'Ce salon est une partie classée.' }); return; }
      if (!ex && rooms.size >= 100) { tell({ t: 'err', m: 'Serveur plein, réessaie plus tard.' }); return; }
      const rm = ex || new Room(code); if (!ex) rooms.set(code, rm);
      const p = rm.add({ name: prof.name, ws, carType: prof.car, prof, conn });
      if (!p) { tell({ t: 'err', m: 'Salon plein (6 joueurs max).' }); return; }
      conn.room = rm; conn.me = p; saveDB();
      tell({ t: 'w', id: p.id, room: code, team: p.team, ranked: 0, pl: 0, pads: PADLIST, ar: ARENA }); rm.roster(); return;
    }
    if (m.t === 'leave') { leaveRoom(conn); unqueue(conn); tell({ t: 'back' }); return; }
    const me = conn.me, room = conn.room; if (!me || !room) return;
    if (m.t === 'in') me.inp = { w: !!m.w, s: !!m.s, a: !!m.a, d: !!m.d, j: !!m.j, b: !!m.b, q: !!m.q, e: !!m.e, h: !!m.h };
    else if (room.ranked) return;
    else if (m.t === 'bot') {
      if (m.a > 0) { const t = ['octane', 'fennec', 'dominus'][Math.floor(Math.random() * 3)]; room.add({ name: BOTS[room.nid % BOTS.length], bot: true, carType: t }); }
      else { let id = 0; for (const p of room.players.values()) if (p.bot) id = p.id; if (id) { room.players.delete(id); room.roster(); } }
    } else if (m.t === 'team') {
      me.team ^= 1; let n = 0; for (const p of room.players.values()) if (p !== me && p.team === me.team) n++;
      me.car = makeCar(me.team, n, me.carType); room.roster();
    }
  });

  ws.on('close', () => { leaveRoom(conn); unqueue(conn); });
});

// ---------- démarrage (hors de la connexion WebSocket) ----------
if (require.main === module) {
  let last = Date.now(), acc = 0;
  setInterval(() => {
    const n = Date.now(); acc = Math.min(acc + n - last, 100); last = n;
    while (acc >= 1000 / 60) { acc -= 1000 / 60; for (const r of rooms.values()) r.step(); }
  }, 4);
  setInterval(matchmake, 1000);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Pouket League 3D lancé sur le port ${PORT}`);
  });
}

module.exports = { stepCar, makeCar, ballHit, Room, getProfile, rank, pub, DB, rooms, queues, matchmake, CARS };