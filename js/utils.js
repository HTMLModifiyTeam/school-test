import * as THREE from 'three';

export const DIRS = [
  { dx: 0, dy: -1, dir: 'N' },
  { dx: 1, dy: 0, dir: 'E' },
  { dx: 0, dy: 1, dir: 'S' },
  { dx: -1, dy: 0, dir: 'W' },
];

export const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

/** Small seedable PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Checks if a grid coordinate lies within any of the defined rooms.
 * @param {number} x - Grid X
 * @param {number} y - Grid Y
 * @param {Array<{x:number, y:number, w:number, h:number}>} rooms - List of rooms
 * @returns {Object|undefined} The room object if found, otherwise undefined.
 */
export function isPositionInRoom(x, y, rooms) {
  return rooms.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

export function pointTex(tex, wrap = false) {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  if (wrap) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.generateMipmaps = false;
  return tex;
}