/**
 * Picks a random position on the grid that corresponds to a hallway (floor but not in a room).
 * @param {Array<Array<number>>} grid - The maze grid
 * @param {Array} rooms - The list of rooms
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 * @param {number} tileSize - Size of one tile in world units
 * @param {function} rng - Random number generator function
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
  const choice = hallwayTiles[Math.floor(rng() * hallwayTiles.length)];

  // Convert to world coordinates (centered in tile)
  // Logic matches main.js centering: (index - width/2 + 0.5) * tileSize
  return {
    x: (choice.x - width / 2 + 0.5) * tileSize,
    y: 0,
    z: (choice.y - height / 2 + 0.5) * tileSize
  };
}

/**
 * Simple 4-directional BFS to get next step towards a goal on the maze grid.
 * @param {number} startX - Starting grid X
 * @param {number} startY - Starting grid Y
 * @param {number} goalX - Goal grid X
 * @param {number} goalY - Goal grid Y
 * @param {Array<Array<number>>} grid - 2D grid array (row-major: grid[y][x])
 * @param {number} width - Grid width
 * @param {number} height - Grid height
 * @param {Set<string>} blockedPathSet - Set of blocked edges "x1,y1|x2,y2"
 * @returns {{x: number, y: number}|null} - The next grid coordinate to move to, or null if no path/reached.
 */
export function findNextStep(startX, startY, goalX, goalY, grid, width, height, blockedPathSet) {
  if (startX === goalX && startY === goalY) return null;
  const inBounds = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
  const isWalkable = (x, y) => inBounds(x, y) && grid[y][x];

  if (!isWalkable(goalX, goalY)) return null;

  const queue = [];
  const visited = new Array(height);
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 }
  ];

  for (let y = 0; y < height; y++) visited[y] = new Array(width).fill(false);

  queue.push({ x: startX, y: startY });
  visited[startY][startX] = true;

  const parent = new Map();
  const key = (x, y) => `${x},${y}`;

  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === goalX && cur.y === goalY) {
      let cx = goalX;
      let cy = goalY;
      let prev = parent.get(key(cx, cy));
      let last = { x: cx, y: cy };
      while (prev && !(prev.x === startX && prev.y === startY)) {
        last = prev;
        prev = parent.get(key(prev.x, prev.y));
      }
      return last;
    }

    for (const d of dirs) {
      const nx = cur.x + d.dx;
      const ny = cur.y + d.dy;
      if (!isWalkable(nx, ny)) continue;

      // Treat blocked door edges as walls for pathfinding
      if (blockedPathSet && blockedPathSet.has(`${cur.x},${cur.y}|${nx},${ny}`)) continue;

      if (visited[ny][nx]) continue;
      visited[ny][nx] = true;
      parent.set(key(nx, ny), { x: cur.x, y: cur.y });
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

