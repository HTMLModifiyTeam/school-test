import { DIRS } from "./utils.js";

/**
 * Room-and-corridor maze generator.
 *
 * Places rectangular rooms on a grid, links them with routed corridors
 * (spanning tree + a few loops), adds extra doors and one dead-end alcove.
 *
 * @param {number} gridW
 * @param {number} gridH
 * @param {number[][]} roomSizes  allowed [w, h] pairs
 * @param {number} attempts       max placement tries per level
 * @param {number} targetRooms    stop placing once this many rooms exist
 * @param {object} [options]
 * @param {number|null} [options.seed=null]      integer seed for reproducible levels
 * @param {number} [options.wideChance=0.5]      chance a corridor is 2 tiles wide
 * @param {number} [options.loopFactor=0.3]      extra loop corridors per room
 * @param {number} [options.maxRetries=8]        regenerate if some room is unreachable
 * @returns {{grid, rooms, doors, blockedDoorEdges, specialRoom}}
 */
export function generateRooms(gridW, gridH, roomSizes = [[3, 4], [5, 4], [6, 5], [3, 5]], attempts = 400, targetRooms = 20, options = {}) {
  const { seed = null, wideChance = 0.5, loopFactor = 0.3, maxRetries = 8 } = options;
  const rng = seed === null ? Math.random : mulberry32(seed);

  // Regenerate until every room is reachable through its doors; keep the best try.
  let best = null;
  for (let i = 0; i < maxRetries; i++) {
    const result = buildLevel(gridW, gridH, roomSizes, attempts, targetRooms, { rng, wideChance, loopFactor });
    if (result.reached === result.total) return result.level;
    if (!best || result.reached > best.reached) best = result;
  }
  return best.level;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const ROOM_PADDING = 2;   // empty tiles required around each room
const TURN_COST = 2;      // discourages zig-zag corridors
const RING_COST = 8;      // discourages hugging a room wall (except at the door)
const PARALLEL_COST = 1;  // discourages new corridors running right beside old ones
const NOISE = 0.5;        // random cost jitter so routes vary

/** Small seedable PRNG (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (a[par][0] <= a[i][0]) break;
      [a[par], a[i]] = [a[i], a[par]];
      i = par;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Level construction
// ---------------------------------------------------------------------------

function buildLevel(gridW, gridH, roomSizes, attempts, targetRooms, { rng, wideChance, loopFactor }) {
  const W = gridW;
  const randInt = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const grid = Array.from({ length: gridH }, () => Array(gridW).fill(0));
  const roomAt = new Int16Array(gridW * gridH).fill(-1);
  const isRoom = (x, y) => x >= 0 && y >= 0 && x < gridW && y < gridH && roomAt[y * W + x] >= 0;
  const rooms = [];

  // ---- 1. Place rooms -----------------------------------------------------
  function canPlace(x, y, w, h) {
    for (let j = y - ROOM_PADDING; j < y + h + ROOM_PADDING; j++) {
      for (let i = x - ROOM_PADDING; i < x + w + ROOM_PADDING; i++) {
        if (grid[j][i]) return false;
      }
    }
    return true;
  }

  for (let t = 0; t < attempts && rooms.length < targetRooms; t++) {
    const [rw, rh] = roomSizes[Math.floor(rng() * roomSizes.length)];
    const maxX = gridW - rw - ROOM_PADDING;
    const maxY = gridH - rh - ROOM_PADDING;
    if (ROOM_PADDING > maxX || ROOM_PADDING > maxY) continue;

    const x = randInt(ROOM_PADDING, maxX);
    const y = randInt(ROOM_PADDING, maxY);
    if (!canPlace(x, y, rw, rh)) continue;

    const id = rooms.length;
    for (let j = y; j < y + rh; j++) {
      for (let i = x; i < x + rw; i++) {
        grid[j][i] = 1;
        roomAt[j * W + i] = id;
      }
    }
    rooms.push({ x, y, w: rw, h: rh, id });
  }

  if (rooms.length === 0) {
    return {
      level: { grid, rooms, doors: [], blockedDoorEdges: [], specialRoom: null },
      reached: 0,
      total: 0,
    };
  }

  // ---- 2. Routing data ----------------------------------------------------
  // `blocked` = map border + every tile touching a room (room tiles + 1-tile ring).
  // Corridors may only enter the ring at "ports" (the tile in front of a wall),
  // so they run 2 tiles from walls and never cut through or hug other rooms.
  const blocked = new Uint8Array(gridW * gridH);
  for (let x = 0; x < gridW; x++) { blocked[x] = 1; blocked[(gridH - 1) * W + x] = 1; }
  for (let y = 0; y < gridH; y++) { blocked[y * W] = 1; blocked[y * W + gridW - 1] = 1; }
  for (const r of rooms) {
    for (let y = r.y - 1; y <= r.y + r.h; y++) {
      for (let x = r.x - 1; x <= r.x + r.w; x++) {
        if (x >= 0 && y >= 0 && x < gridW && y < gridH) blocked[y * W + x] = 1;
      }
    }
  }

  // Ports: tiles just outside each wall, tagged with the outward direction index.
  const ports = rooms.map((r) => {
    const p = [];
    for (let x = r.x; x < r.x + r.w; x++) {
      p.push({ x, y: r.y - 1, d: 0 });
      p.push({ x, y: r.y + r.h, d: 2 });
    }
    for (let y = r.y; y < r.y + r.h; y++) {
      p.push({ x: r.x - 1, y, d: 3 });
      p.push({ x: r.x + r.w, y, d: 1 });
    }
    return p.filter((c) => c.x > 0 && c.y > 0 && c.x < gridW - 1 && c.y < gridH - 1);
  });

  /** Cheapest corridor between two rooms (Dijkstra over cell+heading states). */
  function findPath(ai, bi, reuseCost) {
    const cells = gridW * gridH;
    const open = new Uint8Array(cells);
    const goal = new Uint8Array(cells);
    for (const p of ports[ai]) open[p.y * W + p.x] = 1;
    for (const p of ports[bi]) { open[p.y * W + p.x] = 1; goal[p.y * W + p.x] = 1; }

    const dist = new Float64Array(cells * 4).fill(Infinity);
    const prev = new Int32Array(cells * 4).fill(-1);
    const heap = new MinHeap();

    for (const p of ports[ai]) {
      const s = (p.y * W + p.x) * 4 + p.d;
      const c = grid[p.y][p.x] ? reuseCost : 1;
      if (c < dist[s]) { dist[s] = c; heap.push(c, s); }
    }

    let end = -1;
    while (heap.size) {
      const [d, s] = heap.pop();
      if (d > dist[s]) continue;
      const cell = s >> 2;
      const dir = s & 3;
      if (goal[cell]) { end = s; break; }
      const cx = cell % W;
      const cy = (cell / W) | 0;

      for (let nd = 0; nd < 4; nd++) {
        if (nd === ((dir + 2) & 3)) continue; // no U-turns
        const nx = cx + DIRS[nd].dx;
        const ny = cy + DIRS[nd].dy;
        if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
        const ncell = ny * W + nx;
        if (blocked[ncell] && !open[ncell]) continue;

        let c = rng() * NOISE;
        if (grid[ny][nx]) {
          c += reuseCost;
        } else {
          c += 1;
          // avoid running directly alongside an existing corridor
          for (const q of DIRS) if (grid[ny + q.dy][nx + q.dx]) { c += PARALLEL_COST; break; }
        }
        if (nd !== dir) c += TURN_COST;
        if (open[ncell] && !goal[ncell]) c += RING_COST;

        const ns = ncell * 4 + nd;
        const total = d + c;
        if (total < dist[ns]) { dist[ns] = total; prev[ns] = s; heap.push(total, ns); }
      }
    }
    if (end === -1) return null;

    const path = [];
    for (let s = end; s !== -1; s = prev[s]) {
      const cell = s >> 2;
      path.push({ x: cell % W, y: (cell / W) | 0 });
    }
    return path.reverse();
  }

  function carvePath(path, widen, side) {
    for (let i = 0; i < path.length; i++) {
      const { x, y } = path[i];
      grid[y][x] = 1;
      if (!widen || i === 0 || i === path.length - 1) continue;

      // widen straight stretches only; never widen into rooms/rings/border
      const p = path[i - 1], n = path[i + 1];
      let wx = x, wy = y;
      if (p.y === y && n.y === y) wy = y + side;
      else if (p.x === x && n.x === x) wx = x + side;
      else continue;
      if (!blocked[wy * W + wx]) grid[wy][wx] = 1;
    }
  }

  function connect(i, j, reuseCost, minNewTiles = 0, maxLen = Infinity) {
    const path = findPath(i, j, reuseCost);
    if (!path || path.length > maxLen) return false;
    if (path.filter((c) => !grid[c.y][c.x]).length < minNewTiles) return false;
    carvePath(path, rng() < wideChance, rng() < 0.5 ? -1 : 1);
    if (!rooms[i].anchor) rooms[i].anchor = path[0];
    if (!rooms[j].anchor) rooms[j].anchor = path[path.length - 1];
    return true;
  }

  // ---- 3. Connect rooms ---------------------------------------------------
  const center = rooms.map((r) => ({ x: r.x + (r.w - 1) / 2, y: r.y + (r.h - 1) / 2 }));
  const dist = (i, j) => Math.abs(center[i].x - center[j].x) + Math.abs(center[i].y - center[j].y);
  const pairKey = (i, j) => (i < j ? `${i}-${j}` : `${j}-${i}`);

  // Spanning tree (Prim) guarantees every room is linked.
  const inTree = new Set([0]);
  const treePairs = new Set();
  while (inTree.size < rooms.length) {
    let bi = -1, bj = -1, bd = Infinity;
    for (const i of inTree) {
      for (let j = 0; j < rooms.length; j++) {
        if (inTree.has(j)) continue;
        const d = dist(i, j);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    inTree.add(bj);
    treePairs.add(pairKey(bi, bj));
    connect(bi, bj, 0.35);
  }

  // Loops: link a few nearby, not-yet-linked room pairs so the map isn't a pure tree.
  const loopCandidates = new Map();
  for (let i = 0; i < rooms.length; i++) {
    const nearest = rooms.map((_, j) => j).filter((j) => j !== i).sort((a, b) => dist(i, a) - dist(i, b)).slice(0, 2);
    for (const j of nearest) {
      const k = pairKey(i, j);
      if (!treePairs.has(k) && !loopCandidates.has(k)) loopCandidates.set(k, [Math.min(i, j), Math.max(i, j)]);
    }
  }
  let loopsLeft = Math.round(rooms.length * loopFactor);
  for (const [a, b] of shuffle([...loopCandidates.values()])) {
    if (loopsLeft <= 0) break;
    if (connect(a, b, 1, 3, 45)) loopsLeft--;
  }

  // Rooms with no corridor (single-room levels) fall back to their center.
  for (const r of rooms) {
    if (!r.anchor) r.anchor = { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
  }

  // ---- 4. Extra doors: punch through the 1-tile gap between a room and a passing hall
  const extra = [];
  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < gridW - 1; x++) {
      if (grid[y][x]) continue;
      const nHall = grid[y - 1][x] && !isRoom(x, y - 1);
      const sHall = grid[y + 1][x] && !isRoom(x, y + 1);
      const wHall = grid[y][x - 1] && !isRoom(x - 1, y);
      const eHall = grid[y][x + 1] && !isRoom(x + 1, y);
      if (
        (isRoom(x - 1, y) && eHall) || (isRoom(x + 1, y) && wHall) ||
        (isRoom(x, y - 1) && sHall) || (isRoom(x, y + 1) && nHall)
      ) extra.push({ x, y });
    }
  }
  shuffle(extra);
  for (let i = 0, n = randInt(1, 2); i < n && i < extra.length; i++) grid[extra[i].y][extra[i].x] = 1;

  // ---- 5. Cleanup: remove dead-end stubs left by widening ------------------
  for (let changed = true; changed;) {
    changed = false;
    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        if (!grid[y][x] || isRoom(x, y)) continue;
        let n = 0;
        for (const q of DIRS) {
          const nx = x + q.dx, ny = y + q.dy;
          if (nx >= 0 && ny >= 0 && nx < gridW && ny < gridH && grid[ny][nx]) n++;
        }
        if (n <= 1) { grid[y][x] = 0; changed = true; }
      }
    }
  }

  // ---- 6. Doors -----------------------------------------------------------
  // Every spot where a corridor touches a room wall is either the one door for that
  // contiguous contact run, or a solid wall edge (blockedDoorEdges).
  const doors = [];
  const blockedDoorEdges = [];
  const doorKeys = new Set();

  const sideCells = (r, dir) => {
    const cells = [];
    if (dir === 'N') for (let x = r.x; x < r.x + r.w; x++) cells.push({ x, y: r.y });
    if (dir === 'S') for (let x = r.x; x < r.x + r.w; x++) cells.push({ x, y: r.y + r.h - 1 });
    if (dir === 'W') for (let y = r.y; y < r.y + r.h; y++) cells.push({ x: r.x, y });
    if (dir === 'E') for (let y = r.y; y < r.y + r.h; y++) cells.push({ x: r.x + r.w - 1, y });
    return cells;
  };

  for (const r of rooms) {
    for (const q of DIRS) {
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const pick = run[randInt(0, run.length - 1)];
        doors.push({ x: pick.x, y: pick.y, dir: q.dir, room: r.id });
        doorKeys.add(`${pick.x},${pick.y},${q.dir}`);
        for (const c of run) if (c !== pick) blockedDoorEdges.push({ x: c.x, y: c.y, dir: q.dir, room: r.id });
        run = [];
      };
      for (const c of sideCells(r, q.dir)) {
        const ox = c.x + q.dx, oy = c.y + q.dy;
        const touches = ox >= 0 && oy >= 0 && ox < gridW && oy < gridH && grid[oy][ox] && !isRoom(ox, oy);
        if (touches) run.push(c); else flush();
      }
      flush();
    }
  }

  // ---- 7. Validate: can every room be reached through doors only? ----------
  const seen = new Uint8Array(gridW * gridH);
  const stack = [[rooms[0].x, rooms[0].y]];
  seen[rooms[0].y * W + rooms[0].x] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    const here = isRoom(x, y);
    for (let i = 0; i < 4; i++) {
      const q = DIRS[i];
      const nx = x + q.dx, ny = y + q.dy;
      if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) continue;
      if (!grid[ny][nx] || seen[ny * W + nx]) continue;
      const there = isRoom(nx, ny);
      if (here && !there && !doorKeys.has(`${x},${y},${q.dir}`)) continue;
      if (!here && there && !doorKeys.has(`${nx},${ny},${DIRS[(i + 2) & 3].dir}`)) continue;
      seen[ny * W + nx] = 1;
      stack.push([nx, ny]);
    }
  }
  const reached = rooms.filter((r) => seen[r.y * W + r.x]).length;

  // ---- 8. One dead-end alcove (not a "room": no spawns) --------------------
  // Must be a clean notch: exactly one hallway neighbour, nothing else nearby,
  // and not touching any room wall.
  let specialRoom = null;
  const alcoves = [];
  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < gridW - 1; x++) {
      if (grid[y][x] || blocked[y * W + x]) continue;
      let hall = null, count = 0, ok = true;
      for (const q of DIRS) {
        if (!grid[y + q.dy][x + q.dx]) continue;
        if (isRoom(x + q.dx, y + q.dy)) { ok = false; break; }
        hall = q;
        count++;
      }
      if (!ok || count !== 1) continue;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && grid[y + dy][x + dx] && dx * hall.dx + dy * hall.dy <= 0) { ok = false; break; }
        }
      }
      if (ok) alcoves.push({ x, y, hall });
    }
  }
  if (alcoves.length) {
    const a = alcoves[randInt(0, alcoves.length - 1)];
    grid[a.y][a.x] = 1;
    specialRoom = { x: a.x, y: a.y, w: 1, h: 1 };
    doors.push({ x: a.x, y: a.y, dir: a.hall.dir, room: -1 });
  }

  return {
    level: { grid, rooms, doors, blockedDoorEdges, specialRoom },
    reached,
    total: rooms.length,
  };
}