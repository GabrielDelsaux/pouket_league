'use strict';
// Pouket League 3D — serveur autoritatif (physique 60 Hz, snapshots 30 Hz)
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3001;
const PUB = path.join(__dirname, 'public');
const THREE_JS = path.join(__dirname, 'node_modules', 'three', 'build', 'three.min.js');

// ---------- dimensions de l'arène (unités ≈ mètres) ----------
const AW = 80, AL = 120, AH = 32;          // largeur (X), longueur (Z), hauteur (Y)
const GW = 16, GH = 8, GD = 8;             // but : largeur, hauteur, profondeur
const BR = 2;                              // rayon du ballon
const HX = 1.0, HY = 0.55, HZ = 1.8;       // demi-dimensions de la voiture
const DT = 1 / 60, MAXP = 6, MATCH = 180;
const hw = AW / 2, hl = AL / 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = v => Math.round(v * 100) / 100;
const wrap = d => { d %= 6.28319; if (d > 3.14159) d -= 6.28319; if (d < -3.14159) d += 6.28319; return d; };

const PADS = [];
[[-34, 0], [34, 0], [-34, -50], [34, -50], [-34, 50], [34, 50]].forEach(([x, z]) => PADS.push({ x, z, a: 100, cd: 0 }));
for (const x of [-16, 16]) for (const z of [-40, -26, -12, 12, 26, 40]) PADS.push({ x, z, a: 12, cd: 0 });
for (const z of [-45, -20, 0, 20, 45]) PADS.push({ x: 0, z, a: 12, cd: 0 });
const BOTS = ['Turbo', 'Fusée', 'Nitro', 'Blitz', 'Comète', 'Éclair'];

// ---------- serveur HTTP statique ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = p === '/vendor/three.min.js' ? THREE_JS : path.join(PUB, path.normalize(p));
  if (f !== THREE_JS && !f.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404).end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }).end(d);
  });
});

// ---------- physique ----------
function makeCar(team, slot) {
  const x = [0, -9, 9][slot % 3];
  return { x, y: HY, z: team ? 34 : -34, vx: 0, vy: 0, vz: 0, yw: team ? Math.PI : 0, p: 0, r: 0, boost: 33,
    jumps: 0, pj: false, on: true, fl: 0, flipT: 0, fs: 1, fk: 0, fp: 0, fr: 0, jT: 0 };
}

// axes locaux de la voiture dans le monde (ordre d'Euler YXZ : yaw, pitch, roll) ; X = gauche, Y = haut, Z = avant
function axes(c) {
  const a = Math.cos(c.p), b = Math.sin(c.p), cy = Math.cos(c.yw), d = Math.sin(c.yw), e = Math.cos(c.r), f = Math.sin(c.r);
  const ce = cy * e, cf = cy * f, de = d * e, df = d * f;
  return { X: [ce + df * b, a * f, cf * b - de], Y: [de * b - cf, a * e, df + ce * b], Z: [a * d, -b, a * cy] };
}
function extents(A) {
  return [Math.abs(A.X[0]) * HX + Math.abs(A.Y[0]) * HY + Math.abs(A.Z[0]) * HZ,
          Math.abs(A.X[1]) * HX + Math.abs(A.Y[1]) * HY + Math.abs(A.Z[1]) * HZ,
          Math.abs(A.X[2]) * HX + Math.abs(A.Y[2]) * HY + Math.abs(A.Z[2]) * HZ];
}

function stepCar(c, i) {
  let A = axes(c), [ex, ey, ez] = extents(A);
  c.on = c.y - ey <= 0.12; c.fl = 0;
  const th = (i.w ? 1 : 0) - (i.s ? 1 : 0), st = (i.a ? 1 : 0) - (i.d ? 1 : 0), ro = (i.e ? 1 : 0) - (i.q ? 1 : 0);
  const bo = i.b && c.boost > 0;
  if (bo) { c.boost = Math.max(0, c.boost - 33 * DT); c.fl = 1; }

  if (c.on) {
    c.jumps = 0; c.flipT = 0; c.fp = 0; c.fr = 0;
    let fx = Math.sin(c.yw), fz = Math.cos(c.yw);
    let sp = c.vx * fx + c.vz * fz;
    const latx = c.vx - fx * sp, latz = c.vz - fz * sp;
    if (th) sp += th * (th > 0 !== sp >= 0 && Math.abs(sp) > 1 ? 60 : 30) * DT; else sp *= Math.pow(0.4, DT);
    if (bo) sp += 40 * DT;
    const max = bo ? 46 : 28;
    if (sp > max) sp = Math.max(max, sp - 40 * DT);
    sp = Math.max(sp, -16);
    const turn = 3.2 / (1 + Math.abs(sp) / 12) * Math.min(1, Math.abs(sp) / 5) * (sp < -0.5 ? -1 : 1);
    c.yw += st * turn * DT;
    fx = Math.sin(c.yw); fz = Math.cos(c.yw);
    c.vx = fx * sp + latx * 0.3; c.vz = fz * sp + latz * 0.3;
    if (c.vy < 0) c.vy = 0;
    const k = Math.min(1, 12 * DT);
    c.p -= c.p * k; c.r = wrap(c.r) * (1 - k);
  } else {
    c.vy -= 24 * DT;
    c.yw += st * 3.0 * DT;
    c.p = clamp(c.p + th * 3.5 * DT, -1.25, 1.25);
    c.r += ro * 4 * DT;
    if (c.jT > 0) c.jT -= DT;
    if (bo) { c.vx += A.Z[0] * 38 * DT; c.vy += A.Z[1] * 38 * DT; c.vz += A.Z[2] * 38 * DT; }
    if (c.flipT > 0) {
      c.flipT -= DT;
      const ang = c.fs * (1 - Math.max(0, c.flipT) / 0.45) * 6.28319;
      if (c.fk === 0) { c.fp = ang; c.fr = 0; } else { c.fr = ang; c.fp = 0; }
      if (c.flipT <= 0) { c.fp = 0; c.fr = 0; }
    }
  }

  if (i.j && !c.pj) {
    if (c.on) { c.vy = 10.5; c.jumps = 1; c.on = false; c.jT = 1.6; }
    else if (c.jumps < 2 && (c.jT > 0 || c.jumps === 0)) {
      c.jumps = 2;
      const fx = Math.sin(c.yw), fz = Math.cos(c.yw);
      if (th) { c.vx += fx * th * 13; c.vz += fz * th * 13; c.vy = Math.max(c.vy * 0.3, 2); c.flipT = 0.45; c.fk = 0; c.fs = th; }
      else if (st) { c.vx += fz * st * 13; c.vz -= fx * st * 13; c.vy = Math.max(c.vy * 0.3, 2); c.flipT = 0.45; c.fk = 1; c.fs = st; }
      else c.vy = Math.max(c.vy, 0) + 9;
    }
  }
  c.pj = !!i.j;

  const sp3 = Math.hypot(c.vx, c.vy, c.vz); if (sp3 > 46) { const k = 46 / sp3; c.vx *= k; c.vy *= k; c.vz *= k; }
  c.x += c.vx * DT; c.y += c.vy * DT; c.z += c.vz * DT;

  A = axes(c); [ex, ey, ez] = extents(A);
  if (c.y < ey || (c.on && c.vy <= 0.01)) { c.y = ey; if (c.vy < 0) c.vy = 0; }
  if (c.y > AH - ey) { c.y = AH - ey; if (c.vy > 0) c.vy = 0; }
  if (c.x > hw - ex) { c.x = hw - ex; if (c.vx > 0) c.vx = 0; }
  if (c.x < -hw + ex) { c.x = -hw + ex; if (c.vx < 0) c.vx = 0; }
  const inOpen = Math.abs(c.x) + ex <= GW / 2 && c.y + ey <= GH;
  const zl = inOpen ? hl + GD - ez : hl - ez;
  if (c.z > zl) { c.z = zl; if (c.vz > 0) c.vz = 0; }
  if (c.z < -zl) { c.z = -zl; if (c.vz < 0) c.vz = 0; }
}

function carHit(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz), M = 3.6;
  if (d >= M || d < 0.01) return;
  const nx = dx / d, ny = dy / d, nz = dz / d, o = (M - d) / 2;
  a.x -= nx * o; a.y -= ny * o; a.z -= nz * o; b.x += nx * o; b.y += ny * o; b.z += nz * o;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz;
  if (vn < 0) { const k = vn * 0.6; a.vx += nx * k; a.vy += ny * k; a.vz += nz * k; b.vx -= nx * k; b.vy -= ny * k; b.vz -= nz * k; }
}

function ballHit(c, B) {
  const A = axes(c), dx = B.x - c.x, dy = B.y - c.y, dz = B.z - c.z;
  const lx = dx * A.X[0] + dy * A.X[1] + dz * A.X[2], ly = dx * A.Y[0] + dy * A.Y[1] + dz * A.Y[2], lz = dx * A.Z[0] + dy * A.Z[1] + dz * A.Z[2];
  let ex = lx - clamp(lx, -HX, HX), ey = ly - clamp(ly, -HY, HY), ez = lz - clamp(lz, -HZ, HZ), d = Math.hypot(ex, ey, ez);
  if (d >= BR) return 0;
  if (d < 1e-4) { ex = 0; ey = 1; ez = 0; d = 1; }
  ex /= d; ey /= d; ez /= d;
  const nx = A.X[0] * ex + A.Y[0] * ey + A.Z[0] * ez, ny = A.X[1] * ex + A.Y[1] * ey + A.Z[1] * ez, nz = A.X[2] * ex + A.Y[2] * ey + A.Z[2] * ez;
  B.x += nx * (BR - d); B.y += ny * (BR - d); B.z += nz * (BR - d);
  const vn = (B.vx - c.vx) * nx + (B.vy - c.vy) * ny + (B.vz - c.vz) * nz;
  if (vn < 0) { const k = 1.5 * vn; B.vx -= k * nx; B.vy -= k * ny; B.vz -= k * nz; }
  const extra = (c.fl ? 2 : 0) + (c.flipT > 0 ? 5 : 0);
  B.vx += nx * extra; B.vy += ny * extra; B.vz += nz * extra;
  const s = Math.hypot(B.vx, B.vy, B.vz); if (s > 60) { const k = 60 / s; B.vx *= k; B.vy *= k; B.vz *= k; }
  return -vn;
}

function ballWalls(B) {
  if (B.y < BR) { B.y = BR; B.vy = -B.vy * 0.7; if (Math.abs(B.vy) < 1.2) B.vy = 0; B.vx *= 0.996; B.vz *= 0.996; }
  if (B.y > AH - BR) { B.y = AH - BR; B.vy = -Math.abs(B.vy) * 0.6; }
  const open = Math.abs(B.x) <= GW / 2 - BR + 0.01 && B.y <= GH - BR + 0.01;
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
}

function botInput(p, ball) {
  const c = p.car, i = { w: 0, s: 0, a: 0, d: 0, j: 0, b: 0, q: 0, e: 0 };
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
class Room {
  constructor(code) {
    Object.assign(this, { code, players: new Map(), nid: 1, state: 'wait', timer: 0, sc: [0, 0], tm: MATCH, ot: false, tick: 0, last: 0, lt: [0, 0], hitT: 0, fin: false });
    this.pads = PADS.map(p => ({ ...p }));
    this.resetBall();
  }
  resetBall() { this.ball = { x: 0, y: BR, z: 0, vx: 0, vy: 0, vz: 0 }; }
  humans() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  send(p, o) { if (p.ws && p.ws.readyState === 1) p.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  all(o) { const s = JSON.stringify(o); for (const p of this.players.values()) this.send(p, s); }
  roster() { this.all({ t: 'r', pl: [...this.players.values()].map(p => ({ id: p.id, n: p.name, tm: p.team, b: p.bot ? 1 : 0 })) }); }
  add(name, ws, bot) {
    if (this.players.size >= MAXP) return null;
    const cnt = [0, 0]; for (const p of this.players.values()) cnt[p.team]++;
    const team = cnt[0] <= cnt[1] ? 0 : 1;
    const p = { id: this.nid++, name, ws, bot: !!bot, team, car: makeCar(team, cnt[team]), inp: {} };
    this.players.set(p.id, p); this.roster(); return p;
  }
  begin() {
    this.state = 'count'; this.timer = 180; this.last = 0; this.lt = [0, 0]; this.resetBall();
    const cnt = [0, 0]; for (const p of this.players.values()) p.car = makeCar(p.team, cnt[p.team]++);
  }
  finish() { this.state = 'over'; this.timer = 480; }
  score(team) {
    this.sc[team]++; this.state = 'goal'; this.timer = 200; this.fin = this.ot;
    let sp = this.players.get(this.lt[team]), own = 0;
    if (!sp) { sp = this.players.get(this.last); own = sp ? 1 : 0; }
    this.all({ t: 'g', tm: team, n: sp ? sp.name : '', own });
  }
  phys() {
    const ps = [...this.players.values()];
    for (const p of ps) { stepCar(p.car, p.inp || {}); if (p.bot) p.car.boost = Math.min(100, p.car.boost + 2 * DT); }
    for (const pd of this.pads) {
      if (pd.cd > 0) { pd.cd--; continue; }
      for (const p of ps) {
        const c = p.car;
        if (c.on && c.boost < 100 && Math.hypot(c.x - pd.x, c.z - pd.z) < (pd.a >= 100 ? 3 : 2)) { c.boost = Math.min(100, c.boost + pd.a); pd.cd = pd.a >= 100 ? 600 : 240; break; }
      }
    }
    for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) carHit(ps[a].car, ps[b].car);
    const B = this.ball;
    B.vy -= 18 * DT; B.vx *= 1 - 0.03 * DT; B.vy *= 1 - 0.03 * DT; B.vz *= 1 - 0.03 * DT;
    B.x += B.vx * DT; B.y += B.vy * DT; B.z += B.vz * DT;
    ballWalls(B);
    for (const p of ps) {
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
      if (this.players.size >= 2) { this.sc = [0, 0]; this.tm = MATCH; this.ot = false; this.begin(); } else this.phys();
    } else if (s === 'count') {
      if (--this.timer <= 0) this.state = 'play';
    } else {
      this.phys();
      if (s === 'play') {
        if (this.ot) this.tm += DT;
        else { this.tm -= DT; if (this.tm <= 0) { this.tm = 0; if (this.sc[0] !== this.sc[1]) this.finish(); else this.ot = true; } }
      } else if (--this.timer <= 0) {
        if (s === 'goal') { if (this.fin) this.finish(); else this.begin(); }
        else if (s === 'over') this.state = 'wait';
      }
    }
    if (this.tick % 2 === 0) this.all(this.snap());
  }
  snap() {
    const B = this.ball, cars = [];
    for (const p of this.players.values()) {
      const c = p.car;
      cars.push([p.id, r2(c.x), r2(c.y), r2(c.z), r2(c.yw), r2(c.p), r2(c.r), Math.round(c.boost), (c.fl ? 1 : 0) | (c.flipT > 0 ? 2 : 0) | (c.on ? 4 : 0), r2(c.fp), r2(c.fr)]);
    }
    return { t: 's', st: this.state, tm: Math.ceil(this.tm), ot: +this.ot, sc: this.sc, cd: Math.ceil(this.timer / 60), b: [r2(B.x), r2(B.y), r2(B.z)], c: cars, p: this.pads.map(p => (p.cd > 0 ? '0' : '1')).join('') };
  }
}

const rndCode = () => { let s = ''; for (let i = 0; i < 4; i++) s += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]; return s; };

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2048, perMessageDeflate: false });
wss.on('connection', ws => {
  ws.on('error', () => {});
  let room = null, me = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'ping') { ws.send(JSON.stringify({ t: 'pong', ts: m.ts })); return; }
    if (m.t === 'join' && !me) {
      const name = String(m.n || '').replace(/[<>&"'\\]/g, '').trim().slice(0, 14) || 'Joueur';
      const code = String(m.r || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || rndCode();
      if (!rooms.has(code)) { if (rooms.size >= 100) { ws.send(JSON.stringify({ t: 'err', m: 'Serveur plein, réessaie plus tard.' })); return; } rooms.set(code, new Room(code)); }
      const rm = rooms.get(code), p = rm.add(name, ws, false);
      if (!p) { ws.send(JSON.stringify({ t: 'err', m: 'Salon plein (6 joueurs max).' })); return; }
      room = rm; me = p;
      ws.send(JSON.stringify({ t: 'w', id: p.id, room: code, team: p.team, pads: PADS.map(q => [q.x, q.z, q.a]) }));
      rm.roster();
      return;
    }
    if (!me) return;
    if (m.t === 'in') me.inp = { w: !!m.w, s: !!m.s, a: !!m.a, d: !!m.d, j: !!m.j, b: !!m.b, q: !!m.q, e: !!m.e };
    else if (m.t === 'bot') {
      if (m.a > 0) room.add(BOTS[room.nid % BOTS.length], null, true);
      else { let id = 0; for (const p of room.players.values()) if (p.bot) id = p.id; if (id) { room.players.delete(id); room.roster(); } }
    } else if (m.t === 'team') {
      me.team ^= 1; let n = 0; for (const p of room.players.values()) if (p !== me && p.team === me.team) n++;
      me.car = makeCar(me.team, n); room.roster();
    }
  });
  ws.on('close', () => {
    if (!me) return;
    room.players.delete(me.id); room.roster();
    if (!room.humans()) rooms.delete(room.code);
  });
});

let last = Date.now(), acc = 0;
setInterval(() => {
  const n = Date.now(); acc = Math.min(acc + n - last, 100); last = n;
  while (acc >= 1000 / 60) { acc -= 1000 / 60; for (const r of rooms.values()) r.step(); }
}, 4);

server.listen(PORT, '172.29.18.202', () => console.log(`Pouket League 3D sur http://0.0.0.0:${PORT}`));