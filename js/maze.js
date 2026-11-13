import { rand, isPositionInRoom } from "./utils";

/**
 * Maze generator that places rectangular rooms of allowed sizes on a grid.
 * @exports generateRooms(gridW,gridH,roomSizes,count)
 * @returns {{grid, rooms, doors}|null} - Rooms data or null
 */
export function generateRooms(gridW, gridH, roomSizes = [[3, 4], [5, 4], [6, 5], [3, 5]], attempts = 400, targetRooms = 20) {
  const grid = Array.from({ length: gridH }, () => Array(gridW).fill(0));
  const rooms = [];

  // helper to test overlap with padding so rooms are not too close to each other
  const ROOM_PADDING = 2; // tiles of empty space around each room
  function canPlace(x, y, w, h) {
    if (x < ROOM_PADDING || y < ROOM_PADDING || x + w + ROOM_PADDING > gridW || y + h + ROOM_PADDING > gridH) return false;
    for (let j = y - ROOM_PADDING; j < y + h + ROOM_PADDING; j++) {
      for (let i = x - ROOM_PADDING; i < x + w + ROOM_PADDING; i++) {
        if (grid[j][i]) return false;
      }
    }
    return true;
  }

  // place rooms randomly across the map (within padding) instead of biasing to edges
  let placed = 0;
  for (let t = 0; t < attempts && placed < targetRooms; t++) {
    const [rw, rh] = roomSizes[Math.floor(Math.random() * roomSizes.length)];

    const minX = ROOM_PADDING;
    const maxX = gridW - rw - ROOM_PADDING;
    const minY = ROOM_PADDING;
    const maxY = gridH - rh - ROOM_PADDING;
    if (minX > maxX || minY > maxY) continue;

    const x = rand(minX, maxX);
    const y = rand(minY, maxY);

    if (!canPlace(x, y, rw, rh)) continue;
    // write room
    for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) grid[j][i] = 1;
    rooms.push({ x, y, w: rw, h: rh, id: placed });
    placed++;
  }

  // If no rooms, return early
  if (rooms.length === 0) return { grid, rooms, doors: [] };

  // For each room, pick a single perimeter "anchor" tile just outside its wall,
  // carve it into a corridor tile, and store it on the room.
  const anchors = [];
  for (const r of rooms) {
    const candidates = [];

    // top edge neighbors
    for (let dx = 0; dx < r.w; dx++) {
      const rx = r.x + dx;
      const ry = r.y - 1;
      if (ry >= 0 && grid[ry][rx] === 0) candidates.push({ x: rx, y: ry });
    }
    // bottom edge neighbors
    for (let dx = 0; dx < r.w; dx++) {
      const rx = r.x + dx;
      const ry = r.y + r.h;
      if (ry < gridH && grid[ry][rx] === 0) candidates.push({ x: rx, y: ry });
    }
    // left edge neighbors
    for (let dy = 0; dy < r.h; dy++) {
      const ry = r.y + dy;
      const rx = r.x - 1;
      if (rx >= 0 && grid[ry][rx] === 0) candidates.push({ x: rx, y: ry });
    }
    // right edge neighbors
    for (let dy = 0; dy < r.h; dy++) {
      const ry = r.y + dy;
      const rx = r.x + r.w;
      if (rx < gridW && grid[ry][rx] === 0) candidates.push({ x: rx, y: ry });
    }

    if (candidates.length) {
      const chosen = candidates[rand(0, candidates.length - 1)];
      grid[chosen.y][chosen.x] = 1; // carve corridor tile just outside the room
      r.anchor = { x: chosen.x, y: chosen.y };
      anchors.push(r.anchor);
    } else {
      // fallback: if somehow surrounded, just use room center as anchor
      const cx = Math.floor(r.x + r.w / 2);
      const cy = Math.floor(r.y + r.h / 2);
      r.anchor = { x: cx, y: cy };
      anchors.push(r.anchor);
    }
  }

  // Carve corridors between two points.
  // Each corridor has a 1-in-5 chance to be 2 cells wide along its length.
  // Corridors are clean L-shaped paths with only straight segments
  // and single 90-degree turns (no jagged random walks).
  function carveCorridor(x1, y1, x2, y2) {
    let x = x1;
    let y = y1;
    if (x < 0 || x >= gridW || y < 0 || y >= gridH) return;

    // Decide once per corridor if it should be widened to 2 cells,
    // and on which side to widen.
    const widen = Math.random() < 0.5; // Increased chance for wide hallways
    const side = Math.random() < 0.5 ? -1 : 1;

    function carveCell(cx, cy, dir) {
      if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) return;
      grid[cy][cx] = 1;

      if (!widen || !dir) return;

      if (dir === 'H') {
        // widen horizontally carved segment vertically (above or below)
        const wy = cy + side;
        if (wy >= 0 && wy < gridH) {
          grid[wy][cx] = 1;
        }
      } else if (dir === 'V') {
        // widen vertically carved segment horizontally (left or right)
        const wx = cx + side;
        if (wx >= 0 && wx < gridW) {
          grid[cy][wx] = 1;
        }
      }
    }

    // carve starting cell without a direction
    carveCell(x, y, null);

    if (Math.random() < 0.5) { // horizontalFirst
      // move horizontally first, then vertically
      const stepX = x2 > x ? 1 : -1;
      while (x !== x2) {
        x += stepX;
        if (x < 0 || x >= gridW) break;
        carveCell(x, y, 'H');
      }

      const stepY = y2 > y ? 1 : -1;
      while (y !== y2) {
        y += stepY;
        if (y < 0 || y >= gridH) break;
        carveCell(x, y, 'V');
      }
    } else {
      // move vertically first, then horizontally
      const stepY = y2 > y ? 1 : -1;
      while (y !== y2) {
        y += stepY;
        if (y < 0 || y >= gridH) break;
        carveCell(x, y, 'V');
      }

      const stepX = x2 > x ? 1 : -1;
      while (x !== x2) {
        x += stepX;
        if (x < 0 || x >= gridW) break;
        carveCell(x, y, 'H');
      }
    }
  }

  // Connect room anchors with a short-hallway network:
  // build a minimum-spanning-tree over anchors using Manhattan distance,
  // so each room has a single connection into the corridor network,
  // and nearby rooms are preferred (keeping corridors shorter).
  const roomAnchors = rooms.map(r => ({ room: r, x: r.anchor.x, y: r.anchor.y }));
  if (roomAnchors.length > 1) {
    const connected = new Set();
    const remaining = new Set();

    for (let i = 0; i < roomAnchors.length; i++) remaining.add(i);
    connected.add(0);
    remaining.delete(0);

    while (remaining.size) {
      let bestFrom = null;
      let bestTo = null;
      let bestDist = Infinity;

      for (const i of connected) {
        const a = roomAnchors[i];
        for (const j of remaining) {
          const b = roomAnchors[j];
          const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          if (d < bestDist) {
            bestDist = d;
            bestFrom = i;
            bestTo = j;
          }
        }
      }

      if (bestTo === null) break;
      connected.add(bestTo);
      remaining.delete(bestTo);

      const a = roomAnchors[bestFrom];
      const b = roomAnchors[bestTo];
      carveCorridor(a.x, a.y, b.x, b.y);
    }
  }

  // NEW: Add random shortcut hallways to connect midpoints of different long segments
  const longSegments = [];
  // Find horizontal segments > 6
  for (let y = 0; y < gridH; y++) {
    let start = -1;
    for (let x = 0; x < gridW; x++) {
      if (grid[y][x]) {
        if (start === -1) start = x;
      } else {
        if (start !== -1) {
          if (x - start > 6) longSegments.push({ x: start, y, len: x - start, dir: 'H' });
          start = -1;
        }
      }
    }
    if (start !== -1 && gridW - start > 6) longSegments.push({ x: start, y, len: gridW - start, dir: 'H' });
  }
  // Find vertical segments > 6
  for (let x = 0; x < gridW; x++) {
    let start = -1;
    for (let y = 0; y < gridH; y++) {
      if (grid[y][x]) {
        if (start === -1) start = y;
      } else {
        if (start !== -1) {
          if (y - start > 6) longSegments.push({ x, y: start, len: y - start, dir: 'V' });
          start = -1;
        }
      }
    }
    if (start !== -1 && gridH - start > 6) longSegments.push({ x, y: start, len: gridH - start, dir: 'V' });
  }

  // Shuffle segments and connect distant pairs (> 9 cells) to create shortcuts
  const extraLinks = Math.floor(Math.random() * 4) + 4;
  longSegments.sort(() => Math.random() - 0.5);

  let linksAdded = 0;
  for (let i = 0; i < longSegments.length; i++) {
    if (linksAdded >= extraLinks) break;
    const segA = longSegments[i];

    // Search for a partner that is far enough away (> 8-9 cells)
    for (let j = i + 1; j < longSegments.length; j++) {
      const segB = longSegments[j];

      // Get midpoint of each segment
      const mxA = segA.dir === 'H' ? segA.x + Math.floor(segA.len / 2) : segA.x;
      const myA = segA.dir === 'H' ? segA.y : segA.y + Math.floor(segA.len / 2);
      const mxB = segB.dir === 'H' ? segB.x + Math.floor(segB.len / 2) : segB.x;
      const myB = segB.dir === 'H' ? segB.y : segB.y + Math.floor(segB.len / 2);

      const dx = mxA - mxB;
      const dy = myA - myB;

      // Check if hallways are more than 9 cells apart
      if (dx * dx + dy * dy > 81) {
        carveCorridor(mxA, myA, mxB, myB);
        linksAdded++;
        break; // Found a match for segA, move to next
      }
    }
  }

  // NEW: Add 1-2 extra random connectors from hallways directly into rooms
  // This creates occasional loops or second entrances to rooms.
  const extraConnectionCandidates = [];
  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < gridW - 1; x++) {
      if (grid[y][x] !== 0) continue; // must be a wall currently

      const nRoom = isPositionInRoom(x, y - 1, rooms);
      const sRoom = isPositionInRoom(x, y + 1, rooms);
      const wRoom = isPositionInRoom(x - 1, y, rooms);
      const eRoom = isPositionInRoom(x + 1, y, rooms);

      const nHall = grid[y - 1][x] && !nRoom;
      const sHall = grid[y + 1][x] && !sRoom;
      const wHall = grid[y][x - 1] && !wRoom;
      const eHall = grid[y][x + 1] && !eRoom;

      // Check if this wall separates a room from a hall (cardinal directions)
      let isCandidate = false;
      // Horizontal separation (wall is vertical, rooms/halls are E/W)
      if ((wRoom && eHall) || (eRoom && wHall)) isCandidate = true;
      // Vertical separation (wall is horizontal, rooms/halls are N/S)
      if ((nRoom && sHall) || (sRoom && nHall)) isCandidate = true;

      if (isCandidate) extraConnectionCandidates.push({ x, y });
    }
  }

  // Shuffle and pick 1-2 candidates to carve
  if (extraConnectionCandidates.length) {
    const numExtra = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < numExtra; i++) {
      if (!extraConnectionCandidates.length) break;
      const idx = Math.floor(Math.random() * extraConnectionCandidates.length);
      const p = extraConnectionCandidates[idx];
      grid[p.y][p.x] = 1; // carve path
      extraConnectionCandidates.splice(idx, 1);
    }
  }

  // Cleanup: remove isolated 1x1 corridor tiles (not in rooms) that only touch <=1 neighbor floor
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (!grid[y][x]) continue;
      // skip tiles that belong to a room
      if (isPositionInRoom(x, y, rooms)) continue;

      let neighbors = 0;
      const dirs = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0]
      ];
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
        if (grid[ny][nx]) neighbors++;
      }

      // if this corridor tile only touches 0 or 1 floor tiles, it's an isolated 1x1 stub
      if (neighbors <= 1) {
        grid[y][x] = 0;
      }
    }
  }

  // After corridors + cleanup, detect a single entrance per room where the room wall
  // touches a non-room floor (corridor) tile. Every such contact becomes either a
  // door or a solid wall edge so room perimeters are fully closed.
  const doors = [];
  const blockedDoorEdges = [];

  for (let ri = 0; ri < rooms.length; ri++) {
    const r = rooms[ri];
    const candidates = [];

    // top edge (outside is north)
    {
      const yInside = r.y;
      const yOutside = r.y - 1;
      if (yOutside >= 0) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!grid[yInside][x]) continue;
          if (grid[yOutside][x] && !isPositionInRoom(x, yOutside, rooms)) {
            candidates.push({ x, y: yInside, dir: 'N' });
          }
        }
      }
    }

    // bottom edge (outside is south)
    {
      const yInside = r.y + r.h - 1;
      const yOutside = r.y + r.h;
      if (yOutside < gridH) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (!grid[yInside][x]) continue;
          if (grid[yOutside][x] && !isPositionInRoom(x, yOutside, rooms)) {
            candidates.push({ x, y: yInside, dir: 'S' });
          }
        }
      }
    }

    // left edge (outside is west)
    {
      const xInside = r.x;
      const xOutside = r.x - 1;
      if (xOutside >= 0) {
        for (let y = r.y; y < r.y + r.h; y++) {
          if (!grid[y][xInside]) continue;
          if (grid[y][xOutside] && !isPositionInRoom(xOutside, y, rooms)) {
            candidates.push({ x: xInside, y, dir: 'W' });
          }
        }
      }
    }

    // right edge (outside is east)
    {
      const xInside = r.x + r.w - 1;
      const xOutside = r.x + r.w;
      if (xOutside < gridW) {
        for (let y = r.y; y < r.y + r.h; y++) {
          if (!grid[y][xInside]) continue;
          if (grid[y][xOutside] && !isPositionInRoom(xOutside, y, rooms)) {
            candidates.push({ x: xInside, y, dir: 'E' });
          }
        }
      }
    }

    // Group corridor contacts by direction and contiguous hallway segments,
    // then place at most one door per segment; the rest become solid walls.
    if (candidates.length) {
      const byDir = { N: [], S: [], E: [], W: [] };
      for (const c of candidates) {
        byDir[c.dir].push(c);
      }

      function processSegment(seg) {
        if (!seg.length) return;
        const chosen = seg[rand(0, seg.length - 1)];
        doors.push({
          x: chosen.x,
          y: chosen.y,
          dir: chosen.dir,
          room: ri
        });
        for (const other of seg) {
          if (other === chosen) continue;
          blockedDoorEdges.push({
            x: other.x,
            y: other.y,
            dir: other.dir,
            room: ri
          });
        }
      }

      // For N/S walls, contiguous segments are runs of x; for E/W, runs of y.
      for (const dir of ['N', 'S']) {
        const list = byDir[dir];
        if (!list.length) continue;
        list.sort((a, b) => a.x - b.x);
        let seg = [list[0]];
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1];
          const cur = list[i];
          if (cur.x === prev.x + 1) {
            seg.push(cur);
          } else {
            processSegment(seg);
            seg = [cur];
          }
        }
        processSegment(seg);
      }

      for (const dir of ['E', 'W']) {
        const list = byDir[dir];
        if (!list.length) continue;
        list.sort((a, b) => a.y - b.y);
        let seg = [list[0]];
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1];
          const cur = list[i];
          if (cur.y === prev.y + 1) {
            seg.push(cur);
          } else {
            processSegment(seg);
            seg = [cur];
          }
        }
        processSegment(seg);
      }
    }
  }

  // NEW: Add a single 1x1 room (alcove) connected to a hallway.
  // It must be adjacent to a hallway tile, but not a room tile.
  // This room is NOT added to the 'rooms' list, so no notebooks/enemies spawn there.
  let specialRoom = null;
  const candidates = [];

  for (let y = 1; y < gridH - 1; y++) {
    for (let x = 1; x < gridW - 1; x++) {
      if (grid[y][x] !== 0) continue; // must be empty space

      // Check neighbors
      let hallwayNeighbors = 0;
      let isValid = true;
      const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];

      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (grid[ny][nx] !== 0) {
          // neighbor is floor. Is it a room?
          if (isPositionInRoom(nx, ny, rooms)) {
            isValid = false; // Don't attach to a room directly
            break;
          }
          hallwayNeighbors++;
        }
      }

      // Valid if exactly one hallway neighbor (creates a dead-end alcove)
      if (isValid && hallwayNeighbors === 1) candidates.push({ x, y });
    }
  }

  if (candidates.length > 0) {
    const choice = candidates[Math.floor(Math.random() * candidates.length)];
    grid[choice.y][choice.x] = 1;
    specialRoom = { x: choice.x, y: choice.y, w: 1, h: 1 };

    // Find the single hallway neighbor to place a door
    const dirs = [
      { dx: 0, dy: -1, dir: 'N' },
      { dx: 0, dy: 1, dir: 'S' },
      { dx: -1, dy: 0, dir: 'W' },
      { dx: 1, dy: 0, dir: 'E' }
    ];
    for (const d of dirs) {
      const nx = choice.x + d.dx;
      const ny = choice.y + d.dy;
      // Neighbor must be floor and not a room (hallway)
      if (grid[ny][nx] && !isPositionInRoom(nx, ny, rooms)) {
        doors.push({
          x: choice.x,
          y: choice.y,
          dir: d.dir,
          room: -1 // Special ID
        });
        break;
      }
    }
  }

  return { grid, rooms, doors, blockedDoorEdges, specialRoom };
}