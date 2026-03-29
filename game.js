'use strict';

function trackEvent(name, params = {}) {
  if (typeof gtag === 'function') gtag('event', name, params);
}

// ============================================================
//  CONSTANTS
// ============================================================
const CELL         = 150;   // grid cell size (world units)
const BALL_R       = 10;
const CUP_R        = 14;
const CUP_SINK_R   = 10;    // ball must be within this + moving slowly to hole
const CUP_PULL_R   = 32;    // gravity-pull radius
const VACUUM_RADIUS = Infinity; // vacuum suck ability range — dial in later
const FRICTION     = 0.988; // per-frame rolling friction
const FRICTION_SAND= 0.96;
const BOUNCE       = 0.62;  // wall restitution
const BASE_POWER   = 20;    // base max speed
const DRAG_SCALE   = 120;   // canvas px of drag = full power
const STOP_SPEED   = 0.06;
const SUBSTEPS     = 5;     // physics sub-steps per frame
const TOTAL_HOLES      = 9;
const TRAJ_DOTS        = 55;    // trajectory preview dots
const POWERUP_CHOICES  = 3;

// ============================================================
//  UTILITIES
// ============================================================
const rnd    = (a, b) => a + Math.random() * (b - a);
const rndInt = (a, b) => Math.floor(rnd(a, b + 1));
const lerp   = (a, b, t) => a + (b - a) * t;
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2  = (ax, ay, bx, by) => { const dx=ax-bx, dy=ay-by; return dx*dx+dy*dy; };
const dist   = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rndInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Closest point on segment (x1,y1)-(x2,y2) to point (px,py).
// Uses scalar projection: t = dot(p-a, b-a) / |b-a|², clamped to [0,1].
function closestOnSeg(px, py, x1, y1, x2, y2) {
  const dx = x2-x1, dy = y2-y1;
  const lenSq = dx*dx + dy*dy;
  if (lenSq < 1e-9) return { x: x1, y: y1, t: 0 };
  const t = clamp(((px-x1)*dx + (py-y1)*dy) / lenSq, 0, 1);
  return { x: x1 + t*dx, y: y1 + t*dy, t };
}

// ============================================================
//  LEVEL GENERATOR
// ============================================================
function generatePath(steps) {
  const path = [{ gx: 0, gy: 0 }];
  const visited = new Set(['0,0']);
  let cx = 0, cy = 0;
  const dirs = [{ dx:1,dy:0 },{ dx:-1,dy:0 },{ dx:0,dy:1 },{ dx:0,dy:-1 }];
  let lastDir = dirs[0];

  for (let i = 0; i < steps; i++) {
    let moved = false;
    // 65% chance to continue straight
    if (Math.random() < 0.65) {
      const nx = cx + lastDir.dx, ny = cy + lastDir.dy;
      if (!visited.has(`${nx},${ny}`)) {
        path.push({ gx: nx, gy: ny });
        visited.add(`${nx},${ny}`);
        cx = nx; cy = ny; moved = true;
      }
    }
    if (!moved) {
      for (const d of shuffle(dirs)) {
        const nx = cx + d.dx, ny = cy + d.dy;
        if (!visited.has(`${nx},${ny}`)) {
          path.push({ gx: nx, gy: ny });
          visited.add(`${nx},${ny}`);
          lastDir = d; cx = nx; cy = ny; moved = true;
          break;
        }
      }
    }
    if (!moved) break;
  }
  return path;
}

function generateLevel(holeNum) {
  const diff   = holeNum;
  const steps  = 3 + Math.floor(diff * 1.8);
  const rawPath = generatePath(steps);

  // Normalize so min gx/gy = 0
  const minGX = Math.min(...rawPath.map(p => p.gx));
  const minGY = Math.min(...rawPath.map(p => p.gy));
  const path  = rawPath.map(p => ({ gx: p.gx - minGX, gy: p.gy - minGY }));

  const cellSet = new Set(path.map(p => `${p.gx},${p.gy}`));

  // Cells with metadata
  const cells = path.map(p => ({
    x: p.gx * CELL, y: p.gy * CELL,
    w: CELL, h: CELL,
    hazard: null  // 'water' | 'sand' | null
  }));

  // Wall segments: for each cell, emit a segment on any side that has no neighbour.
  // This produces the full outer boundary of the course without duplicates.
  const walls = [];
  for (const p of path) {
    const wx = p.gx * CELL, wy = p.gy * CELL;
    if (!cellSet.has(`${p.gx-1},${p.gy}`)) walls.push({ x1:wx,      y1:wy,       x2:wx,      y2:wy+CELL }); // left edge
    if (!cellSet.has(`${p.gx+1},${p.gy}`)) walls.push({ x1:wx+CELL, y1:wy,       x2:wx+CELL, y2:wy+CELL }); // right edge
    if (!cellSet.has(`${p.gx},${p.gy-1}`)) walls.push({ x1:wx,      y1:wy,       x2:wx+CELL, y2:wy       }); // top edge
    if (!cellSet.has(`${p.gx},${p.gy+1}`)) walls.push({ x1:wx,      y1:wy+CELL,  x2:wx+CELL, y2:wy+CELL }); // bottom edge
  }

  const tee = { x: cells[0].x + CELL/2, y: cells[0].y + CELL/2 };
  const cup = { x: cells[cells.length-1].x + CELL/2, y: cells[cells.length-1].y + CELL/2 };

  // Obstacle generation
  const obstacles = [];
  const midCells  = cells.slice(1, -1);

  function midCellAt(frac) {
    if (!midCells.length) return null;
    return midCells[Math.min(Math.floor(frac * midCells.length), midCells.length - 1)];
  }

  // Stone blocks (diff 2+)
  if (diff >= 2 && midCells.length > 0) {
    const count = Math.min(Math.floor((diff-1)/2), midCells.length);
    for (let i = 0; i < count; i++) {
      const c = midCells[Math.floor(i * midCells.length / count)];
      const ow = 34 + rnd(0, 10), oh = 34 + rnd(0, 10);
      obstacles.push({
        type: 'rect', material: 'stone',
        x: c.x + CELL/2 - ow/2 + rnd(-15, 15),
        y: c.y + CELL/2 - oh/2 + rnd(-15, 15),
        w: ow, h: oh,
        destructible: false, alive: true
      });
    }
  }

  // Wooden log (diff 3+)
  if (diff >= 3 && midCells.length > 1) {
    const c = midCellAt(0.55);
    if (c) {
      const horiz = Math.random() > 0.5;
      const span  = CELL * rnd(0.45, 0.7);
      obstacles.push({
        type: 'rect', material: 'wood',
        x: horiz ? c.x + (CELL - span)/2 : c.x + CELL/2 - 11,
        y: horiz ? c.y + CELL/2 - 11     : c.y + (CELL - span)/2,
        w: horiz ? span : 22,
        h: horiz ? 22   : span,
        destructible: true, alive: true
      });
    }
  }

  // Bumpers (diff 4+)
  if (diff >= 4) {
    const numBumpers = Math.min(diff - 3, 4);
    for (let i = 0; i < numBumpers && midCells.length > 0; i++) {
      const c = midCells[Math.floor((i + 0.5) * midCells.length / numBumpers)];
      obstacles.push({
        type: 'circle', material: 'rubber',
        x: c.x + CELL/2 + rnd(-20, 20),
        y: c.y + CELL/2 + rnd(-20, 20),
        r: 16 + rnd(0, 6),
        destructible: false, alive: true
      });
    }
  }

  // Moving wall (diff 5+)
  if (diff >= 5 && midCells.length >= 2) {
    const c = midCellAt(0.4);
    if (c) {
      const horiz = Math.random() > 0.5;
      const wallLen = CELL * rnd(0.5, 0.75);
      obstacles.push({
        type: 'moving', material: 'metal',
        // position is top-left corner
        x: horiz ? c.x + (CELL - wallLen)/2 : c.x + CELL/2 - 7,
        y: horiz ? c.y + CELL/2 - 7         : c.y + (CELL - wallLen)/2,
        w: horiz ? wallLen : 14,
        h: horiz ? 14      : wallLen,
        // movement axis
        axis: horiz ? 'y' : 'x',
        minPos: horiz ? c.y + 18         : c.x + 18,
        maxPos: horiz ? c.y + CELL - 32  : c.x + CELL - 32,
        speed: 0.9 + diff * 0.12,
        dir: 1,
        destructible: false, alive: true
      });
    }
  }

  // Extra moving wall (diff 8+)
  if (diff >= 8 && midCells.length >= 3) {
    const c = midCellAt(0.7);
    if (c) {
      const horiz = Math.random() > 0.5;
      const wallLen = CELL * rnd(0.4, 0.65);
      obstacles.push({
        type: 'moving', material: 'metal',
        x: horiz ? c.x + (CELL - wallLen)/2 : c.x + CELL/2 - 7,
        y: horiz ? c.y + CELL/2 - 7         : c.y + (CELL - wallLen)/2,
        w: horiz ? wallLen : 14,
        h: horiz ? 14      : wallLen,
        axis: horiz ? 'y' : 'x',
        minPos: horiz ? c.y + 18        : c.x + 18,
        maxPos: horiz ? c.y + CELL - 32 : c.x + CELL - 32,
        speed: 1.3 + diff * 0.15,
        dir: -1,
        destructible: false, alive: true
      });
    }
  }

  // Water hazard (diff 6+) — always includes a traversable bridge ramp
  if (diff >= 6 && midCells.length >= 2) {
    const wIdx = Math.min(Math.floor(midCells.length * 0.5), midCells.length - 1);
    if (wIdx >= 0) {
      const waterCell = midCells[wIdx];
      waterCell.hazard = 'water';
      // Determine ramp axis from path direction through this cell
      const pathIdx = wIdx + 1; // midCells[i] = cells[i+1] = path[i+1]
      const prevP = path[pathIdx - 1], nextP = path[pathIdx + 1];
      const adx = Math.abs(nextP.gx - prevP.gx), ady = Math.abs(nextP.gy - prevP.gy);
      waterCell.rampAxis  = (adx >= ady) ? 'x' : 'y';
      waterCell.rampHalfW = CELL * 0.28; // half-width of the safe bridge strip
    }
  }

  // Sand (diff 7+)
  if (diff >= 7 && midCells.length >= 3) {
    if (cells.length > 1) cells[1].hazard = 'sand';
  }

  // Bounding box
  const maxGX = Math.max(...path.map(p => p.gx));
  const maxGY = Math.max(...path.map(p => p.gy));
  const bounds = { x: 0, y: 0, w: (maxGX+1)*CELL, h: (maxGY+1)*CELL };

  const par = 2 + Math.ceil(path.length / 3);

  return { cells, walls, obstacles, tee, cup, par, bounds, holeNum };
}

// ============================================================
//  PARTICLES
// ============================================================
class ParticleSystem {
  constructor() { this.particles = []; }

  emit(x, y, options = {}) {
    const count = options.count || 1;
    for (let i = 0; i < count; i++) {
      const angle = (options.angle || 0) + rnd(-Math.PI, Math.PI) * (options.spread || 1);
      const spd   = rnd(options.minSpd || 0.5, options.maxSpd || 2.5);
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        life: 1,
        decay: rnd(options.minDecay || 0.025, options.maxDecay || 0.06),
        size: rnd(options.minSize || 2, options.maxSize || 5),
        color: options.color || '#fff',
        color2: options.color2 || null,
        gravity: options.grav || 0,
        shrink: options.shrink !== false
      });
    }
  }

  update() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx; p.y += p.vy;
      p.vy += p.gravity;
      p.vx *= 0.96; p.vy *= 0.96;
      p.life -= p.decay;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }

  draw(ctx, camera, canvas) {
    for (const p of this.particles) {
      const s = camera.toScreen(p.x, p.y, canvas);
      const sz = (p.shrink ? p.life : 1) * p.size * camera.zoom;
      ctx.save();
      ctx.globalAlpha = clamp(p.life, 0, 1);
      if (p.color2) {
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, sz);
        g.addColorStop(0, p.color);
        g.addColorStop(1, p.color2);
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = p.color;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, sz, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
  }
}

// ============================================================
//  CAMERA
// ============================================================
class Camera {
  constructor() {
    this.x = 0; this.y = 0; this.zoom = 1;
    this.tx = 0; this.ty = 0; this.tz = 1;
  }

  setTarget(x, y, zoom) { this.tx = x; this.ty = y; this.tz = zoom; }

  snapTo(x, y, zoom) {
    this.x = this.tx = x;
    this.y = this.ty = y;
    this.zoom = this.tz = zoom;
  }

  update() {
    this.x    = lerp(this.x,    this.tx, 0.07);
    this.y    = lerp(this.y,    this.ty, 0.07);
    this.zoom = lerp(this.zoom, this.tz, 0.05);
  }

  // World → screen: shift by camera position, scale by zoom, re-center on canvas.
  toScreen(wx, wy, canvas) {
    return {
      x: (wx - this.x) * this.zoom + canvas.width  / 2,
      y: (wy - this.y) * this.zoom + canvas.height / 2
    };
  }

  // Screen → world: exact inverse of toScreen.
  toWorld(sx, sy, canvas) {
    return {
      x: (sx - canvas.width  / 2) / this.zoom + this.x,
      y: (sy - canvas.height / 2) / this.zoom + this.y
    };
  }

  // ctx transform equivalent — NOT used in render() because all draw methods call
  // toScreen() themselves. Using both simultaneously would double-transform everything.
  apply(ctx, canvas) {
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  zoomForBounds(bounds, canvas, padding = 80) {
    const zx = canvas.width  / (bounds.w + padding * 2);
    const zy = canvas.height / (bounds.h + padding * 2);
    return Math.min(zx, zy, 2.2);
  }
}

// ============================================================
//  COLLISION HELPERS
// ============================================================
function resolveWall(ball, wall) {
  const cp = closestOnSeg(ball.x, ball.y, wall.x1, wall.y1, wall.x2, wall.y2);
  const dx = ball.x - cp.x, dy = ball.y - cp.y;
  const d  = Math.sqrt(dx*dx + dy*dy);
  if (d < BALL_R && d > 1e-6) {
    const nx = dx/d, ny = dy/d;
    ball.x = cp.x + nx * BALL_R;
    ball.y = cp.y + ny * BALL_R;
    const dot = ball.vx*nx + ball.vy*ny;
    if (dot < 0) {
      ball.vx -= (1 + BOUNCE) * dot * nx;
      ball.vy -= (1 + BOUNCE) * dot * ny;
    }
    return true;
  }
  return false;
}

function resolveCircle(ball, obs) {
  if (!obs.alive) return false;
  const dx = ball.x - obs.x, dy = ball.y - obs.y;
  const d  = Math.sqrt(dx*dx + dy*dy);
  const minD = BALL_R + obs.r;
  if (d < minD && d > 1e-6) {
    const nx = dx/d, ny = dy/d;
    ball.x = obs.x + nx * minD;
    ball.y = obs.y + ny * minD;
    const dot = ball.vx*nx + ball.vy*ny;
    if (dot < 0) {
      // Pinball-style: active launch with high restitution
      ball.vx -= (1 + 1.6) * dot * nx;
      ball.vy -= (1 + 1.6) * dot * ny;
    }
    // Minimum outward velocity kick
    const spd = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy);
    if (spd < 5) {
      const boost = 5 / spd;
      ball.vx *= boost; ball.vy *= boost;
    }
    return true;
  }
  return false;
}

function resolveRect(ball, obs) {
  if (!obs.alive) return false;
  const { x, y, w, h } = obs;
  // Find closest point on rect to ball
  const cx = clamp(ball.x, x, x+w);
  const cy = clamp(ball.y, y, y+h);
  const dx = ball.x - cx, dy = ball.y - cy;
  const d  = Math.sqrt(dx*dx + dy*dy);
  if (d < BALL_R && d > 1e-6) {
    const nx = dx/d, ny = dy/d;
    ball.x = cx + nx * BALL_R;
    ball.y = cy + ny * BALL_R;
    const dot = ball.vx*nx + ball.vy*ny;
    if (dot < 0) {
      ball.vx -= (1 + BOUNCE) * dot * nx;
      ball.vy -= (1 + BOUNCE) * dot * ny;
    }
    return true;
  } else if (d === 0) {
    // Ball center is inside rect (tunnelled in) — push out along shortest overlap axis
    const overlapLeft  = ball.x - x;
    const overlapRight = (x+w) - ball.x;
    const overlapTop   = ball.y - y;
    const overlapBottom= (y+h) - ball.y;
    const minO = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom);
    if (minO === overlapLeft)   { ball.x = x - BALL_R;   ball.vx = Math.abs(ball.vx) * BOUNCE; }
    else if (minO === overlapRight)  { ball.x = x+w + BALL_R; ball.vx = -Math.abs(ball.vx) * BOUNCE; }
    else if (minO === overlapTop)    { ball.y = y - BALL_R;   ball.vy = Math.abs(ball.vy) * BOUNCE; }
    else                             { ball.y = y+h + BALL_R; ball.vy = -Math.abs(ball.vy) * BOUNCE; }
    return true;
  }
  return false;
}

// Check if point is inside a cell (with margin for ball radius)
function inCell(x, y, cell, margin = 0) {
  return x >= cell.x - margin && x <= cell.x + cell.w + margin &&
         y >= cell.y - margin && y <= cell.y + cell.h + margin;
}

function onCourse(x, y, cells) {
  return cells.some(c => inCell(x, y, c, BALL_R * 0.5));
}

function getCellAt(x, y, cells) {
  return cells.find(c => inCell(x, y, c, 2)) || null;
}

// ============================================================
//  POWERUP DEFINITIONS
// ============================================================
// 'power' is passive/permanent (always active, no key binding).
// All others are consumable — activated per-shot via keys 1/2/3.
const POWERUP_DEFS = {
  power: {
    id: 'power', name: 'Goblin Rage',
    icon: '⚡', cssClass: 'power',
    desc: 'Goblin gets FURIOUS — permanently smacks 30% harder.',
    persistent: true,
    key: '1'
  },
  fire: {
    id: 'fire', name: 'Lava Stick',
    icon: '🔥', cssClass: 'fire',
    desc: 'Goblin found a burning branch! Destroys wooden obstacles on contact.',
    persistent: false, uses: 2,
    key: '1'
  },
  laser: {
    id: 'laser', name: 'Magic Eye Orb',
    icon: '💥', cssClass: 'laser',
    desc: 'Stolen from a wizard! Ball passes through all obstacles.',
    persistent: false, uses: 2,
    key: '2'
  },
  ice: {
    id: 'ice', name: 'Freeze Slime',
    icon: '❄️', cssClass: 'ice',
    desc: 'Goblin goo freezes all moving traps for 5 seconds.',
    persistent: false, uses: 2,
    key: '3'
  },
  ghost: {
    id: 'ghost', name: 'Spook Shroom',
    icon: '👻', cssClass: 'ghost',
    desc: 'Magic mushroom makes ball phase through everything!',
    persistent: false, uses: 2,
    key: '2'
  },
  blackhole: {
    id: 'blackhole', name: 'Black Hole',
    icon: '🕳️', cssClass: 'blackhole',
    desc: "Rip open a void — swallows the ball instantly. That stroke doesn't count.",
    persistent: false, uses: 1,
    key: '4'
  },
  vacuum: {
    id: 'vacuum', name: 'Vacuum Suck',
    icon: '🌀', cssClass: 'vacuum',
    desc: 'Goblin cranks up the void sucker — ball gets yanked straight into the hole!',
    persistent: false, uses: 1,
    key: '5'
  }
};

const POWERUP_POOL = ['power', 'fire', 'laser', 'ice', 'ghost', 'blackhole', 'vacuum'];

// ============================================================
//  RENDERER
// ============================================================
class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.camera = camera;
    this.waterAnim = 0;
  }

  clear() {
    const ctx = this.ctx;
    ctx.fillStyle = '#0f2010';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // Draw the rough (background pattern)
  drawRough() {
    // Already cleared with dark green
  }

  drawCells(cells) {
    const ctx = this.ctx;
    this.waterAnim += 0.02;
    for (const cell of cells) {
      const s = this.camera.toScreen(cell.x, cell.y, this.canvas);
      const sz = CELL * this.camera.zoom;

      if (cell.hazard === 'water') {
        // Animated water
        const g = ctx.createLinearGradient(s.x, s.y, s.x + sz, s.y + sz);
        const wave = (Math.sin(this.waterAnim) + 1) * 0.5;
        g.addColorStop(0,   `rgba(20,80,180,${0.85 + wave * 0.1})`);
        g.addColorStop(0.5, `rgba(30,110,220,${0.75 + wave * 0.1})`);
        g.addColorStop(1,   `rgba(15,60,150,${0.9})`);
        ctx.fillStyle = g;
        ctx.fillRect(s.x, s.y, sz, sz);
        // Ripple lines
        ctx.strokeStyle = `rgba(100,180,255,${0.25 + wave * 0.15})`;
        ctx.lineWidth = 1.5 * this.camera.zoom;
        for (let i = 1; i < 4; i++) {
          const phase = (this.waterAnim * 0.7 + i * 0.8) % 1;
          const rx = s.x + sz * 0.15, ry = s.y + sz * (0.2 + i * 0.2) + Math.sin(this.waterAnim + i) * 4 * this.camera.zoom;
          ctx.beginPath();
          ctx.moveTo(rx, ry);
          ctx.bezierCurveTo(rx + sz*0.2, ry - 4*this.camera.zoom, rx + sz*0.5, ry + 4*this.camera.zoom, rx + sz*0.7, ry);
          ctx.stroke();
        }

        // Draw wooden bridge ramp over water
        if (cell.rampAxis) {
          const rhw = (cell.rampHalfW || CELL * 0.28) * this.camera.zoom;
          const cx2 = s.x + sz * 0.5, cy2 = s.y + sz * 0.5;
          ctx.save();
          if (cell.rampAxis === 'x') {
            // Horizontal bridge: spans full cell width, narrow in Y
            const by0 = cy2 - rhw, bh = rhw * 2;
            // Bridge deck
            ctx.fillStyle = '#7a5412';
            ctx.fillRect(s.x, by0, sz, bh);
            // Plank lines
            ctx.strokeStyle = 'rgba(50,28,5,0.6)';
            ctx.lineWidth = 2 * this.camera.zoom;
            const nPlanks = 9;
            for (let p = 1; p < nPlanks; p++) {
              const px = s.x + (p / nPlanks) * sz;
              ctx.beginPath(); ctx.moveTo(px, by0); ctx.lineTo(px, by0 + bh); ctx.stroke();
            }
            // Edge rails
            ctx.strokeStyle = '#4a2d06';
            ctx.lineWidth = 3 * this.camera.zoom;
            ctx.beginPath(); ctx.moveTo(s.x, by0); ctx.lineTo(s.x + sz, by0); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(s.x, by0 + bh); ctx.lineTo(s.x + sz, by0 + bh); ctx.stroke();
            // Rail posts
            ctx.strokeStyle = '#3d2305';
            ctx.lineWidth = 2.5 * this.camera.zoom;
            for (let p = 0; p <= 3; p++) {
              const px = s.x + (p / 3) * sz;
              ctx.beginPath(); ctx.moveTo(px, by0 - 4 * this.camera.zoom); ctx.lineTo(px, by0 + bh + 4 * this.camera.zoom); ctx.stroke();
            }
          } else {
            // Vertical bridge: spans full cell height, narrow in X
            const bx0 = cx2 - rhw, bw = rhw * 2;
            ctx.fillStyle = '#7a5412';
            ctx.fillRect(bx0, s.y, bw, sz);
            ctx.strokeStyle = 'rgba(50,28,5,0.6)';
            ctx.lineWidth = 2 * this.camera.zoom;
            const nPlanks = 9;
            for (let p = 1; p < nPlanks; p++) {
              const py = s.y + (p / nPlanks) * sz;
              ctx.beginPath(); ctx.moveTo(bx0, py); ctx.lineTo(bx0 + bw, py); ctx.stroke();
            }
            ctx.strokeStyle = '#4a2d06';
            ctx.lineWidth = 3 * this.camera.zoom;
            ctx.beginPath(); ctx.moveTo(bx0, s.y); ctx.lineTo(bx0, s.y + sz); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx0 + bw, s.y); ctx.lineTo(bx0 + bw, s.y + sz); ctx.stroke();
            ctx.strokeStyle = '#3d2305';
            ctx.lineWidth = 2.5 * this.camera.zoom;
            for (let p = 0; p <= 3; p++) {
              const py = s.y + (p / 3) * sz;
              ctx.beginPath(); ctx.moveTo(bx0 - 4 * this.camera.zoom, py); ctx.lineTo(bx0 + bw + 4 * this.camera.zoom, py); ctx.stroke();
            }
          }
          ctx.restore();
        }

        // Frozen water overlay (Freeze Slime powerup)
        if (cell.frozenWater) {
          ctx.fillStyle = 'rgba(180,230,255,0.55)';
          ctx.fillRect(s.x, s.y, sz, sz);
          // Ice crack lines
          ctx.strokeStyle = 'rgba(200,240,255,0.7)';
          ctx.lineWidth = 1.2 * this.camera.zoom;
          for (let ic = 0; ic < 5; ic++) {
            const seed = cell.x * 13 + cell.y * 7 + ic * 31;
            const ix1 = s.x + ((seed * 17 % 100) / 100) * sz;
            const iy1 = s.y + ((seed * 23 % 100) / 100) * sz;
            const ix2 = s.x + (((seed * 41) % 100) / 100) * sz;
            const iy2 = s.y + (((seed * 53) % 100) / 100) * sz;
            ctx.beginPath(); ctx.moveTo(ix1, iy1); ctx.lineTo(ix2, iy2); ctx.stroke();
          }
        }
      } else if (cell.hazard === 'sand') {
        ctx.fillStyle = '#c8a240';
        ctx.fillRect(s.x, s.y, sz, sz);
        // Sand texture dots
        ctx.fillStyle = 'rgba(180,140,60,0.4)';
        for (let di = 0; di < 20; di++) {
          // Deterministic dots based on cell position
          const dx = ((cell.x * 7 + di * 31) % 100) / 100;
          const dy = ((cell.y * 13 + di * 17) % 100) / 100;
          ctx.beginPath();
          ctx.arc(s.x + dx*sz, s.y + dy*sz, 2 * this.camera.zoom, 0, Math.PI*2);
          ctx.fill();
        }
      } else {
        // Fairway - slight gradient
        const g = ctx.createLinearGradient(s.x, s.y, s.x+sz, s.y+sz);
        g.addColorStop(0, '#2e7d32');
        g.addColorStop(1, '#388e3c');
        ctx.fillStyle = g;
        ctx.fillRect(s.x, s.y, sz, sz);
        // Subtle mow lines
        ctx.strokeStyle = 'rgba(0,0,0,0.06)';
        ctx.lineWidth = 1;
        for (let k = 0; k < 5; k++) {
          const lx = s.x + (k / 5) * sz;
          ctx.beginPath();
          ctx.moveTo(lx, s.y);
          ctx.lineTo(lx, s.y + sz);
          ctx.stroke();
        }
        // Goblin footprints (deterministic per cell)
        ctx.fillStyle = 'rgba(20,60,15,0.22)';
        const fpSeed = (cell.x * 1301 + cell.y * 7919);
        for (let fp = 0; fp < 4; fp++) {
          const fx = s.x + (((fpSeed * (fp * 3 + 1) * 6271) % 1000) / 1000) * sz * 0.8 + sz * 0.1;
          const fy = s.y + (((fpSeed * (fp * 5 + 2) * 4649) % 1000) / 1000) * sz * 0.8 + sz * 0.1;
          const angle = ((fpSeed * (fp + 7) * 3571) % 628) / 100;
          const footW = 4 * this.camera.zoom, footH = 6 * this.camera.zoom;
          // Left footprint
          ctx.save();
          ctx.translate(fx, fy);
          ctx.rotate(angle);
          ctx.beginPath();
          ctx.ellipse(-footW * 1.1, 0, footW, footH, 0, 0, Math.PI * 2);
          ctx.fill();
          // Right footprint (offset)
          ctx.beginPath();
          ctx.ellipse(footW * 1.1, footH * 1.4, footW, footH, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }

  drawWalls(walls) {
    const ctx = this.ctx;
    ctx.strokeStyle = '#1a2a1a';
    ctx.lineWidth = 8 * this.camera.zoom;
    ctx.lineCap = 'round';
    for (const w of walls) {
      const a = this.camera.toScreen(w.x1, w.y1, this.canvas);
      const b = this.camera.toScreen(w.x2, w.y2, this.canvas);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // Lighter inner border
    ctx.strokeStyle = 'rgba(50,80,50,0.4)';
    ctx.lineWidth = 3 * this.camera.zoom;
    for (const w of walls) {
      const a = this.camera.toScreen(w.x1, w.y1, this.canvas);
      const b = this.camera.toScreen(w.x2, w.y2, this.canvas);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  drawObstacles(obstacles) {
    const ctx = this.ctx;
    for (const obs of obstacles) {
      if (!obs.alive) continue;
      if (obs.type === 'circle') {
        const s = this.camera.toScreen(obs.x, obs.y, this.canvas);
        const r = obs.r * this.camera.zoom;
        const g = ctx.createRadialGradient(s.x - r*0.3, s.y - r*0.3, r*0.1, s.x, s.y, r);
        g.addColorStop(0, '#d0d8ff');
        g.addColorStop(0.6, '#8090e0');
        g.addColorStop(1, '#3040a0');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.fill();
        ctx.strokeStyle = '#ffffff44';
        ctx.lineWidth = 2 * this.camera.zoom;
        ctx.stroke();
        // Shine
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath(); ctx.arc(s.x - r*0.25, s.y - r*0.25, r*0.28, 0, Math.PI*2); ctx.fill();
      } else if (obs.type === 'rect' || obs.type === 'moving') {
        const s  = this.camera.toScreen(obs.x, obs.y, this.canvas);
        const sw = obs.w * this.camera.zoom, sh = obs.h * this.camera.zoom;
        if (obs.material === 'wood') {
          ctx.fillStyle = '#8b5a2b';
          ctx.fillRect(s.x, s.y, sw, sh);
          // Wood grain
          ctx.strokeStyle = '#6b3a1b';
          ctx.lineWidth = 1.5 * this.camera.zoom;
          const grainCount = Math.max(2, Math.floor(obs.h / 12));
          for (let g = 0; g < grainCount; g++) {
            const gy = s.y + (g / grainCount) * sh;
            ctx.beginPath(); ctx.moveTo(s.x, gy); ctx.lineTo(s.x+sw, gy); ctx.stroke();
          }
          ctx.strokeStyle = 'rgba(200,150,80,0.3)';
          ctx.lineWidth = 1;
          ctx.strokeRect(s.x, s.y, sw, sh);
        } else if (obs.material === 'stone') {
          ctx.fillStyle = '#5a5a5a';
          ctx.fillRect(s.x, s.y, sw, sh);
          ctx.fillStyle = 'rgba(255,255,255,0.1)';
          ctx.fillRect(s.x, s.y, sw, sh * 0.35);
          ctx.fillStyle = 'rgba(0,0,0,0.2)';
          ctx.fillRect(s.x, s.y + sh * 0.65, sw, sh * 0.35);
          // Mossy green overlay
          ctx.fillStyle = 'rgba(0,80,0,0.15)';
          ctx.fillRect(s.x, s.y, sw, sh);
          ctx.strokeStyle = '#333';
          ctx.lineWidth = 2 * this.camera.zoom;
          ctx.strokeRect(s.x, s.y, sw, sh);
        } else { // metal
          const mg = ctx.createLinearGradient(s.x, s.y, s.x, s.y+sh);
          mg.addColorStop(0, '#bbb');
          mg.addColorStop(0.5, '#888');
          mg.addColorStop(1, '#aaa');
          ctx.fillStyle = mg;
          ctx.fillRect(s.x, s.y, sw, sh);
          ctx.strokeStyle = '#555';
          ctx.lineWidth = 2 * this.camera.zoom;
          ctx.strokeRect(s.x, s.y, sw, sh);
          // Rivets
          const rv = 3 * this.camera.zoom;
          for (const [rx, ry] of [[s.x+rv+2, s.y+rv+2],[s.x+sw-rv-2,s.y+rv+2],[s.x+rv+2,s.y+sh-rv-2],[s.x+sw-rv-2,s.y+sh-rv-2]]) {
            ctx.fillStyle = '#555';
            ctx.beginPath(); ctx.arc(rx, ry, rv, 0, Math.PI*2); ctx.fill();
          }
        }
      }
    }
  }

  drawCup(cup, sinkAnim = 0) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(cup.x, cup.y, this.canvas);
    const r = CUP_R * this.camera.zoom;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(s.x + 3, s.y + 4, r*1.1, r*0.5, 0, 0, Math.PI*2); ctx.fill();

    // Hole
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.fill();

    // Flag pole
    const poleTop = { x: s.x + r*0.3, y: s.y - r * 3 * (1 - sinkAnim) };
    ctx.strokeStyle = '#ccc';
    ctx.lineWidth = 2 * this.camera.zoom;
    ctx.beginPath(); ctx.moveTo(s.x + r*0.3, s.y); ctx.lineTo(poleTop.x, poleTop.y); ctx.stroke();

    // Flag
    ctx.fillStyle = '#ff3333';
    ctx.beginPath();
    ctx.moveTo(poleTop.x, poleTop.y);
    ctx.lineTo(poleTop.x + r * 1.5, poleTop.y + r * 0.5);
    ctx.lineTo(poleTop.x, poleTop.y + r);
    ctx.fill();

    // Rim
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2 * this.camera.zoom;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.stroke();
  }

  drawTee(tee) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(tee.x, tee.y, this.canvas);
    const r = 16 * this.camera.zoom;
    // Dashed circle marker
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2 * this.camera.zoom;
    ctx.setLineDash([4 * this.camera.zoom, 4 * this.camera.zoom]);
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
    // Goblin face
    const fr = r * 0.82;
    // Green face circle
    ctx.fillStyle = '#4a9a30';
    ctx.beginPath(); ctx.arc(s.x, s.y, fr, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#2a6a15';
    ctx.lineWidth = 1.2 * this.camera.zoom;
    ctx.stroke();
    // Eyes
    const eyeR = fr * 0.18;
    const eyeOff = fr * 0.3;
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(s.x - eyeOff, s.y - fr * 0.1, eyeR, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(s.x + eyeOff, s.y - fr * 0.1, eyeR, 0, Math.PI*2); ctx.fill();
    // Toothy grin
    ctx.strokeStyle = '#1a5010';
    ctx.lineWidth = 1.5 * this.camera.zoom;
    ctx.beginPath();
    ctx.arc(s.x, s.y + fr * 0.1, fr * 0.45, 0.2, Math.PI - 0.2);
    ctx.stroke();
    // Teeth
    ctx.fillStyle = '#eeeedd';
    const tw = fr * 0.18;
    const ty = s.y + fr * 0.25;
    ctx.fillRect(s.x - tw * 1.1, ty - fr * 0.18, tw, fr * 0.2);
    ctx.fillRect(s.x + tw * 0.1, ty - fr * 0.18, tw, fr * 0.2);
  }

  drawGoblinAtTee(tee, cup, img) {
    if (!img || !img.complete || img.naturalWidth === 0) return;
    const ctx = this.ctx;
    const s   = this.camera.toScreen(tee.x, tee.y, this.canvas);
    const zoom = this.camera.zoom;
    const h = 72 * zoom;
    const w = h * (img.naturalWidth / img.naturalHeight);

    // In the source image the goblin faces LEFT.
    // Front foot (left foot) ≈ 15% from left edge.
    // Back foot  (right foot) ≈ 72% from left edge.
    const frontFrac = 0.15; // fraction from left when facing left
    const backFrac  = 0.72; // fraction from left when facing left

    // feet sit at ~95% down the image
    const dy = -h * 0.95;

    // Flip horizontally when the cup is to the right of the tee so goblin faces the hole
    const facingRight = cup.x > tee.x;

    ctx.save();
    ctx.shadowColor    = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur     = 8 * zoom;
    ctx.shadowOffsetX  = 2 * zoom;
    ctx.shadowOffsetY  = 3 * zoom;

    if (facingRight) {
      // Flip: translate pivot to tee screen pos, scale(-1,1), then draw.
      // After scale(-1,1) a pixel at fraction f from image-left maps to
      // screen_x = s.x - (lx + f*w).  To anchor the back foot (which becomes
      // the front foot after flip) at s.x: lx = -backFrac * w.
      ctx.translate(s.x, s.y + dy);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -backFrac * w, 0, w, h);
    } else {
      // Natural orientation: anchor front (left) foot at s.x.
      ctx.drawImage(img, s.x - frontFrac * w, s.y + dy, w, h);
    }

    ctx.restore();
  }

  drawBall(ball, powerups = {}) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(ball.x, ball.y, this.canvas);
    const r = BALL_R * this.camera.zoom;

    const isOnFire   = powerups.fire   && powerups.fire.active;
    const isLaser    = powerups.laser  && powerups.laser.active;
    const isGhost    = powerups.ghost  && powerups.ghost.active;

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(s.x + 2, s.y + 3, r*0.9, r*0.4, 0, 0, Math.PI*2); ctx.fill();

    // Glow for active powerups
    if (isOnFire) {
      ctx.shadowColor = '#ff6b00';
      ctx.shadowBlur  = 18 * this.camera.zoom;
    } else if (isLaser) {
      ctx.shadowColor = '#00cfff';
      ctx.shadowBlur  = 18 * this.camera.zoom;
    } else if (isGhost) {
      ctx.shadowColor = '#cc99ff';
      ctx.shadowBlur  = 14 * this.camera.zoom;
    }

    // Ball body
    const alpha = isGhost ? 0.55 : 1;
    ctx.globalAlpha = alpha;
    const g = ctx.createRadialGradient(s.x - r*0.3, s.y - r*0.35, r*0.05, s.x, s.y, r);
    if (isOnFire) {
      g.addColorStop(0, '#ffffa0'); g.addColorStop(0.5, '#ff8800'); g.addColorStop(1, '#cc3300');
    } else if (isLaser) {
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#88eeff'); g.addColorStop(1, '#0088cc');
    } else {
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.6, '#e8e8e8'); g.addColorStop(1, '#aaaaaa');
    }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.fill();

    // Shine
    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(s.x - r*0.28, s.y - r*0.28, r*0.28, 0, Math.PI*2); ctx.fill();

    ctx.globalAlpha = 1;
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  }

  drawAimLine(ball, mouseWorld, maxPower) {
    const ctx = this.ctx;
    if (!mouseWorld) return;

    const dx = ball.x - mouseWorld.x, dy = ball.y - mouseWorld.y;
    const d  = Math.sqrt(dx*dx + dy*dy);
    if (d < 2) return;

    const nx = dx/d, ny = dy/d;
    const power = clamp(d / (DRAG_SCALE / this.camera.zoom), 0, 1);

    // Trajectory dots
    let bx = ball.x, by = ball.y;
    let vx = nx * power * maxPower, vy = ny * power * maxPower;
    ctx.save();
    for (let i = 0; i < TRAJ_DOTS; i++) {
      vx *= FRICTION; vy *= FRICTION;
      bx += vx; by += vy;
      if (i % 3 === 0) {
        const sc = this.camera.toScreen(bx, by, this.canvas);
        const fade = 1 - i / TRAJ_DOTS;
        const r = clamp(power * 2, 0, 1), g2 = 1 - r;
        ctx.fillStyle = `rgba(${Math.floor(r*255)},${Math.floor(g2*220)},50,${fade * 0.75})`;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, (3 - i/TRAJ_DOTS * 2) * this.camera.zoom, 0, Math.PI*2);
        ctx.fill();
      }
      if (Math.sqrt(vx*vx + vy*vy) < STOP_SPEED) break;
    }
    ctx.restore();

    // Aim line from ball
    const endX = ball.x + nx * 60, endY = ball.y + ny * 60;
    const bsS  = this.camera.toScreen(ball.x, ball.y, this.canvas);
    const endS = this.camera.toScreen(endX, endY, this.canvas);

    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,0.5)`;
    ctx.lineWidth = 2 * this.camera.zoom;
    ctx.setLineDash([5 * this.camera.zoom, 5 * this.camera.zoom]);
    ctx.beginPath(); ctx.moveTo(bsS.x, bsS.y); ctx.lineTo(endS.x, endS.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Power bar (screen space)
    const barW = 180, barH = 10, barX = this.canvas.width/2 - barW/2, barY = this.canvas.height - 60;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(barX-2, barY-2, barW+4, barH+4);
    const gr = ctx.createLinearGradient(barX, 0, barX+barW, 0);
    gr.addColorStop(0, '#4eff91'); gr.addColorStop(0.6, '#ffe066'); gr.addColorStop(1, '#ff4444');
    ctx.fillStyle = gr;
    ctx.fillRect(barX, barY, barW * power, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
    ctx.fillStyle = '#fff';
    ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText('POWER', this.canvas.width/2, barY - 4);
  }

  drawSplash(x, y, progress) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(x, y, this.canvas);
    const r = 30 * progress * this.camera.zoom;
    ctx.strokeStyle = `rgba(100,180,255,${1-progress})`;
    ctx.lineWidth = 3 * (1-progress) * this.camera.zoom;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI*2); ctx.stroke();
    const r2 = r * 0.5;
    ctx.beginPath(); ctx.arc(s.x, s.y, r2, 0, Math.PI*2); ctx.stroke();
  }

  drawBlackHoleVortex(wx, wy, t) {
    const ctx = this.ctx;
    const s = this.camera.toScreen(wx, wy, this.canvas);
    const zoom = this.camera.zoom;
    const maxR = 36 * zoom;
    const r = maxR * (1 - t * 0.5);

    // Dark radial gradient — the void
    const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
    g.addColorStop(0,   'rgba(0,0,0,0.98)');
    g.addColorStop(0.35,'rgba(60,0,120,0.80)');
    g.addColorStop(0.65,'rgba(120,0,200,0.40)');
    g.addColorStop(1,   'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();

    // Pulsing event-horizon ring
    const pulse = 0.7 + Math.sin(t * Math.PI * 6) * 0.15;
    ctx.save();
    ctx.globalAlpha = pulse * (0.5 + t * 0.5);
    ctx.strokeStyle = '#bb44ff';
    ctx.lineWidth = 2.5 * zoom;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ============================================================
//  MUSIC SYSTEM
// ============================================================
class MusicSystem {
  constructor() {
    this.tracks = {
      day:   new Audio('Goblin Back-Nine Bash Day.mp3'),
      night: new Audio('Goblin Back-Nine Bash Night.mp3')
    };
    this.current = 'day';
    this.playing = false;
    for (const t of Object.values(this.tracks)) {
      t.loop   = true;
      t.volume = 0.55;
    }
    this._updateUI();
  }

  play() {
    this.tracks[this.current].play().catch(() => {});
    this.playing = true;
    this._updateUI();
  }

  pause() {
    this.tracks[this.current].pause();
    this.playing = false;
    this._updateUI();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  cycleTrack() {
    const wasPlaying = this.playing;
    const prev = this.tracks[this.current];
    const pos  = prev.currentTime;
    prev.pause();
    this.current = this.current === 'day' ? 'night' : 'day';
    const next = this.tracks[this.current];
    next.currentTime = pos % next.duration || 0;
    if (wasPlaying) next.play().catch(() => {});
    this._updateUI();
  }

  setVolume(v) {
    for (const t of Object.values(this.tracks)) t.volume = v;
  }

  _updateUI() {
    const ppBtn  = document.getElementById('music-pp');
    const trBtn  = document.getElementById('music-track');
    if (ppBtn)  ppBtn.textContent  = this.playing ? '⏸' : '▶';
    if (trBtn)  trBtn.textContent  = this.current === 'day' ? '🌅 Day' : '🌙 Night';
  }
}

// ============================================================
//  MAIN GAME CLASS
// ============================================================
class Game {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.ctx    = this.canvas.getContext('2d');
    this.camera = new Camera();
    this.renderer = new Renderer(this.canvas, this.camera);
    this.particles = new ParticleSystem();

    this.state = 'title'; // title | overview | playing | rolling | hole_complete | powerup | gameover
    this.holeNum   = 1;
    this.totalScore = 0; // total over/under par
    this.scorecard  = [];

    this.level    = null;
    this.ball     = null;
    this.strokes  = 0;
    this.sinkAnim = 0;

    // Input
    this.mouse     = { x: 0, y: 0, down: false };
    this.dragStart = null; // world coords where drag started
    this.dragging  = false;

    // Powerups inventory: { id -> { def, uses } }
    this.powerupInventory = {};
    // Currently active powerup effect for this shot
    this.activeEffect = null; // 'fire' | 'laser' | 'ghost' | null
    // Frozen (ice) timer
    this.frozenTimer = 0;
    // Black hole animation state
    this.blackHoleAnim = 0;
    this.blackHoleCX = 0;
    this.blackHoleCY = 0;
    // Power multiplier
    this.powerMult = 1;

    // Hazard state
    this.lastSafePos  = null;
    this.inHazard     = false;
    this.hazardTimer  = 0;
    this.splashAnim   = 0; // 0-1
    this.splashPos    = null;
    this.outOfBounds  = false;
    this.rampElevation = 0; // 0-1 visual rise effect when crossing bridge

    // Camera overview anim
    this.overviewTimer = 0;
    this.bannerTimer   = 0;

    // Fanfare
    this.fanfare = null;

    // Middle-mouse pan
    this.panDrag  = false;
    this.panLastX = 0;
    this.panLastY = 0;
    this.cameraPanOverride = false;
    // Minimap pan
    this._mm = null;
    this.minimapPanDrag = false;

    // Level builder
    this.builderData  = null;
    this.builderLevel = null;
    this.builderTool  = 'draw';
    this.builderHover = null;
    this.builderPainting = false;
    this.isPlayTest   = false;

    this.music = new MusicSystem();

    // ---- Ads ----
    this._adIdx = 0;        // cycles through goblin ads
    this._adBannerIdx = 0;  // separate cycle for banner
    this._adsEl = {
      banner:      document.getElementById('ad-banner'),
      bannerIcon:  document.getElementById('ad-banner-icon'),
      bannerHead:  document.getElementById('ad-banner-headline'),
      bannerTag:   document.getElementById('ad-banner-tagline'),
      bannerCta:   document.getElementById('ad-banner-cta'),
      intEl:       document.getElementById('ad-interstitial'),
      intIcon:     document.getElementById('ad-int-icon'),
      intProduct:  document.getElementById('ad-int-product'),
      intTagline:  document.getElementById('ad-int-tagline'),
      intCta:      document.getElementById('ad-int-cta'),
      intTimer:    document.getElementById('ad-int-timer'),
      skipBtn:     document.getElementById('ad-skip-btn'),
    };
    this._ADS = [
      { icon:'🗡️', product:'GOBLIN SPEARS EMPORIUM',  tagline:'"Pointy end goes in enemy!"',      cta:'LOOT NOW'     },
      { icon:'💎', product:'SHINY ROCK EXCHANGE',      tagline:'"We buy shinies for cheap gold!"', cta:'SELL TODAY'   },
      { icon:'🔥', product:"TORCHES 'R' US",           tagline:'"Cave too dark? NOT ANYMORE!"',    cta:'LIGHT IT UP'  },
      { icon:'⛏️', product:'GOBLIN SHOVELS INC.',      tagline:'"Dig where ya not supposed!"',   cta:'DIG NOW'      },
      { icon:'🛡️', product:'TROLL BRIDGE INSURANCE',   tagline:'"No gold? No problem!"',           cta:'GET COVERED' },
      { icon:'🍄', product:'CAVE MUSHROOMS MARKET',    tagline:'"Fresh. Edible. Probably."',        cta:'EAT NOW'      },
      { icon:'🪄', product:'WITCH POTIONS CO.',        tagline:'"Turn enemies into frogs!"',        cta:'BREW NOW'     },
      { icon:'🏚️', product:'CAVE REAL ESTATE',        tagline:'"Premium caves. Rats included."',   cta:'MOVE IN'      },
    ];
    // Rotate banner ad every 8 seconds during gameplay
    setInterval(() => {
      this._adBannerIdx = (this._adBannerIdx + 1) % this._ADS.length;
      this._updateBannerAd(this._adBannerIdx);
    }, 8000);

    // Sound effects
    this.sfx = {
      swing:   new Audio('swing.mp3'),
      hole:    new Audio('hit-the-hole.mp3'),
      fanfare: new Audio('goblin fanfair.mp3'),
    };
    this.sfx.swing.volume = 0.7;
    this.sfx.hole.volume  = 0.7;
    this.sfx.fanfare.volume = 0.7;

    // Goblin golfer sprite
    this.goblinImg = new Image();
    this.goblinImg.src = 'goblin_golfer.png';

    this.resize();
    this.bindEvents();
    this.loop();
  }

  // ---- Setup ----
  resize() {
    this.canvas.width  = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  // ---- Ad helpers ----
  _updateBannerAd(idx) {
    const ad = this._ADS[idx];
    if (!ad) return;
    this._adsEl.bannerIcon.textContent = ad.icon;
    this._adsEl.bannerHead.textContent = ad.product;
    this._adsEl.bannerTag.textContent  = ad.tagline;
    this._adsEl.bannerCta.textContent  = ad.cta;
  }

  showAdBanner() {
    this._updateBannerAd(this._adBannerIdx);
    this._adsEl.banner.classList.remove('hidden');
  }

  hideAdBanner() {
    this._adsEl.banner.classList.add('hidden');
  }

  // Show an interstitial ad then call cb when dismissed.
  // Every 3 holes a full-screen ad appears; other holes skip straight to cb.
  maybeShowInterstitial(cb) {
    if (this.holeNum % 3 !== 0) { cb(); return; }

    const ad = this._ADS[this._adIdx % this._ADS.length];
    this._adIdx++;
    const els = this._adsEl;

    els.intIcon.textContent    = ad.icon;
    els.intProduct.textContent = ad.product;
    els.intTagline.textContent = ad.tagline;
    els.intCta.textContent     = ad.cta;
    els.skipBtn.style.display  = 'none';
    els.intEl.classList.remove('hidden');
    this.hideAdBanner();

    let secs = 5;
    els.intTimer.textContent = `Ad closes in ${secs}s`;

    const dismiss = () => {
      clearInterval(ticker);
      els.intEl.classList.add('hidden');
      cb();
    };

    const ticker = setInterval(() => {
      secs--;
      els.intTimer.textContent = secs > 0 ? `Ad closes in ${secs}s` : 'Closing…';
      if (secs === 3) els.skipBtn.style.display = 'block';
      if (secs <= 0)  dismiss();
    }, 1000);

    els.skipBtn.onclick = dismiss;
    els.intCta.onclick  = dismiss; // tapping the CTA also dismisses (placeholder behaviour)
  }

  bindEvents() {
    window.addEventListener('resize', () => this.resize());

    // iOS Safari blocks audio elements from playing unless they have been
    // triggered at least once from within a user-gesture handler. Pre-unlock
    // hole and fanfare on the very first touch/click so they can fire later
    // from the physics loop and setInterval without being blocked.
    const unlockSfx = () => {
      [this.sfx.hole, this.sfx.fanfare].forEach(snd => {
        snd.play().then(() => { snd.pause(); snd.currentTime = 0; }).catch(() => {});
      });
    };
    document.addEventListener('pointerdown', unlockSfx, { once: true });

    const getPos = e => {
      const rect = this.canvas.getBoundingClientRect();
      if (e.touches) {
        return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
      }
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    // ---- Middle mouse pan (always active) ----
    this.canvas.addEventListener('mousedown', e => {
      if (e.button === 1) {
        e.preventDefault();
        this.panDrag  = true;
        this.panLastX = e.clientX;
        this.panLastY = e.clientY;
      }
    });
    this.canvas.addEventListener('mouseup', e => {
      if (e.button === 1) this.panDrag = false;
    });
    this.canvas.addEventListener('mouseleave', () => { this.panDrag = false; this.minimapPanDrag = false; });

    // ---- Scroll to zoom ----
    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const sp   = getPos(e);
      // World point under cursor before zoom
      const wx   = (sp.x - this.canvas.width/2)  / this.camera.zoom + this.camera.x;
      const wy   = (sp.y - this.canvas.height/2) / this.camera.zoom + this.camera.y;
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const newZ = clamp(this.camera.zoom * factor, 0.25, 3.5);
      this.camera.zoom = this.camera.tz = newZ;
      // Reposition so cursor stays on same world point
      this.camera.x = this.camera.tx = wx - (sp.x - this.canvas.width/2)  / newZ;
      this.camera.y = this.camera.ty = wy - (sp.y - this.canvas.height/2) / newZ;
    }, { passive: false });

    // Suppress browser context menu on canvas
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());

    // ---- General mouse move (pan + game mouse tracking) ----
    this.canvas.addEventListener('mousemove', e => {
      if (this.minimapPanDrag && this._mm) {
        const sp = getPos(e);
        const wp = this._mmToWorld(sp.x, sp.y);
        this.camera.x = this.camera.tx = wp.x;
        this.camera.y = this.camera.ty = wp.y;
        this.cameraPanOverride = true;
        return;
      }
      if (this.panDrag) {
        const dx = e.clientX - this.panLastX;
        const dy = e.clientY - this.panLastY;
        this.camera.x  -= dx / this.camera.zoom;
        this.camera.y  -= dy / this.camera.zoom;
        this.camera.tx  = this.camera.x;
        this.camera.ty  = this.camera.y;
        this.panLastX = e.clientX;
        this.panLastY = e.clientY;
        this.cameraPanOverride = true;
      }
      const sp = getPos(e);
      const wp = this.camera.toWorld(sp.x, sp.y, this.canvas);
      this.mouse.x = wp.x; this.mouse.y = wp.y;
      if (this.state === 'builder') {
        this.builderHover = {
          gx: Math.floor(wp.x / CELL),
          gy: Math.floor(wp.y / CELL)
        };
        if (this.builderPainting && (this.builderTool === 'draw' || this.builderTool === 'erase')) {
          this.builderApplyTool(wp.x, wp.y, false);
        }
      }
    });

    // ---- Left click (game + builder) ----
    this.canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const sp = getPos(e);

      // Minimap pan intercept (works in all in-game states)
      const mmStates = ['playing', 'rolling', 'sinking', 'fanfare'];
      if (mmStates.includes(this.state) && this._mmHit(sp.x, sp.y)) {
        this.minimapPanDrag = true;
        const wp = this._mmToWorld(sp.x, sp.y);
        this.camera.x = this.camera.tx = wp.x;
        this.camera.y = this.camera.ty = wp.y;
        this.cameraPanOverride = true;
        return;
      }

      const wp = this.camera.toWorld(sp.x, sp.y, this.canvas);

      if (this.state === 'builder') {
        this.builderPainting = true;
        this.builderApplyTool(wp.x, wp.y, false);
        return;
      }

      if (this.state !== 'playing') return;
      this.mouse.down = true;
      const bd = dist(wp.x, wp.y, this.ball.x, this.ball.y);
      if (bd < 50 / this.camera.zoom) {
        this.dragging  = true;
        this.dragStart = wp;
      }
    });

    this.canvas.addEventListener('mouseup', e => {
      if (e.button !== 0) return;
      this.minimapPanDrag = false;
      if (this.state === 'builder') {
        this.builderPainting = false;
        return;
      }
      if (this.state !== 'playing') return;
      if (this.dragging && this.dragStart) this.shoot();
      this.dragging   = false;
      this.dragStart  = null;
      this.mouse.down = false;
    });

    // ---- Right click (builder erase) ----
    this.canvas.addEventListener('mousedown', e => {
      if (e.button !== 2) return;
      if (this.state !== 'builder') return;
      const sp = getPos(e);
      const wp = this.camera.toWorld(sp.x, sp.y, this.canvas);
      this.builderApplyTool(wp.x, wp.y, true);
    });

    // ---- Touch ----
    this.canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      const sp = getPos(e);

      // Minimap tap/drag — single touch on minimap area
      const mmStates = ['playing', 'rolling', 'sinking', 'fanfare', 'blackhole_anim'];
      if (mmStates.includes(this.state) && this._mmHit(sp.x, sp.y)) {
        this.minimapPanDrag = true;
        const wp = this._mmToWorld(sp.x, sp.y);
        this.camera.x = this.camera.tx = wp.x;
        this.camera.y = this.camera.ty = wp.y;
        this.cameraPanOverride = true;
        return;
      }

      const wp = this.camera.toWorld(sp.x, sp.y, this.canvas);
      if (this.state === 'builder') { this.builderApplyTool(wp.x, wp.y, false); return; }
      if (this.state !== 'playing') return;
      this.mouse.down = true;
      const bd = dist(wp.x, wp.y, this.ball.x, this.ball.y);
      if (bd < 50 / this.camera.zoom) { this.dragging = true; this.dragStart = wp; }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const sp = getPos(e);
      if (this.minimapPanDrag && this._mm) {
        const wp = this._mmToWorld(sp.x, sp.y);
        this.camera.x = this.camera.tx = wp.x;
        this.camera.y = this.camera.ty = wp.y;
        this.cameraPanOverride = true;
        return;
      }
      const wp = this.camera.toWorld(sp.x, sp.y, this.canvas);
      this.mouse.x = wp.x; this.mouse.y = wp.y;
    }, { passive: false });

    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      this.minimapPanDrag = false;
      if (this.state !== 'playing') return;
      if (this.dragging && this.dragStart) this.shoot();
      this.dragging = false; this.dragStart = null; this.mouse.down = false;
    }, { passive: false });

    window.addEventListener('keydown', e => {
      if (e.key === '1') this.activatePowerupSlot(0);
      if (e.key === '2') this.activatePowerupSlot(1);
      if (e.key === '3') this.activatePowerupSlot(2);
      if (e.key === '4') this.activatePowerupSlot(3);
      if (e.key === 'Escape' && this.state === 'builder') this.exitBuilder();
    });
  }

  // ---- Game flow ----
  startGame() {
    trackEvent('game_start');
    this.holeNum    = 1;
    this.totalScore = 0;
    this.scorecard  = [];
    this.powerupInventory = {};
    this.powerMult  = 1;
    this.activeEffect = null;
    this.frozenTimer  = 0;
    this.cameraPanOverride = false;
    this.hideAllScreens();
    this.loadHole(1);
  }

  loadHole(num) {
    this.holeNum  = num;
    this.level    = generateLevel(num);
    this.strokes  = 0;
    this.sinkAnim = 0;
    this.inHazard = false;
    this.hazardTimer = 0;
    this.splashAnim  = 0;
    this.splashPos   = null;
    this.outOfBounds = false;
    this.rampElevation = 0;
    this.frozenTimer = 0;
    this.dragging    = false;
    this.dragStart   = null;
    this.cameraPanOverride = false;

    this.ball = {
      x: this.level.tee.x,
      y: this.level.tee.y,
      vx: 0, vy: 0,
      rolling: false
    };
    this.lastSafePos = { x: this.ball.x, y: this.ball.y };
    this.shotStartPos = null;

    // Camera: zoom out to see full hole
    const z = this.camera.zoomForBounds(this.level.bounds, this.canvas);
    const cx = this.level.bounds.x + this.level.bounds.w / 2;
    const cy = this.level.bounds.y + this.level.bounds.h / 2;
    this.camera.snapTo(cx, cy, z);

    // Show banner
    this.state = 'overview';
    this.showAdBanner();
    this.overviewTimer = 160;
    this.bannerTimer   = 140;
    this.showBanner(num, this.level.par);

    // Update HUD
    this.updateHUD();
    this.updatePowerupBar();
  }

  showBanner(num, par) {
    const banner = document.getElementById('hole-banner');
    document.getElementById('banner-num').textContent = num;
    document.getElementById('banner-par').textContent = `Par ${par}`;
    banner.classList.remove('hidden');
  }

  hideBanner() {
    document.getElementById('hole-banner').classList.add('hidden');
  }

  startPlaying() {
    this.state = 'playing';
    // Zoom to ball with comfortable view
    const z = Math.min(1.4, this.camera.zoomForBounds(this.level.bounds, this.canvas) * 1.6);
    this.camera.setTarget(this.ball.x, this.ball.y, z);
  }

  // ---- Shooting ----
  shoot() {
    if (!this.dragStart) return;
    const dx = this.ball.x - this.mouse.x;
    const dy = this.ball.y - this.mouse.y;
    const d  = Math.sqrt(dx*dx + dy*dy);
    if (d < 3 / this.camera.zoom) return;

    // Reset sticky pan so camera follows the ball again on next roll.
    this.cameraPanOverride = false;

    const maxPow = BASE_POWER * this.powerMult;
    const power  = clamp(d / (DRAG_SCALE / this.camera.zoom), 0, 1) * maxPow;
    const nx = dx/d, ny = dy/d;

    this.shotStartPos = { x: this.ball.x, y: this.ball.y };
    this.ball.vx = nx * power;
    this.ball.vy = ny * power;
    this.ball.rolling = true;
    this.strokes++;
    this.state = 'rolling';

    // Swing sound
    this.sfx.swing.currentTime = 0;
    this.sfx.swing.play().catch(() => {});

    // Active powerup effect (fire/laser/ghost) stays active until ball stops;
    // ice is handled immediately in activatePowerupSlot and never queued here.

    this.updateHUD();

    // Fire particles on shoot
    if (this.activeEffect === 'fire') {
      this.particles.emit(this.ball.x, this.ball.y, {
        count: 15, color: '#ff8800', color2: '#ffff00',
        minSpd: 1, maxSpd: 4, spread: 1, minDecay: 0.04, maxDecay: 0.08,
        minSize: 3, maxSize: 7, grav: -0.05
      });
    }
  }

  // ---- Powerup management ----
  activatePowerupSlot(slotIndex) {
    // Only allow powerup activation during relevant game states
    if (this.state !== 'playing' && this.state !== 'rolling') return;

    // Build the active (non-passive) slot list — must match updatePowerupBar ordering
    const keys = Object.keys(this.powerupInventory).filter(k => k !== 'power');
    if (slotIndex >= keys.length) return;
    const id = keys[slotIndex];
    const slot = this.powerupInventory[id];
    if (!slot || slot.uses <= 0) return;

    // Black hole is an immediate effect — sucks up the ball and refunds the stroke.
    if (id === 'blackhole') {
      slot.uses--;
      if (slot.uses <= 0) delete this.powerupInventory[id];
      this.updatePowerupBar();
      trackEvent('powerup_used', { powerup_id: id });
      this.activateBlackHole();
      return;
    }

    // Vacuum suck is an immediate effect — yanks the ball into the hole.
    if (id === 'vacuum') {
      slot.uses--;
      if (slot.uses <= 0) delete this.powerupInventory[id];
      this.updatePowerupBar();
      trackEvent('powerup_used', { powerup_id: id });
      this.activateVacuumSuck();
      return;
    }

    // Ice is an immediate, non-shot effect — applied right now regardless of state.
    // fire/laser/ghost are queued as activeEffect and consume one use when the shot lands.
    if (id === 'ice') {
      // Ice freezes moving obstacles AND water tiles for 5 seconds (300 frames)
      this.frozenTimer = 300;
      // Mark all water cells as frozen (slippery traversable ice)
      if (this.level) {
        for (const c of this.level.cells) {
          if (c.hazard === 'water') { c.frozenWater = true; c._frozenFrames = 300; }
        }
      }
      slot.uses--;
      if (slot.uses <= 0) delete this.powerupInventory[id];
      this.updatePowerupBar();
      trackEvent('powerup_used', { powerup_id: id });
      // Emit ice particles over water cells
      if (this.level) {
        for (const c of this.level.cells) {
          if (c.hazard === 'water') {
            this.particles.emit(c.x + CELL/2, c.y + CELL/2, {
              count: 10, color: '#aaeeff', color2: '#ffffff',
              minSpd: 1, maxSpd: 3, spread: 1,
              minDecay: 0.03, maxDecay: 0.07, minSize: 2, maxSize: 5
            });
          }
        }
      }
      return;
    }

    // fire/laser/ghost can only be queued before shooting, not mid-roll
    if (this.state === 'rolling') return;

    // Toggle active effect for next shot
    if (this.activeEffect === id) {
      this.activeEffect = null;
    } else {
      this.activeEffect = id;
      trackEvent('powerup_used', { powerup_id: id });
    }
    this.updatePowerupBar();
  }

  consumeActiveEffect() {
    if (!this.activeEffect) return;
    const id = this.activeEffect;
    if (this.powerupInventory[id]) {
      this.powerupInventory[id].uses--;
      if (this.powerupInventory[id].uses <= 0) delete this.powerupInventory[id];
    }
    this.activeEffect = null;
    this.updatePowerupBar();
  }

  activateBlackHole() {
    const resetX = (this.shotStartPos || this.level.tee).x;
    const resetY = (this.shotStartPos || this.level.tee).y;
    const cx = this.ball.x;
    const cy = this.ball.y;

    // Refund the stroke if ball is mid-roll
    if (this.state === 'rolling') {
      this.strokes = Math.max(0, this.strokes - 1);
    }

    this.ball.vx = 0; this.ball.vy = 0;
    this.activeEffect = null;
    this.state = 'blackhole_anim';
    this.blackHoleAnim = 0;
    this.blackHoleCX = cx;
    this.blackHoleCY = cy;

    let t = 0;
    const DURATION = 50;
    const interval = setInterval(() => {
      t++;
      this.blackHoleAnim = Math.min(t / DURATION, 1);
      // Spiral ball inward toward vortex center
      this.ball.x = lerp(this.ball.x, cx, 0.18);
      this.ball.y = lerp(this.ball.y, cy, 0.18);
      // Orbiting dark particles
      const angle = t * 0.45;
      const pr = (1 - t / DURATION) * 38;
      this.particles.emit(cx + Math.cos(angle) * pr, cy + Math.sin(angle) * pr, {
        count: 3, color: '#110022', color2: '#9900ff',
        minSpd: 0.2, maxSpd: 1.5, spread: 0.5,
        minDecay: 0.04, maxDecay: 0.09,
        minSize: 2, maxSize: 6, grav: 0
      });
      if (t >= DURATION) {
        clearInterval(interval);
        this.blackHoleAnim = 0;
        this.ball.x = resetX;
        this.ball.y = resetY;
        this.ball.vx = 0; this.ball.vy = 0;
        this.state = 'playing';
        this.updateHUD();
        this.camera.setTarget(this.ball.x, this.ball.y, Math.min(1.6, this.camera.zoom * 1.05));
        // Arrival burst at reset position
        this.particles.emit(resetX, resetY, {
          count: 20, color: '#8800cc', color2: '#dd88ff',
          minSpd: 1, maxSpd: 4, spread: 1,
          minDecay: 0.04, maxDecay: 0.08,
          minSize: 2, maxSize: 6
        });
      }
    }, 16);
  }

  activateVacuumSuck() {
    const cup = this.level.cup;
    const d = dist(this.ball.x, this.ball.y, cup.x, cup.y);
    if (d > VACUUM_RADIUS) return;

    this.ball.vx = 0;
    this.ball.vy = 0;
    this.state = 'vacuum_anim';

    let t = 0;
    const DURATION = 40;
    const interval = setInterval(() => {
      t++;
      const progress = t / DURATION;
      this.ball.x = lerp(this.ball.x, cup.x, 0.1 + progress * 0.15);
      this.ball.y = lerp(this.ball.y, cup.y, 0.1 + progress * 0.15);
      this.particles.emit(this.ball.x, this.ball.y, {
        count: 3, color: '#88aaff', color2: '#ffffff',
        minSpd: 1, maxSpd: 4, spread: Math.PI * 2,
        minDecay: 0.05, maxDecay: 0.1,
        minSize: 1, maxSize: 3
      });
      if (t >= DURATION) {
        clearInterval(interval);
        this.ball.x = cup.x;
        this.ball.y = cup.y;
        this.state = 'playing';
        this.sinkBall();
      }
    }, 16);
  }

  addPowerup(id) {
    const def = POWERUP_DEFS[id];
    if (!def) return;
    if (id === 'power') {
      this.powerMult *= 1.3;
      // Mark in inventory just for display
      this.powerupInventory['power'] = { def, uses: Infinity };
    } else if (this.powerupInventory[id]) {
      this.powerupInventory[id].uses = Math.min(this.powerupInventory[id].uses + def.uses, 5);
    } else {
      this.powerupInventory[id] = { def, uses: def.uses };
    }
    this.updatePowerupBar();
  }

  updatePowerupBar() {
    const bar = document.getElementById('powerup-bar');
    bar.innerHTML = '';
    const allKeys = Object.keys(this.powerupInventory);
    // Render passive 'power' slot first (no key binding, no active glow)
    allKeys.filter(id => id === 'power').forEach(id => {
      const slot = this.powerupInventory[id];
      const div  = document.createElement('div');
      div.className = 'pu-slot'; // never active
      div.title = slot.def.name + ' (passive)';
      div.innerHTML = `<span>${slot.def.icon}</span><span class="pu-key">✦</span>`;
      div.onclick = () => {}; // passive — clicking does nothing
      bar.appendChild(div);
    });
    // Active (consumable) slots numbered 1/2/3 — 'power' is excluded because it
    // is passive and has no key binding. The slot index here must match activatePowerupSlot().
    const activeKeys = allKeys.filter(id => id !== 'power');
    activeKeys.forEach((id, i) => {
      const slot = this.powerupInventory[id];
      const div  = document.createElement('div');
      div.className = 'pu-slot' + (this.activeEffect === id ? ' active' : '');
      div.innerHTML = `<span>${slot.def.icon}</span>
        <span class="pu-count">${slot.uses}</span>
        <span class="pu-key">[${i+1}]</span>`;
      div.onclick = () => this.activatePowerupSlot(i);
      bar.appendChild(div);
    });
  }

  updateHUD() {
    document.getElementById('hud-hole').textContent    = this.holeNum;
    document.getElementById('hud-strokes').textContent = this.strokes;
    document.getElementById('hud-par').textContent     = this.level ? this.level.par : '—';

    const diff = this.totalScore;
    const el   = document.getElementById('hud-score');
    if (diff === 0)      { el.textContent = 'E';  el.className = 'hud-value par'; }
    else if (diff < 0)   { el.textContent = diff; el.className = 'hud-value good'; }
    else                 { el.textContent = `+${diff}`; el.className = 'hud-value bad'; }
  }

  // ---- Physics update ----
  updatePhysics() {
    if (this.state !== 'rolling') return;
    const ball = this.ball;
    const level = this.level;

    // Frozen timer
    if (this.frozenTimer > 0) this.frozenTimer--;

    // Tick frozen water cells — thaw when timer expires
    if (level) {
      for (const c of level.cells) {
        if (c.frozenWater) {
          c._frozenFrames = (c._frozenFrames || 0) - 1;
          if (c._frozenFrames <= 0) { c.frozenWater = false; c._frozenFrames = 0; }
        }
      }
    }

    // Determine friction coefficient for the cell the ball is currently on.
    const cell = getCellAt(ball.x, ball.y, level.cells);
    const fr   = cell?.hazard === 'sand' ? FRICTION_SAND
               : cell?.frozenWater      ? 0.998        // icy — very slippery
               : FRICTION;

    const isLaser = this.activeEffect === 'laser';
    const isGhost = this.activeEffect === 'ghost';
    const skipObstacles = isLaser || isGhost;

    // Advance moving obstacles ONCE per frame, outside the substep loop.
    // If updated inside the loop they would move SUBSTEPS times faster than intended.
    if (!skipObstacles) {
      for (const obs of level.obstacles) {
        if (!obs.alive || obs.type !== 'moving' || this.frozenTimer > 0) continue;
        if (obs.axis === 'x') {
          obs.x += obs.speed * obs.dir;
          if (obs.x <= obs.minPos || obs.x + obs.w >= obs.maxPos) obs.dir *= -1;
        } else {
          obs.y += obs.speed * obs.dir;
          if (obs.y <= obs.minPos || obs.y + obs.h >= obs.maxPos) obs.dir *= -1;
        }
      }
    }

    // Sub-stepped physics: split each frame into SUBSTEPS micro-steps to prevent
    // tunnelling at high speed. Friction is distributed as pow(fr,1/N) per step
    // so that applying it N times equals one full-frame application of fr.
    for (let step = 0; step < SUBSTEPS; step++) {
      ball.vx *= Math.pow(fr, 1/SUBSTEPS);
      ball.vy *= Math.pow(fr, 1/SUBSTEPS);
      ball.x  += ball.vx / SUBSTEPS;
      ball.y  += ball.vy / SUBSTEPS;

      // Wall collision always applies
      for (const w of level.walls) {
        resolveWall(ball, w);
      }

      // Obstacle collision (skipped for laser and ghost)
      if (!skipObstacles) {
        for (const obs of level.obstacles) {
          if (!obs.alive) continue;

          let hit = false;
          if (obs.type === 'circle') {
            hit = resolveCircle(ball, obs);
            if (hit) {
              // Pinball bumper particle burst
              this.particles.emit(ball.x, ball.y, {
                count: 10, color: '#88ccff', color2: '#ffffff',
                minSpd: 2, maxSpd: 6, spread: 1,
                minDecay: 0.04, maxDecay: 0.09,
                minSize: 2, maxSize: 5
              });
            }
          } else {
            hit = resolveRect(ball, obs);
          }

          if (hit && obs.destructible && this.activeEffect === 'fire') {
            // Destroy wooden obstacle with fire
            obs.alive = false;
            this.particles.emit(obs.x + obs.w/2, obs.y + obs.h/2, {
              count: 20, color: '#ff8800', color2: '#ff4400',
              minSpd: 1.5, maxSpd: 5, spread: 1,
              minDecay: 0.03, maxDecay: 0.07,
              minSize: 4, maxSize: 9, grav: 0.1
            });
            this.particles.emit(obs.x + obs.w/2, obs.y + obs.h/2, {
              count: 10, color: '#ffff88', color2: '#ffffff',
              minSpd: 0.5, maxSpd: 2, spread: 1,
              minDecay: 0.05, maxDecay: 0.1,
              minSize: 2, maxSize: 4, grav: -0.05
            });
          }
        }
      }
    }

    // Fire particles trail
    if (this.activeEffect === 'fire') {
      this.particles.emit(ball.x, ball.y, {
        count: 3, color: '#ff6600', color2: '#ff2200',
        minSpd: 0.3, maxSpd: 1.5, spread: 1,
        minDecay: 0.06, maxDecay: 0.12,
        minSize: 2, maxSize: 5, grav: -0.08
      });
    }
    // Laser particles
    if (this.activeEffect === 'laser') {
      this.particles.emit(ball.x, ball.y, {
        count: 2, color: '#00cfff', color2: '#0044ff',
        minSpd: 0.5, maxSpd: 2, spread: 1,
        minDecay: 0.04, maxDecay: 0.09,
        minSize: 2, maxSize: 4
      });
    }

    // Check hazards
    if (!this.inHazard) {
      const curCell = getCellAt(ball.x, ball.y, level.cells);
      if (curCell?.hazard === 'water') {
        // Check if ball is safe on the bridge ramp or on frozen water
        let onRamp = false;
        if (curCell.rampAxis === 'x') {
          onRamp = Math.abs(ball.y - (curCell.y + CELL * 0.5)) < (curCell.rampHalfW || CELL * 0.28) - BALL_R * 0.3;
        } else if (curCell.rampAxis === 'y') {
          onRamp = Math.abs(ball.x - (curCell.x + CELL * 0.5)) < (curCell.rampHalfW || CELL * 0.28) - BALL_R * 0.3;
        }

        if (onRamp || curCell.frozenWater) {
          // Ball is safe — compute ramp elevation for visual effect
          let rampT = 0;
          if (curCell.rampAxis === 'x') rampT = (ball.x - curCell.x) / CELL;
          else                          rampT = (ball.y - curCell.y) / CELL;
          this.rampElevation = Math.max(0, Math.sin(clamp(rampT, 0, 1) * Math.PI));
        } else {
          // Water hazard!
          this.rampElevation = 0;
          this.splashPos = { x: ball.x, y: ball.y };
          this.splashAnim = 0;
          this.inHazard  = true;
          this.hazardTimer = 60;
          ball.vx = 0; ball.vy = 0;
          this.consumeActiveEffect();
          this.strokes++; // penalty
          this.updateHUD();
          this.particles.emit(ball.x, ball.y, {
            count: 15, color: '#66aaff', color2: '#ffffff',
            minSpd: 1, maxSpd: 4, spread: 1,
            minDecay: 0.04, maxDecay: 0.08,
            minSize: 2, maxSize: 6, grav: -0.05
          });
          return;
        }
      } else {
        // Not on water — fade ramp elevation out
        if (this.rampElevation > 0) this.rampElevation = Math.max(0, this.rampElevation - 0.08);
      }
    }

    // OOB: if ball wanders off course
    if (!onCourse(ball.x, ball.y, level.cells)) {
      if (!this.outOfBounds) {
        this.outOfBounds = true;
        ball.x = this.lastSafePos.x;
        ball.y = this.lastSafePos.y;
        ball.vx *= -0.5; ball.vy *= -0.5;
      }
    } else {
      this.outOfBounds = false;
      const spd = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy);
      if (spd > 0.5) {
        this.lastSafePos = { x: ball.x, y: ball.y };
      }
    }

    // Cup pull: nudge the ball toward the hole when it's close and slow,
    // so near-misses feel satisfying without being unfair at high speed.
    const dc = dist(ball.x, ball.y, level.cup.x, level.cup.y);
    const spd = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy);
    if (dc < CUP_PULL_R && spd < BASE_POWER * this.powerMult * 0.55) {
      // Gentle pull toward cup
      const pullF = (1 - dc/CUP_PULL_R) * 0.3;
      ball.vx += (level.cup.x - ball.x) * pullF;
      ball.vy += (level.cup.y - ball.y) * pullF;
    }
    if (dc < CUP_SINK_R && spd < 6) {
      this.sinkBall();
      return;
    }

    // Ball stopped
    if (spd < STOP_SPEED) {
      ball.vx = 0; ball.vy = 0;
      ball.rolling = false;
      this.state = 'playing';
      this.consumeActiveEffect();
      this.updateHUD();
      this.camera.setTarget(ball.x, ball.y, Math.min(1.6, this.camera.zoom * 1.05));
    }
  }

  sinkBall() {
    this.state = 'sinking';
    this.ball.vx = 0; this.ball.vy = 0;
    this.consumeActiveEffect();

    // Ball touches the hole
    this.sfx.hole.currentTime = 0;
    this.sfx.hole.play().catch(() => {});

    let t = 0;
    const interval = setInterval(() => {
      t++;
      this.sinkAnim = Math.min(t / 30, 1);
      this.ball.x = lerp(this.ball.x, this.level.cup.x, 0.15);
      this.ball.y = lerp(this.ball.y, this.level.cup.y, 0.15);
      this.particles.emit(this.ball.x, this.ball.y, {
        count: 2, color: '#aaff66', color2: '#ffee00',
        minSpd: 0.5, maxSpd: 2, spread: 1,
        minDecay: 0.05, maxDecay: 0.1,
        minSize: 1, maxSize: 3
      });
      if (t >= 35) {
        clearInterval(interval);
        this.triggerFanfare();
      }
    }, 16);
  }

  triggerFanfare() {
    // Goblin fanfare — ball is fully in the hole
    this.sfx.fanfare.currentTime = 0;
    this.sfx.fanfare.play().catch(() => {});

    const diff  = this.strokes - this.level.par;
    const isHio = this.strokes === 1;

    // Decide fanfare tier
    let tier;
    if (isHio)        tier = 'hio';
    else if (diff <= -2) tier = 'eagle';
    else if (diff === -1) tier = 'birdie';
    else if (diff <= 0)  tier = 'par';
    else                 tier = 'none';

    trackEvent('hole_complete', { hole: this.holeNum, par: this.level.par, strokes: this.strokes, score_tier: tier });

    if (tier === 'none') {
      this.holeComplete();
      return;
    }

    const cx = this.level.cup.x, cy = this.level.cup.y;

    if (tier === 'hio') {
      // Absolutely wild
      for (let i = 0; i < 8; i++) {
        const colors = ['#ff0080','#ff8800','#ffff00','#00ff88','#00cfff','#cc44ff','#ffffff'];
        this.particles.emit(cx, cy, {
          count: 30, color: colors[i % colors.length], color2: '#ffffff',
          minSpd: 3, maxSpd: 12, spread: 1,
          minDecay: 0.008, maxDecay: 0.025,
          minSize: 4, maxSize: 14, grav: 0.08
        });
      }
      this.fanfare = { tier, timer: 220, text: 'GOBLIN GENIUS!!!', sub: 'HOLE IN ONE!', shake: 12 };
    } else if (tier === 'eagle') {
      for (let i = 0; i < 4; i++) {
        this.particles.emit(cx, cy, {
          count: 25, color: '#ffd700', color2: '#ff8800',
          minSpd: 2, maxSpd: 8, spread: 1,
          minDecay: 0.012, maxDecay: 0.03,
          minSize: 3, maxSize: 10, grav: 0.05
        });
      }
      this.fanfare = { tier, timer: 160, text: 'PROPER GOBLIN!', sub: '', shake: 5 };
    } else if (tier === 'birdie') {
      for (let i = 0; i < 2; i++) {
        this.particles.emit(cx, cy, {
          count: 20, color: '#4eff91', color2: '#aaff44',
          minSpd: 1.5, maxSpd: 6, spread: 1,
          minDecay: 0.015, maxDecay: 0.035,
          minSize: 2, maxSize: 7, grav: 0.04
        });
      }
      this.fanfare = { tier, timer: 110, text: 'Sneaky Shot!', sub: '', shake: 0 };
    } else {
      this.particles.emit(cx, cy, {
        count: 12, color: '#aaff66', color2: '#ffffff',
        minSpd: 1, maxSpd: 4, spread: 1,
        minDecay: 0.02, maxDecay: 0.05,
        minSize: 2, maxSize: 5, grav: 0.03
      });
      this.fanfare = { tier, timer: 70, text: 'In the burrow!', sub: '', shake: 0 };
    }

    this.state = 'fanfare';
  }

  updateFanfare() {
    if (this.state !== 'fanfare' || !this.fanfare) return;
    this.fanfare.timer--;

    // Continuous particles for hio/eagle
    if (this.fanfare.tier === 'hio' && this.fanfare.timer % 6 === 0) {
      const cx = this.level.cup.x, cy = this.level.cup.y;
      const colors = ['#ff0080','#ff8800','#ffff00','#00ff88','#00cfff','#cc44ff'];
      const c = colors[Math.floor(Math.random() * colors.length)];
      this.particles.emit(cx + rnd(-60,60), cy + rnd(-60,60), {
        count: 8, color: c, color2: '#ffffff',
        minSpd: 2, maxSpd: 8, spread: 1,
        minDecay: 0.015, maxDecay: 0.04,
        minSize: 3, maxSize: 10, grav: 0.06
      });
    }

    if (this.fanfare.timer <= 0) {
      this.fanfare = null;
      this.holeComplete();
    }
  }

  drawFanfare(ctx) {
    if (this.state !== 'fanfare' || !this.fanfare) return;
    const f    = this.fanfare;
    const prog = f.timer / (f.tier === 'hio' ? 220 : f.tier === 'eagle' ? 160 : f.tier === 'birdie' ? 110 : 70);
    const W    = this.canvas.width, H = this.canvas.height;

    // Screen flash pulse
    const flash = f.tier === 'hio' ? 0.18 : 0.08;
    ctx.fillStyle = `rgba(255,255,200,${flash * prog})`;
    ctx.fillRect(0, 0, W, H);

    // Screen shake offset
    const shake = f.shake * prog;
    const sx = shake > 0 ? rnd(-shake, shake) : 0;
    const sy = shake > 0 ? rnd(-shake, shake) : 0;

    ctx.save();
    ctx.translate(sx, sy);

    // Main text — scale down to fit narrow screens
    const scale = f.tier === 'hio' ? 1 + Math.sin(Date.now() * 0.008) * 0.08 : 1;
    const fontSize = f.tier === 'hio' ? 68 : f.tier === 'eagle' ? 54 : 44;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${fontSize * scale}px sans-serif`;
    const maxTextW = W * 0.88;
    const measuredW = ctx.measureText(f.text).width;
    const fitScale = measuredW > maxTextW ? maxTextW / measuredW : 1;
    ctx.font = `900 ${fontSize * scale * fitScale}px sans-serif`;

    // Rainbow text for hio
    if (f.tier === 'hio') {
      const t = Date.now() * 0.003;
      const grd = ctx.createLinearGradient(W*0.1, 0, W*0.9, 0);
      grd.addColorStop(0,   `hsl(${(t*60)%360},100%,60%)`);
      grd.addColorStop(0.25,`hsl(${(t*60+90)%360},100%,60%)`);
      grd.addColorStop(0.5, `hsl(${(t*60+180)%360},100%,60%)`);
      grd.addColorStop(0.75,`hsl(${(t*60+270)%360},100%,60%)`);
      grd.addColorStop(1,   `hsl(${(t*60+360)%360},100%,60%)`);
      ctx.shadowColor = '#fff'; ctx.shadowBlur = 30;
      ctx.fillStyle = grd;
    } else if (f.tier === 'eagle') {
      ctx.shadowColor = '#ffd700'; ctx.shadowBlur = 20;
      ctx.fillStyle = '#ffd700';
    } else if (f.tier === 'birdie') {
      ctx.shadowColor = '#4eff91'; ctx.shadowBlur = 15;
      ctx.fillStyle = '#4eff91';
    } else {
      ctx.shadowColor = '#aaff66'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#ffffff';
    }

    // Text with outline
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 6;
    ctx.strokeText(f.text, W/2, H/2 - (f.sub ? 20 : 0));
    ctx.fillText(f.text,   W/2, H/2 - (f.sub ? 20 : 0));

    if (f.sub) {
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `700 26px sans-serif`;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 4;
      ctx.strokeText(f.sub, W/2, H/2 + 32);
      ctx.fillText(f.sub,   W/2, H/2 + 32);
    }

    ctx.restore();
    ctx.shadowBlur = 0;
  }

  holeComplete() {
    this.hideAdBanner();
    const strokes  = this.strokes;
    const par      = this.level.par;
    const diff     = strokes - par;
    this.totalScore += diff;
    this.scorecard.push({ hole: this.holeNum, par, strokes, diff });

    this.hideAllScreens();
    const screen = document.getElementById('hole-screen');
    screen.classList.remove('hidden');

    // Score label and color
    const scoreEl = document.getElementById('hole-score-val');
    const labelEl = document.getElementById('hole-score-label');
    const infoEl  = document.getElementById('hole-stroke-info');
    const nextBtn = document.getElementById('hole-next-btn');

    let label, scoreClass;
    const isHio = strokes === 1;
    if      (isHio)          { label = 'GOBLIN GENIUS!!!'; scoreClass = 'eagle'; }
    else if (diff <= -3) { label = 'Legendary Goblin!'; scoreClass = 'eagle'; }
    else if (diff === -2) { label = 'Proper Goblin!'; scoreClass = 'eagle'; }
    else if (diff === -1) { label = 'Sneaky Shot!';   scoreClass = 'birdie'; }
    else if (diff ===  0) { label = 'Goblin Standard'; scoreClass = 'par'; }
    else if (diff ===  1) { label = 'Blundered!';     scoreClass = 'bogey'; }
    else if (diff ===  2) { label = 'DISASTER!';      scoreClass = 'double'; }
    else                  { label = `+${diff} Shame`; scoreClass = 'double'; }

    let scoreText;
    if (diff === 0)     scoreText = 'E';
    else if (diff < 0)  scoreText = `${diff}`;
    else                scoreText = `+${diff}`;

    scoreEl.textContent = scoreText;
    scoreEl.className   = `hole-score ${scoreClass}`;
    labelEl.textContent = label;
    infoEl.textContent  = `${strokes} stroke${strokes !== 1 ? 's' : ''} · Par ${par}`;

    if (this.isPlayTest) {
      nextBtn.textContent = 'Back to Builder';
      nextBtn.onclick = () => this.returnToBuilder();
    } else if (this.holeNum >= TOTAL_HOLES) {
      nextBtn.textContent = 'Count the Loot';
      nextBtn.onclick = () => this.maybeShowInterstitial(() => this.showGameOver());
    } else {
      nextBtn.textContent = 'Grab a Trinket';
      nextBtn.onclick = () => this.maybeShowInterstitial(() => this.showPowerupScreen());
    }

    this.state = 'hole_complete';
    this.updateHUD();
  }

  showPowerupScreen() {
    this.hideAdBanner();
    this.hideAllScreens();
    const screen = document.getElementById('powerup-screen');
    screen.classList.remove('hidden');

    // Pick 3 random powerups
    const available = shuffle(POWERUP_POOL).slice(0, POWERUP_CHOICES);
    const cards     = document.getElementById('pu-cards');
    cards.innerHTML = '';

    for (const id of available) {
      const def  = POWERUP_DEFS[id];
      const card = document.createElement('div');
      card.className = `pu-card ${def.cssClass}`;
      card.innerHTML = `
        <div class="pu-icon">${def.icon}</div>
        <div class="pu-name">${def.name}</div>
        <div class="pu-desc">${def.desc}</div>`;
      card.onclick = () => {
        this.addPowerup(id);
        this.nextHole();
      };
      cards.appendChild(card);
    }
  }

  skipPowerup() {
    this.nextHole();
  }

  nextHole() {
    this.hideAllScreens();
    this.loadHole(this.holeNum + 1);
  }

  showGameOver() {
    trackEvent('game_complete', { total_score: this.totalScore, holes_played: this.scorecard.length });
    this.hideAdBanner();
    this.hideAllScreens();
    const screen = document.getElementById('gameover-screen');
    screen.classList.remove('hidden');

    const diff = this.totalScore;
    const el   = document.getElementById('go-summary');
    if      (diff < -5) el.textContent = `Total: ${diff} — Amazing round!`;
    else if (diff < 0)  el.textContent = `Total: ${diff} — Under par!`;
    else if (diff === 0)el.textContent = `Total: Even par — Great round!`;
    else                el.textContent = `Total: +${diff} — Keep practicing!`;

    const table = document.getElementById('score-table');
    // Clear old rows
    while (table.rows.length > 1) table.deleteRow(1);
    for (const row of this.scorecard) {
      const tr = table.insertRow();
      const d  = row.diff;
      const s  = d === 0 ? 'E' : d < 0 ? `${d}` : `+${d}`;
      tr.innerHTML = `<td>${row.hole}</td><td>${row.par}</td><td>${row.strokes}</td>
        <td style="color:${d < 0 ? '#4eff91' : d > 0 ? '#ff5555' : '#fff'}">${s}</td>`;
    }
    this.state = 'gameover';
  }

  shareScore() {
    const diff   = this.totalScore;
    const sign   = diff < 0 ? `${diff}` : diff === 0 ? 'E' : `+${diff}`;
    const label  = diff < -5 ? 'Amazing round! 🏆' : diff < 0 ? 'Under par! 🔥' : diff === 0 ? 'Even par! ⛳' : 'Keep practicing! 💪';
    const url    = window.location.href.split('?')[0];
    const text   = `👺 Goblin Golf — ${sign} (${label})\nThink you can beat me? Play here: ${url}`;

    if (navigator.share) {
      navigator.share({ title: 'Goblin Golf', text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        const toast = document.getElementById('share-toast');
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.opacity = '0'; }, 2200);
      }).catch(() => {});
    }
  }

  // ---- Hazard recovery ----
  updateHazard() {
    if (!this.inHazard) return;
    this.hazardTimer--;
    if (this.splashAnim < 1) this.splashAnim = Math.min(this.splashAnim + 0.04, 1);
    if (this.hazardTimer <= 0) {
      this.inHazard = false;
      this.splashPos = null;
      this.ball.x   = this.lastSafePos.x;
      this.ball.y   = this.lastSafePos.y;
      this.ball.vx  = 0; this.ball.vy = 0;
      this.state    = 'playing';
    }
  }

  // ---- Camera ----
  updateCamera() {
    // Only auto-follow when the player hasn't manually panned.
    // cameraPanOverride stays true until the next shot, keeping the view sticky.
    if ((this.state === 'rolling' || this.state === 'playing') && !this.cameraPanOverride) {
      this.camera.setTarget(this.ball.x, this.ball.y, this.camera.tz);
    }
    this.camera.update();
  }

  // ---- Overview timer ----
  updateOverview() {
    if (this.state !== 'overview') return;
    this.overviewTimer--;
    if (this.bannerTimer > 0) {
      this.bannerTimer--;
      if (this.bannerTimer <= 0) this.hideBanner();
    }
    if (this.overviewTimer <= 0) {
      this.startPlaying();
    }
  }

  // ---- Rendering ----
  render() {
    const ctx = this.ctx;
    this.renderer.clear();

    if (this.state === 'builder') {
      this.renderBuilder();
      return;
    }

    if (!this.level) return;

    // IMPORTANT: all draw methods call camera.toScreen() for coordinate conversion.
    // Never call camera.apply(ctx) here — mixing both causes a double-transform bug.
    this.renderer.drawCells(this.level.cells);
    this.renderer.drawWalls(this.level.walls);
    this.renderer.drawObstacles(this.level.obstacles);
    this.renderer.drawTee(this.level.tee);
    this.renderer.drawCup(this.level.cup, this.sinkAnim);

    // Particles drawn in world→screen space
    this.particles.draw(ctx, this.camera, this.canvas);

    // Splash
    if (this.splashPos && this.splashAnim < 1) {
      this.renderer.drawSplash(this.splashPos.x, this.splashPos.y, this.splashAnim);
    }

    // Draw ball (hide if sinking fully complete)
    if (this.state !== 'sinking' || this.sinkAnim < 1) {
      const pwEffects = {
        fire:  { active: this.activeEffect === 'fire' },
        laser: { active: this.activeEffect === 'laser' },
        ghost: { active: this.activeEffect === 'ghost' }
      };
      if (this.state === 'blackhole_anim') {
        // Black hole vortex — draw void then shrink ball into it
        this.renderer.drawBlackHoleVortex(this.blackHoleCX, this.blackHoleCY, this.blackHoleAnim);
        const bScale = 1 - this.blackHoleAnim;
        if (bScale > 0.02) {
          const s = this.camera.toScreen(this.ball.x, this.ball.y, this.canvas);
          ctx.save();
          ctx.translate(s.x, s.y);
          ctx.scale(bScale, bScale);
          ctx.translate(-s.x, -s.y);
          this.renderer.drawBall(this.ball, pwEffects);
          ctx.restore();
        }
      } else if (this.state === 'sinking' && this.sinkAnim > 0) {
        // Scale ball down around its screen position as it sinks
        const bScale = 1 - this.sinkAnim;
        const s = this.camera.toScreen(this.ball.x, this.ball.y, this.canvas);
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.scale(bScale, bScale);
        ctx.translate(-s.x, -s.y);
        this.renderer.drawBall(this.ball, pwEffects);
        ctx.restore();
      } else if (this.rampElevation > 0.01) {
        // Ramp-over effect: sin(t*PI) gives 0→1→0 arc across the bridge.
        // Ball is translated upward in screen space and scaled up to simulate
        // rising toward the camera. Shadow stays at ground level.
        const elev = this.rampElevation;
        const s = this.camera.toScreen(this.ball.x, this.ball.y, this.canvas);
        const lift = elev * 28 * this.camera.zoom;   // screen-space upward offset
        const bScale = 1 + elev * 0.45;              // ball grows as it nears camera
        // Draw elongated shadow at ground level
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${0.18 + elev * 0.12})`;
        ctx.beginPath();
        ctx.ellipse(s.x + 2, s.y + 3, BALL_R * this.camera.zoom * (1 + elev * 0.3), BALL_R * this.camera.zoom * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Draw ball lifted and scaled
        ctx.save();
        ctx.translate(s.x, s.y - lift);
        ctx.scale(bScale, bScale);
        ctx.translate(-s.x, -(s.y - lift));
        this.renderer.drawBall(this.ball, pwEffects);
        ctx.restore();
      } else {
        this.renderer.drawBall(this.ball, pwEffects);
      }
    }

    // Goblin golfer sprite at tee — visible before first shot only
    if (this.strokes === 0 && (this.state === 'overview' || this.state === 'playing')) {
      this.renderer.drawGoblinAtTee(this.level.tee, this.level.cup, this.goblinImg);
    }

    // Fanfare overlay
    this.drawFanfare(ctx);

    // Aim line overlay
    if (this.state === 'playing' && this.dragging && this.dragStart) {
      const maxPow = BASE_POWER * this.powerMult;
      this.renderer.drawAimLine(this.ball, { x: this.mouse.x, y: this.mouse.y }, maxPow);
    }

    // Minimap (drawn last so it's on top)
    const mmStates = ['playing', 'rolling', 'sinking', 'fanfare', 'blackhole_anim'];
    if (mmStates.includes(this.state)) {
      this.drawMinimap(ctx);
    }
  }

  drawMinimap(ctx) {
    if (!this.level) return;
    const MM_W = 160, MM_H = 120;
    const MM_X = this.canvas.width - MM_W - 10;
    const MM_Y = 70;
    const cells = this.level.cells;
    const bounds = this.level.bounds;

    // Compute uniform scale so the entire course fits inside the minimap with padding.
    const pad = 6;
    const scaleX = (MM_W - pad * 2) / (bounds.w || 1);
    const scaleY = (MM_H - pad * 2) / (bounds.h || 1);
    const scale  = Math.min(scaleX, scaleY);

    // Offset to center course in minimap
    const courseW = bounds.w * scale;
    const courseH = bounds.h * scale;
    const offX = MM_X + pad + (MM_W - pad * 2 - courseW) / 2 - bounds.x * scale;
    const offY = MM_Y + pad + (MM_H - pad * 2 - courseH) / 2 - bounds.y * scale;

    // Cache geometry for event handlers
    this._mm = { x: MM_X, y: MM_Y, w: MM_W, h: MM_H, scale, offX, offY };

    // toMM is world→minimap; _mmToWorld is the inverse (see below).
    const toMM = (wx, wy) => ({
      x: wx * scale + offX,
      y: wy * scale + offY
    });

    // Background
    ctx.save();
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = '#0a1a05';
    ctx.fillRect(MM_X, MM_Y, MM_W, MM_H);
    ctx.globalAlpha = 1;

    // Border
    ctx.strokeStyle = '#3a8a20';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(MM_X, MM_Y, MM_W, MM_H);

    // Clip to minimap area
    ctx.beginPath();
    ctx.rect(MM_X, MM_Y, MM_W, MM_H);
    ctx.clip();

    // Draw cells
    const cellSz = CELL * scale;
    for (const cell of cells) {
      const p = toMM(cell.x, cell.y);
      if (cell.hazard === 'water') {
        ctx.fillStyle = '#1a50b0';
      } else if (cell.hazard === 'sand') {
        ctx.fillStyle = '#c8a240';
      } else {
        ctx.fillStyle = '#2e7d32';
      }
      ctx.fillRect(p.x, p.y, cellSz, cellSz);
    }

    // Cup (red dot)
    const cup = toMM(this.level.cup.x, this.level.cup.y);
    ctx.fillStyle = '#ff3333';
    ctx.beginPath();
    ctx.arc(cup.x, cup.y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Ball (white pulsing dot)
    const ball = toMM(this.ball.x, this.ball.y);
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() * 0.008);
    ctx.fillStyle = `rgba(255,255,255,${pulse})`;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Camera viewport rectangle
    const camZoom = this.camera.zoom;
    const vpW = this.canvas.width  / camZoom;
    const vpH = this.canvas.height / camZoom;
    const vpX = this.camera.x - vpW / 2;
    const vpY = this.camera.y - vpH / 2;
    const vpP  = toMM(vpX, vpY);
    ctx.strokeStyle = 'rgba(255,255,200,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(vpP.x, vpP.y, vpW * scale, vpH * scale);

    ctx.restore();
  }

  // Returns true if canvas-space point (sx,sy) is inside the minimap
  _mmHit(sx, sy) {
    if (!this._mm) return false;
    const m = this._mm;
    return sx >= m.x && sx <= m.x + m.w && sy >= m.y && sy <= m.y + m.h;
  }

  // Convert canvas-space minimap point → world coords
  _mmToWorld(sx, sy) {
    const m = this._mm;
    return { x: (sx - m.offX) / m.scale, y: (sy - m.offY) / m.scale };
  }

  hideAllScreens() {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  }


  // ============================================================
  //  LEVEL BUILDER
  // ============================================================
  enterBuilder() {
    this.state        = 'builder';
    this.builderTool  = 'draw';
    this.builderHover = null;
    this.builderPainting = false;
    this.builderData  = {
      cells: new Map(),
      tee:   { gx: 0, gy: 0 },
      cup:   { gx: 3, gy: 0 },
      obstacles: []
    };
    // Seed a starter straight course
    for (let gx = 0; gx < 4; gx++) {
      this.builderData.cells.set(`${gx},0`, { gx, gy: 0, hazard: null });
    }
    this.builderLevel = this._levelFromBuilder();
    const z  = this.camera.zoomForBounds({ x:0, y:-CELL*2, w:CELL*6, h:CELL*5 }, this.canvas);
    this.camera.snapTo(CELL * 2, 0, z);
    this.hideAllScreens();
    document.getElementById('builder-ui').classList.remove('hidden');
    document.getElementById('controls-hint').classList.add('hidden');
    this.builderSetActiveTool('draw');
  }

  exitBuilder() {
    document.getElementById('builder-ui').classList.add('hidden');
    document.getElementById('controls-hint').classList.remove('hidden');
    this.state = 'title';
    document.getElementById('title-screen').classList.remove('hidden');
  }

  builderSetActiveTool(tool) {
    this.builderTool = tool;
    document.querySelectorAll('.bp-tool').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
  }

  builderApplyTool(wx, wy, isRight) {
    const gx  = Math.floor(wx / CELL);
    const gy  = Math.floor(wy / CELL);
    const key = `${gx},${gy}`;
    const bd  = this.builderData;

    if (isRight) {
      // Right-click: remove nearest obstacle or erase tile
      let best = null, bestD = CELL * 0.6;
      for (const o of bd.obstacles) {
        const ox = o.type === 'circle' ? o.x : o.x + o.w / 2;
        const oy = o.type === 'circle' ? o.y : o.y + o.h / 2;
        const d  = dist(wx, wy, ox, oy);
        if (d < bestD) { best = o; bestD = d; }
      }
      if (best) {
        bd.obstacles = bd.obstacles.filter(o => o !== best);
      } else {
        bd.cells.delete(key);
        if (bd.tee?.gx === gx && bd.tee?.gy === gy)  bd.tee = null;
        if (bd.cup?.gx === gx && bd.cup?.gy === gy)  bd.cup = null;
      }
      this.builderLevel = this._levelFromBuilder();
      return;
    }

    const tool = this.builderTool;
    const cx = gx * CELL + CELL / 2, cy = gy * CELL + CELL / 2;

    switch (tool) {
      case 'draw':
        bd.cells.set(key, bd.cells.get(key) || { gx, gy, hazard: null });
        break;
      case 'erase':
        bd.cells.delete(key);
        bd.obstacles = bd.obstacles.filter(o => {
          const ox = Math.floor((o.type === 'circle' ? o.x : o.x + o.w/2) / CELL);
          const oy = Math.floor((o.type === 'circle' ? o.y : o.y + o.h/2) / CELL);
          return !(ox === gx && oy === gy);
        });
        if (bd.tee?.gx === gx && bd.tee?.gy === gy) bd.tee = null;
        if (bd.cup?.gx === gx && bd.cup?.gy === gy) bd.cup = null;
        break;
      case 'tee':
        if (bd.cells.has(key)) bd.tee = { gx, gy };
        break;
      case 'cup':
        if (bd.cells.has(key)) bd.cup = { gx, gy };
        break;
      case 'water':
      case 'sand':
        if (bd.cells.has(key)) {
          const c = bd.cells.get(key);
          c.hazard = c.hazard === tool ? null : tool;
        }
        break;
      case 'stone':
        if (bd.cells.has(key))
          bd.obstacles.push({ type:'rect', material:'stone',
            x: cx-20, y: cy-20, w:40, h:40,
            destructible:false, alive:true });
        break;
      case 'wood':
        if (bd.cells.has(key))
          bd.obstacles.push({ type:'rect', material:'wood',
            x: gx*CELL+15, y: cy-11, w: CELL-30, h:22,
            destructible:true, alive:true });
        break;
      case 'bumper':
        if (bd.cells.has(key))
          bd.obstacles.push({ type:'circle', material:'rubber',
            x: cx + rnd(-18,18), y: cy + rnd(-18,18), r:18,
            destructible:false, alive:true });
        break;
      case 'moving':
        if (bd.cells.has(key))
          bd.obstacles.push({ type:'moving', material:'metal',
            x: cx-7, y: gx*CELL+18, w:14, h:CELL-36,
            axis:'x', minPos: gx*CELL+15, maxPos: gx*CELL+CELL-15,
            speed:1.5, dir:1, destructible:false, alive:true });
        break;
    }
    this.builderLevel = this._levelFromBuilder();
  }

  _levelFromBuilder() {
    const bd = this.builderData;
    if (!bd || bd.cells.size === 0) return null;

    const pathArr = [...bd.cells.values()];
    const cellSet = new Set(pathArr.map(p => `${p.gx},${p.gy}`));
    const cells   = pathArr.map(p => ({
      x: p.gx*CELL, y: p.gy*CELL, w: CELL, h: CELL, hazard: p.hazard
    }));
    const walls = [];
    for (const p of pathArr) {
      const wx = p.gx*CELL, wy = p.gy*CELL;
      if (!cellSet.has(`${p.gx-1},${p.gy}`)) walls.push({x1:wx,     y1:wy,      x2:wx,      y2:wy+CELL});
      if (!cellSet.has(`${p.gx+1},${p.gy}`)) walls.push({x1:wx+CELL,y1:wy,      x2:wx+CELL, y2:wy+CELL});
      if (!cellSet.has(`${p.gx},${p.gy-1}`)) walls.push({x1:wx,     y1:wy,      x2:wx+CELL, y2:wy});
      if (!cellSet.has(`${p.gx},${p.gy+1}`)) walls.push({x1:wx,     y1:wy+CELL, x2:wx+CELL, y2:wy+CELL});
    }
    const teePt = bd.tee
      ? { x: bd.tee.gx*CELL + CELL/2, y: bd.tee.gy*CELL + CELL/2 }
      : { x: cells[0].x + CELL/2,     y: cells[0].y + CELL/2 };
    const cupPt = bd.cup
      ? { x: bd.cup.gx*CELL + CELL/2, y: bd.cup.gy*CELL + CELL/2 }
      : { x: cells[cells.length-1].x + CELL/2, y: cells[cells.length-1].y + CELL/2 };

    const minGX = Math.min(...pathArr.map(p => p.gx));
    const maxGX = Math.max(...pathArr.map(p => p.gx));
    const minGY = Math.min(...pathArr.map(p => p.gy));
    const maxGY = Math.max(...pathArr.map(p => p.gy));
    const bounds = { x: minGX*CELL, y: minGY*CELL,
                     w: (maxGX-minGX+1)*CELL, h: (maxGY-minGY+1)*CELL };

    // Fresh copies of obstacles
    const obstacles = bd.obstacles.map(o => ({...o, alive: true}));
    return { cells, walls, obstacles, tee: teePt, cup: cupPt, par: 3, bounds, holeNum: 0 };
  }

  playTestLevel() {
    const lv = this._levelFromBuilder();
    if (!lv || lv.cells.length === 0) { alert('Draw some tiles first, goblin!'); return; }

    document.getElementById('builder-ui').classList.add('hidden');
    document.getElementById('controls-hint').classList.remove('hidden');
    this.isPlayTest = true;
    this.level      = lv;
    this.holeNum    = 0;
    this.strokes    = 0;
    this.sinkAnim   = 0;
    this.inHazard   = false; this.hazardTimer = 0;
    this.splashAnim = 0; this.splashPos = null;
    this.outOfBounds = false; this.frozenTimer = 0;
    this.dragging   = false; this.dragStart = null;
    this.ball = { x: lv.tee.x, y: lv.tee.y, vx:0, vy:0, rolling:false };
    this.lastSafePos = { x: this.ball.x, y: this.ball.y };
    this.shotStartPos = null;

    const z  = this.camera.zoomForBounds(lv.bounds, this.canvas);
    const cx = lv.bounds.x + lv.bounds.w / 2;
    const cy = lv.bounds.y + lv.bounds.h / 2;
    this.camera.snapTo(cx, cy, z);
    this.state = 'overview';
    this.overviewTimer = 120;
    this.bannerTimer   = 0;
    this.hideBanner();
    this.updateHUD();
    this.updatePowerupBar();
  }

  returnToBuilder() {
    this.isPlayTest = false;
    this.hideAllScreens();
    document.getElementById('builder-ui').classList.remove('hidden');
    document.getElementById('controls-hint').classList.add('hidden');
    this.state = 'builder';
    this.builderLevel = this._levelFromBuilder();
    // Re-center camera on the course
    if (this.builderLevel) {
      const z  = this.camera.zoomForBounds(this.builderLevel.bounds, this.canvas);
      const cx = this.builderLevel.bounds.x + this.builderLevel.bounds.w / 2;
      const cy = this.builderLevel.bounds.y + this.builderLevel.bounds.h / 2;
      this.camera.setTarget(cx, cy, z);
    }
  }

  builderSave() {
    const data = {
      cells: [...this.builderData.cells.entries()],
      tee:   this.builderData.tee,
      cup:   this.builderData.cup,
      obstacles: this.builderData.obstacles
    };
    localStorage.setItem('goblingolf_builder', JSON.stringify(data));
    this._builderToast('Level saved! 💾');
  }

  builderLoad() {
    const raw = localStorage.getItem('goblingolf_builder');
    if (!raw) { this._builderToast('Nothing saved yet!'); return; }
    try {
      const data = JSON.parse(raw);
      this.builderData = {
        cells: new Map(data.cells),
        tee:   data.tee,
        cup:   data.cup,
        obstacles: data.obstacles
      };
      this.builderLevel = this._levelFromBuilder();
      this._builderToast('Level loaded! 📂');
    } catch(e) { this._builderToast('Load failed :('); }
  }

  builderNew() {
    this.builderData = {
      cells: new Map(),
      tee: { gx:0, gy:0 },
      cup: { gx:3, gy:0 },
      obstacles: []
    };
    for (let gx = 0; gx < 4; gx++)
      this.builderData.cells.set(`${gx},0`, { gx, gy:0, hazard:null });
    this.builderLevel = this._levelFromBuilder();
  }

  _builderToast(msg) {
    let t = document.getElementById('builder-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'builder-toast';
      t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);' +
        'background:rgba(0,20,0,0.9);border:1px solid #66ff22;color:#aaff66;' +
        'padding:8px 20px;border-radius:20px;font-size:13px;z-index:500;pointer-events:none;transition:opacity 0.4s';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
  }

  // ---- Builder rendering ----
  renderBuilder() {
    const ctx = this.ctx;
    // Dark grid background
    const camL = this.camera.x - this.canvas.width  / (2 * this.camera.zoom);
    const camT = this.camera.y - this.canvas.height / (2 * this.camera.zoom);
    const camR = this.camera.x + this.canvas.width  / (2 * this.camera.zoom);
    const camB = this.camera.y + this.canvas.height / (2 * this.camera.zoom);

    const gxMin = Math.floor(camL / CELL) - 1;
    const gxMax = Math.ceil(camR  / CELL) + 1;
    const gyMin = Math.floor(camT / CELL) - 1;
    const gyMax = Math.ceil(camB  / CELL) + 1;

    // Grid cells (empty slots)
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gy = gyMin; gy <= gyMax; gy++) {
        const s  = this.camera.toScreen(gx*CELL, gy*CELL, this.canvas);
        const sz = CELL * this.camera.zoom;
        const isHover = this.builderHover?.gx === gx && this.builderHover?.gy === gy;
        ctx.fillStyle   = isHover ? 'rgba(80,160,40,0.18)' : 'rgba(10,30,5,0.6)';
        ctx.fillRect(s.x, s.y, sz, sz);
        ctx.strokeStyle = 'rgba(60,120,30,0.25)';
        ctx.lineWidth   = 1;
        ctx.strokeRect(s.x + 0.5, s.y + 0.5, sz - 1, sz - 1);
      }
    }

    // Course tiles
    if (this.builderLevel) {
      this.renderer.drawCells(this.builderLevel.cells);
      this.renderer.drawWalls(this.builderLevel.walls);
      this.renderer.drawObstacles(this.builderLevel.obstacles);
      if (this.builderData.tee) this.renderer.drawTee(this.builderLevel.tee);
      if (this.builderData.cup) this.renderer.drawCup(this.builderLevel.cup, 0);
    }

    // Hover highlight on top
    if (this.builderHover) {
      const { gx, gy } = this.builderHover;
      const s  = this.camera.toScreen(gx*CELL, gy*CELL, this.canvas);
      const sz = CELL * this.camera.zoom;
      ctx.strokeStyle = '#aaff66';
      ctx.lineWidth   = 2;
      ctx.strokeRect(s.x + 1, s.y + 1, sz - 2, sz - 2);
    }

    // Tool label
    const toolLabels = { draw:'✏️ Draw', erase:'🗑️ Erase', tee:'🏌️ Tee',
      cup:'🕳️ Cup', stone:'🪨 Rock', wood:'🪵 Log', bumper:'🔵 Bumper',
      moving:'⬅️ Mover', water:'💧 Water', sand:'🏖️ Sand' };
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(4, this.canvas.height - 32, 160, 28);
    ctx.fillStyle = '#aaff66';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`Tool: ${toolLabels[this.builderTool] || this.builderTool}`, 12, this.canvas.height - 18);

    // Instructions
    ctx.fillStyle = 'rgba(150,220,80,0.35)';
    ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('Left click: place  ·  Right click: remove  ·  Middle drag: pan  ·  Scroll: zoom  ·  Esc: exit', this.canvas.width - 10, this.canvas.height - 18);
  }

  // ---- Animate moving obstacles while aiming (so players can time shots) ----
  updateMovingObstacles() {
    if (this.state !== 'playing' || !this.level || this.frozenTimer > 0) return;
    for (const obs of this.level.obstacles) {
      if (!obs.alive || obs.type !== 'moving') continue;
      if (obs.axis === 'x') {
        obs.x += obs.speed * obs.dir;
        if (obs.x <= obs.minPos || obs.x + obs.w >= obs.maxPos) obs.dir *= -1;
      } else {
        obs.y += obs.speed * obs.dir;
        if (obs.y <= obs.minPos || obs.y + obs.h >= obs.maxPos) obs.dir *= -1;
      }
    }
  }

  // ---- Main loop ----
  // Update order matters: physics before hazard (hazard reads ball pos after physics),
  // fanfare after hazard (fanfare is triggered by sinkBall which runs in physics),
  // camera last so it sees the final ball position for this frame.
  loop() {
    this.updateOverview();
    this.updateMovingObstacles();
    this.updatePhysics();
    this.updateHazard();
    this.updateFanfare();
    this.updateCamera();
    this.particles.update();
    this.render();
    requestAnimationFrame(() => this.loop());
  }
}

// ============================================================
//  BOOT
// ============================================================
const game = new Game();
