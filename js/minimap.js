import * as THREE from 'three';

export default class Minimap {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => object} getState  returns the live game state (see usage below)
   * @param {object} [opts]
   * @param {number|{width:number,height:number}} [opts.size=200]  CSS pixels
   */
  constructor(canvas, getState, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.getState = getState;

    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.staticLayer = document.createElement('canvas');
    this.staticDirty = true;
    this._lastGrid = null;
    this._lastRooms = null;
    this._dir = new THREE.Vector3();

    this.setSize(opts.size ?? 200);
  }

  // ---------- public API ----------

  /** Resize the minimap. Accepts a number (square) or {width, height}, in CSS pixels. */
  setSize(size) {
    const w = typeof size === 'number' ? size : size.width;
    const h = typeof size === 'number' ? size : size.height;
    this.w = Math.max(32, Math.round(w));
    this.h = Math.max(32, Math.round(h));

    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.staticLayer.width = this.canvas.width;
    this.staticLayer.height = this.canvas.height;

    this.invalidate();
  }

  /** Force the floor/room layer to be re-rendered (e.g. after in-place level edits). */
  invalidate() {
    this.staticDirty = true;
  }

  draw() {
    const S = this.getState();
    if (!this.ctx || !S || !S.grid) return;

    // Auto-detect a regenerated level (new grid/rooms array)
    if (S.grid !== this._lastGrid || S.rooms !== this._lastRooms) {
      this._lastGrid = S.grid;
      this._lastRooms = S.rooms;
      this.staticDirty = true;
    }

    const L = this._layout(S);
    const now = S.now;
    const iconBase = Math.max(10, L.s * 1.8);
    const ctx = this.ctx;

    if (this.staticDirty) this._renderStatic(S, L);

    // base
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#070709';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.drawImage(this.staticLayer, 0, 0, this.w, this.h);

    // player position
    const pObj = this._playerObject(S.controls);
    const pp = pObj ? pObj.position : { x: 0, z: 0 };
    const pm = this._toMap(pp.x, pp.z, L, S);
    const gx = Math.floor(pp.x / S.TILE + S.GW / 2);
    const gy = Math.floor(pp.z / S.TILE + S.GH / 2);

    this._drawCurrentRoom(S, L, gx, gy);
    this._drawExits(S, L);
    this._drawNotebooks(S, L, now);
    this._drawNotebookPing(S, L, now);
    this._drawEnemy(S, L, now, iconBase);
    this._drawPlayer(S, L, pm, iconBase);
    this._drawFrame();
  }

  // ---------- layout ----------

  _layout(S) {
    const s = Math.min(this.w / S.GW, this.h / S.GH);
    return { s, offX: (this.w - S.GW * s) / 2, offY: (this.h - S.GH * s) / 2 };
  }

  _toMap(wx, wz, L, S) {
    return {
      x: L.offX + (wx / S.TILE + S.GW / 2) * L.s,
      y: L.offY + (wz / S.TILE + S.GH / 2) * L.s
    };
  }

  _playerObject(controls) {
    if (controls && typeof controls.getObject === 'function') return controls.getObject();
    if (controls && controls.object) return controls.object;
    return null;
  }

  // ---------- static layer ----------

  _renderStatic(S, L) {
    const c = this.staticLayer.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);

    c.fillStyle = '#2e2e33';
    for (let y = 0; y < S.GH; y++) {
      for (let x = 0; x < S.GW; x++) {
        if (S.grid[y] && S.grid[y][x]) {
          c.fillRect(L.offX + x * L.s, L.offY + y * L.s, L.s + 0.5, L.s + 0.5);
        }
      }
    }

    if (Array.isArray(S.rooms)) {
      for (const r of S.rooms) {
        if (!r) continue;
        const rx = L.offX + r.x * L.s, ry = L.offY + r.y * L.s;
        c.fillStyle = '#8a8a92';
        c.fillRect(rx, ry, r.w * L.s, r.h * L.s);
        c.strokeStyle = '#c8c8d0';
        c.lineWidth = 1;
        c.strokeRect(rx + 0.5, ry + 0.5, r.w * L.s - 1, r.h * L.s - 1);
      }
    }
    this.staticDirty = false;
  }

  // ---------- dynamic layers ----------

  _drawCurrentRoom(S, L, gx, gy) {
    if (!Array.isArray(S.rooms)) return;
    for (const r of S.rooms) {
      if (r && gx >= r.x && gx < r.x + r.w && gy >= r.y && gy < r.y + r.h) {
        this.ctx.fillStyle = 'rgba(0, 200, 0, 0.55)';
        this.ctx.fillRect(L.offX + r.x * L.s, L.offY + r.y * L.s, r.w * L.s, r.h * L.s);
        break;
      }
    }
  }

  _drawExits(S, L) {
    if (!Array.isArray(S.exitStates)) return;
    const ctx = this.ctx;
    const size = Math.max(5, L.s * 1.1);
    for (const es of S.exitStates) {
      if (!es || !es.mesh || !es.mesh.position) continue;
      const m = this._toMap(es.mesh.position.x, es.mesh.position.z, L, S);
      ctx.fillStyle = es.collected ? '#ff3b3b' : '#35ff6a';
      ctx.fillRect(m.x - size / 2, m.y - size / 2, size, size);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 1;
      ctx.strokeRect(m.x - size / 2, m.y - size / 2, size, size);
    }
  }

  _drawNotebooks(S, L, now) {
    if (!Array.isArray(S.notebookStates)) return;
    for (let i = 0; i < S.notebookStates.length; i++) {
      const nb = S.notebookStates[i];
      if (!nb || nb.collected || !nb.mesh || !nb.mesh.position) continue;
      const m = this._toMap(nb.mesh.position.x, nb.mesh.position.z, L, S);
      const blink = Math.floor(now * 4 + (i % 3)) % 2 === 0;
      this._icon(S.icons.notebook, blink ? '#ffff66' : '#ffd400',
        m.x, m.y, Math.max(8, L.s * 1.4), blink ? 1 : 0.65);
    }
  }

  _drawNotebookPing(S, L, now) {
    const nb = S.notebookStates && S.notebookStates[S.showNotebookIndex];
    if (!(now < S.showNotebookOnMinimapUntil) || S.showNotebookIndex < 0 || !nb || nb.collected || !nb.mesh || !nb.mesh.position) return;
    const m = this._toMap(nb.mesh.position.x, nb.mesh.position.z, L, S);
    this._pulseRing(m.x, m.y, now, '#00ffff', 6);
    this.ctx.fillStyle = '#00ffff';
    this.ctx.beginPath();
    this.ctx.arc(m.x, m.y, 4, 0, Math.PI * 2);
    this.ctx.fill();
  }

  _drawEnemy(S, L, now, iconBase) {
    const e = S.enemyMesh;
    if (!e || !e.position) return;
    if (!(now < S.showEnemyOnMinimapUntil || S.modBaldiIcon)) return;
    const m = this._toMap(e.position.x, e.position.z, L, S);
    this._pulseRing(m.x, m.y, now, '#ff3030', 7);
    this._icon(S.icons.balder, '#ff0000', m.x, m.y, iconBase); // steady, no blinking
  }

  _drawPlayer(S, L, pm, iconBase) {
    const cam = S.camera;
    if (cam && cam.getWorldDirection) {
      cam.getWorldDirection(this._dir);
      const ang = Math.atan2(this._dir.z, this._dir.x);
      const fov = Math.PI / 3, len = Math.max(18, L.s * 5);
      const g = this.ctx.createRadialGradient(pm.x, pm.y, 0, pm.x, pm.y, len);
      g.addColorStop(0, 'rgba(0,255,128,0.45)');
      g.addColorStop(1, 'rgba(0,255,128,0)');
      this.ctx.fillStyle = g;
      this.ctx.beginPath();
      this.ctx.moveTo(pm.x, pm.y);
      this.ctx.arc(pm.x, pm.y, len, ang - fov / 2, ang + fov / 2);
      this.ctx.closePath();
      this.ctx.fill();
    }
    this._icon(S.icons.player, '#00ff80', pm.x, pm.y, iconBase);
  }

  _drawFrame() {
    const ctx = this.ctx, w = this.w, h = this.h;
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45,
      w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
  }

  // ---------- helpers ----------

  _icon(img, fallbackColor, cx, cy, size, alpha = 1) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (img && img.complete && img.naturalWidth) {
      try { ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size); } catch (e) { }
    } else {
      ctx.fillStyle = fallbackColor;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  _pulseRing(cx, cy, now, color, baseR) {
    const t = (now * 1.5) % 1;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, baseR + t * baseR * 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}