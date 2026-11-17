import { isPositionInRoom } from './utils.js';

// Neighbour order matters for tie-breaking between equally short paths.
const DIRS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 }
];

/**
 * Converts a grid coordinate to a world position (centered in the tile).
 * Logic matches main.js centering: (index - size/2 + 0.5) * tileSize
 * @param {number} gx - Grid X
 * @param {number} gy - Grid Y
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 * @param {number} tileSize - Size of one tile in world units
 * @returns {{x: number, y: number, z: number}}
 */
export function gridToWorld(gx, gy, width, height, tileSize) {
  return {
    x: (gx - width / 2 + 0.5) * tileSize,
    y: 0,
    z: (gy - height / 2 + 0.5) * tileSize
  };
}

/**
 * Picks a random position on the grid that corresponds to a hallway (floor but not in a room).
 * @param {Array<Array<number>>} grid - The maze grid
 * @param {Array} rooms - The list of rooms
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 * @param {number} tileSize - Size of one tile in world units
 * @param {function} rng - Random number generator function returning [0, 1)
 * @returns {{x: number, y: number, z: number}|null} - World position {x,y,z} or null
 */
export function getRandomHallwayPosition(grid, rooms, width, height, tileSize, rng = Math.random) {
  const hallwayTiles = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!grid[y][x]) continue;
      if (isPositionInRoom(x, y, rooms)) continue;
      hallwayTiles.push({ x, y });
    }
  }

  if (!hallwayTiles.length) return null;

  // Math.min guards against an rng that can return exactly 1
  const index = Math.min(hallwayTiles.length - 1, Math.floor(rng() * hallwayTiles.length));
  const choice = hallwayTiles[index];
  return gridToWorld(choice.x, choice.y, width, height, tileSize);
}

/**
 * Simple 4-directional BFS to get the next step towards a goal on the maze grid.
 * @param {number} startX - Starting grid X
 * @param {number} startY - Starting grid Y
 * @param {number} goalX - Goal grid X
 * @param {number} goalY - Goal grid Y
 * @param {Array<Array<number>>} grid - 2D grid array (row-major: grid[y][x])
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 * @param {Set<string>} [blockedPathSet] - Set of blocked directed edges "x1,y1|x2,y2"
 * @returns {{x: number, y: number}|null} - The next grid coordinate to move to, or null if no path/reached.
 */
export function findNextStep(startX, startY, goalX, goalY, grid, width, height, blockedPathSet) {
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;

  // Out-of-bounds start/goal would otherwise throw on grid/visited access
  if (!inBounds(startX, startY) || !inBounds(goalX, goalY)) return null;
  if (startX === goalX && startY === goalY) return null;
  if (!grid[goalY][goalX]) return null;

  // Flat typed arrays: no per-node objects or string keys, and an O(1) queue
  // (the old Array.shift() was O(n) per dequeue).
  const size = width * height;
  const startIdx = startY * width + startX;
  const goalIdx = goalY * width + goalX;
  const parent = new Int32Array(size).fill(-1);
  const visited = new Uint8Array(size);
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  visited[startIdx] = 1;
  queue[tail++] = startIdx;

  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % width;
    const cy = (cur - cx) / width;

    for (const { dx, dy } of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(nx, ny) || !grid[ny][nx]) continue;

      const next = ny * width + nx;
      if (visited[next]) continue;

      // Treat blocked door edges as walls for pathfinding
      if (blockedPathSet && blockedPathSet.has(`${cx},${cy}|${nx},${ny}`)) continue;

      visited[next] = 1;
      parent[next] = cur;

      if (next === goalIdx) {
        // Walk back until the node whose parent is the start: that's the first step
        let step = next;
        while (parent[step] !== startIdx) step = parent[step];
        return { x: step % width, y: Math.floor(step / width) };
      }
      queue[tail++] = next;
    }
  }
  return null;
}