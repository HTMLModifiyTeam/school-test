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

  constructor(config, { root = 'audio' } = {}) {
    this.#config = config;
    this.#root = root;
  }

  // Loads everything in parallel, resolves with the cache object
  async load() {
    const jobs = [];

    for (const key in this.#config) {
      this.#cache[key] = {};

      for (const { name, snd, loop, vol } of AudioCache.#getEntries(this.#config[key])) {
        const src = `${this.#root}/${key}/${snd}`;

        if (name in this.#cache[key]) throw new Error(`Duplicate audio name: ${key}/${name}`);
        this.#cache[key][name] = null; // reserve the name (detects duplicates)

        jobs.push(AudioCache.#loadAudio(src, loop, vol).then(audio => (this.#cache[key][name] = audio)));
      }
    }

    await Promise.all(jobs);
    return this.#cache;
  }

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

  // Restarts the sound from the beginning
  play(category, name) {
    const audio = this.get(category, name);
    audio.currentTime = 0;
    return audio.play();
  }

  stop(category, name) {
    const audio = this.get(category, name);
    audio.pause();
    audio.currentTime = 0;
  }

  stopAll() {
    for (const key in this.#cache) {
      for (const audio of Object.values(this.#cache[key])) {
        audio.pause();
        audio.currentTime = 0;
      }
    }
  }

  // Stops and releases every sound
  dispose() {
    this.stopAll();
    for (const key in this.#cache) {
      for (const audio of Object.values(this.#cache[key])) {
        audio.removeAttribute('src');
        audio.load();
      }
    }
    this.#cache = {};
  }

  static #loadAudio(src, loop, vol) {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.loop = loop;
      audio.volume = vol;
      audio.addEventListener('loadeddata', () => resolve(audio), { once: true });
      audio.addEventListener('error', () => reject(new Error(`Failed to load: ${src}`)), { once: true });
      audio.src = src;
      audio.load();
    });
  }

  // Normalizes every entry to [{ name, snd, loop, vol }]
  // name = file name without folder or extension ('door/close.mp3' -> 'close')
  static #getEntries(entries) {
    return entries.map(({ snd, loop = false, vol = 1 }) => ({
      name: snd.split('/').pop().replace(/\.[^.]+$/, ''),
      snd,
      loop: !!loop,
      vol
    }));
  }
}