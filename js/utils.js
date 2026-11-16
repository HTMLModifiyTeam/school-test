import * as THREE from 'three';

export const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;

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

export function pointTex(tex, wrap) {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  if (wrap) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.generateMipmaps = false;
  return tex;
}