import * as THREE from 'three';
import { pointTex } from './utils.js';

export class ImageCache {
  #config;
  #root;
  #ext;
  #textureKeys;
  #textureLoader = new THREE.TextureLoader();
  #cache = {};

  constructor(config, { root = 'images', ext = 'png', textureKeys = ['textures', 'posters'] } = {}) {
    this.#config = config;
    this.#root = root;
    this.#ext = ext;
    this.#textureKeys = new Set(textureKeys);
  }

  // Loads everything in parallel, resolves with the cache object
  async load() {
    const jobs = [];

    for (const key in this.#config) {
      this.#cache[key] = {};
      const asTexture = this.#textureKeys.has(key);

      for (const { name, wrap } of ImageCache.#getEntries(this.#config[key])) {
        const src = `${this.#root}/${key}/${name}.${this.#ext}`;
        jobs.push(asTexture ? this.#textureLoader.loadAsync(src).then(tex => this.#cache[key][name] = pointTex(tex, wrap)) : ImageCache.#loadImage(src).then(img => this.#cache[key][name] = img));
      }
    }

    await Promise.all(jobs);
    return this.#cache;
  }

  // cache.get('characters', 'bob')
  get(category, name) {
    const item = this.#cache[category]?.[name];
    if (!item) throw new Error(`Not cached: ${category}/${name}`);
    return item;
  }

  // Whole category, e.g. cache.category('textures')
  category(category) {
    if (!this.#cache[category]) throw new Error(`Unknown category: ${category}`);
    return this.#cache[category];
  }

  get all() {
    return this.#cache;
  }

  // Free GPU memory for all textures
  dispose() {
    for (const key of this.#textureKeys) {
      for (const tex of Object.values(this.#cache[key] ?? {})) tex.dispose();
    }
    this.#cache = {};
  }

  static #loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Failed to load: ${src}`));
      img.src = src;
    });
  }

  // Normalizes every entry shape to [{ name, wrap }]
  static #getEntries(entry) {
    if (!Array.isArray(entry)) {
      return Array.from({ length: entry.count }, (_, i) => ({
        name: `${entry.prefix}${i + 1}`,
        wrap: false
      }));
    }
    return entry.map(e =>
      typeof e === 'string' ? { name: e, wrap: false } : { name: e.tex, wrap: !!e.wrap }
    );
  }
}

export class AudioCache {
  #config;
  #root;
  #cache = {};
  #playing = new Set();

  constructor(config, { root = 'audio' } = {}) {
    this.#config = config;
    this.#root = root;
  }

  // Loads everything in parallel, resolves with the cache object
  async load() {
    const jobs = [];

    for (const key in this.#config) {
      this.#cache[key] = {};

      for (const { snd, loop = false, vol = 1 } of this.#config[key]) {
        const name = AudioCache.#getName(snd);
        // files live in <root>/<category>/..., unless snd already includes the folder (e.g. 'door/open.mp3')
        const path = snd.startsWith(`${key}/`) ? snd : `${key}/${snd}`;
        const src = `${this.#root}/${path}`;
        jobs.push(AudioCache.#loadAudio(src, loop).then(audio => this.#cache[key][name] = { audio, loop, vol }));
      }
    }

    await Promise.all(jobs);
    return this.#cache;
  }

  // cache.get('sfx', 'soda') -> { audio, loop, vol }
  get(category, name) {
    const item = this.#cache[category]?.[name];
    if (!item) throw new Error(`Not cached: ${category}/${name}`);
    return item;
  }

  // Whole category, e.g. cache.category('music')
  category(category) {
    if (!this.#cache[category]) throw new Error(`Unknown category: ${category}`);
    return this.#cache[category];
  }

  get all() {
    return this.#cache;
  }

  // One-shots are cloned so they can overlap; loops use the single shared element
  play(category, name, volume = 1, atFirst = false) {
    const { audio, loop, vol } = this.get(category, name);
    const v = Math.min(1, vol * volume);

    if (loop) {
      audio.volume = v;
      if (atFirst) audio.currentTime = 0;
      if (audio.paused) audio.play().catch(() => { });
      return audio;
    }

    const clone = audio.cloneNode(true);
    clone.volume = v;
    this.#playing.add(clone);
    const done = () => this.#playing.delete(clone);
    clone.addEventListener('ended', done, { once: true });
    if (atFirst) clone.currentTime = 0;
    clone.play().catch(done);
    return clone;
  }

  // cache.playRandom('jumpscares')
  playRandom(category, volume = 1) {
    const names = Object.keys(this.category(category));
    return this.play(category, names[(Math.random() * names.length) | 0], volume);
  }

  stop(category, name, paused = false) {
    const { audio } = this.get(category, name);
    audio.pause();
    if (!paused) audio.currentTime = 0;
    for (const clone of this.#playing) {
      if (clone.src === audio.src) {
        clone.pause();
        this.#playing.delete(clone);
      }
    }
  }
  
  paused(category, name) {
    const { audio } = this.get(category, name);
    return audio.paused;
  }

  stopAll(paused = false) {
    for (const key in this.#cache) {
      for (const name in this.#cache[key]) this.stop(key, name, paused);
    }
  }

  // Release audio resources
  dispose() {
    this.stopAll();
    for (const key in this.#cache) {
      for (const { audio } of Object.values(this.#cache[key])) {
        audio.removeAttribute('src');
        audio.load();
      }
    }
    this.#cache = {};
  }

  static #loadAudio(src, loop) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.loop = loop;
      audio.addEventListener('canplaythrough', () => resolve(audio), { once: true });
      audio.addEventListener('error', () => reject(new Error(`Failed to load: ${src}`)), { once: true });
      audio.src = src;
      audio.load();
    });
  }

  // 'door/open.mp3' -> 'open'
  static #getName(snd) {
    const file = snd.split('/').pop();
    const dot = file.lastIndexOf('.');
    return dot === -1 ? file : file.slice(0, dot);
  }
}