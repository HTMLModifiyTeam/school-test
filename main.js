import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { generateRooms } from './js/maze.js';
import { findNextStep, isPositionInRoom, getRandomHallwayPosition } from './js/pathfinding.js';

const canvas = document.getElementById('c');

// Scene, camera, and controls must exist before we configure the renderer
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
scene.fog = new THREE.Fog(0xffffff, 2, 35);

// Camera and controls
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0, 1.6, 0);
const controls = new PointerLockControls(camera, canvas);

// renderer and render mode state
let renderer = new THREE.WebGLRenderer({ canvas });
// RNG state
let rng = Math.random;
let seedStr = "";
let seedInputActive = false;
const seedInputHidden = document.getElementById('seedInputHidden');

// NEW: Store current active seed for display
let currentActiveSeed = 0;

// NEW: level-generation toggles exposed globally so spawnExits / checkNotebookCompletion can use them
let genMaxExits = 4;
let genCorruptMaze = false;

// render mode state: load from storage (default true)
const savedHd = localStorage.getItem('rooms_maze_hd');
let isHdMode = savedHd === null ? true : (savedHd === 'true');
// target frame delta (will be adjusted by render mode)
let targetDelta = 1 / 60;

// apply renderer settings based on current mode
function applyRenderMode() {
  // resolution: lower for performance, higher for HD
  const basePixelRatio = Math.min(2, window.devicePixelRatio);
  const scale = isHdMode ? 1.0 : 0.7;
  renderer.setPixelRatio(basePixelRatio * scale);
  renderer.setSize(innerWidth, innerHeight);

  // Precompile shaders for the current scene/camera to avoid first-look stutters
  renderer.compile(scene, camera);

  // fps lock: 25 for performance (authentic), ~60 for HD
  targetDelta = isHdMode ? 1 / 60 : 1 / 25;
}

// initialize renderer in performance mode
applyRenderMode();

// get pause overlay and win overlay elements
const pauseOverlay = document.getElementById('pauseOverlay');
const winOverlay = document.getElementById('winOverlay');
// NEW: Pause restart button
const pauseRestartBtn = document.getElementById('pauseRestartBtn');

// NEW: Info displays
const seedDisplayEl = document.getElementById('seedDisplay');
const difficultyDisplayEl = document.getElementById('difficultyDisplay');
const restartConfirmEl = document.getElementById('restartConfirm');

// inventory DOM elements
const inventoryEl = document.getElementById('inventory');
const useItemButtonEl = document.getElementById('useItemButton');
// exclude the use button from the general slot list so indexing remains 0-2
const invSlotEls = inventoryEl ? Array.from(inventoryEl.querySelectorAll('.inv-slot:not(#useItemButton)')) : [];
const invIconEls = inventoryEl ? Array.from(inventoryEl.querySelectorAll('.inv-icon')) : [];

// NEW: grab mobile controls DOM elements
const pauseButtonEl = document.getElementById('pauseButton');
const lookBehindButtonEl = document.getElementById('lookBehindButton');
const baldicatorEl = document.getElementById('baldicator');
let baldicatorTimeout = null;
const joystickEl = document.getElementById('joystick');
const joystickBaseEl = document.getElementById('joystick-base');
const joystickStickEl = document.getElementById('joystick-stick');

// NEW: stamina DOM
const staminaBarEl = document.getElementById('staminaBar');
const maxStamina = 100;
let currentStamina = 100;
// global points currency (persisted)
let points = 0;

// Points HUD elements and animation helpers
const pointsContainerEl = document.getElementById('pointsContainer');
const pointsMainEl = document.getElementById('pointsMain');
const pointsFloatingEl = document.getElementById('pointsFloating');

// ensure elements exist (they are added in index.html)
if (pointsContainerEl) pointsContainerEl.style.display = 'block';
if (pointsMainEl) pointsMainEl.textContent = `points: ${points}`;

/**
 * Show animated +N floating text then glide it down to the main points element and
 * animate the numeric counter up to the new total.
 * deltaCount: integer number of points earned (positive)
 */
function showPointsEarned(deltaCount = 1) {
  if (!pointsFloatingEl || !pointsMainEl) return;
  const plusText = deltaCount >= 0 ? `+${deltaCount}` : `${deltaCount}`;
  pointsFloatingEl.textContent = plusText;
  // reset classes to start
  pointsFloatingEl.classList.remove('hide');
  pointsFloatingEl.style.transition = 'none';
  pointsFloatingEl.style.opacity = '0';
  // force reflow
  void pointsFloatingEl.offsetWidth;

  // show it (fade in quickly)
  pointsFloatingEl.style.transition = '';
  pointsFloatingEl.classList.add('show');

  // after 0.5s start gliding down (transition already set to 0.9s in CSS)
  setTimeout(() => {
    // add class that moves it to overlap main element (CSS .show already does this)
    pointsFloatingEl.classList.add('show');

    // once glide finishes (~0.9s), fade and trigger numeric increment animation
    const glideDuration = 900;
    setTimeout(() => {
      // start counting up displayed number from previous to new
      const prev = parseInt(pointsMainEl.dataset.displayed || String(pointsMainEl.textContent.replace(/[^0-9-]/g, '')), 10) || 0;
      const target = prev + deltaCount;
      const start = performance.now();
      const duration = 420; // fast count-up
      function step(now) {
        const t = Math.min(1, (now - start) / duration);
        const eased = t; // linear is fine here for rapid increase
        const value = Math.floor(prev + (target - prev) * eased);
        pointsMainEl.textContent = `points: ${value}`;
        pointsMainEl.dataset.displayed = String(value);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          // done: ensure exact target
          pointsMainEl.textContent = `points: ${target}`;
          pointsMainEl.dataset.displayed = String(target);
          // hide floating text with small fade
          pointsFloatingEl.classList.remove('show');
          pointsFloatingEl.classList.add('hide');
          setTimeout(() => {
            pointsFloatingEl.classList.remove('hide');
            pointsFloatingEl.textContent = '';
          }, 400);
        }
      }
      requestAnimationFrame(step);
    }, glideDuration);
  }, 500);
}

if (navigator.maxTouchPoints > 0) {
  if (pauseButtonEl) pauseButtonEl.style.display = 'block';
  if (lookBehindButtonEl) lookBehindButtonEl.style.display = 'flex';
  if (joystickEl) joystickEl.style.display = 'block';
}

// NEW: global game state flags
let darkModeApplied = false;
let darkModeSpeedBonus = 0;
let isPaused = false;
const pausedLook = new THREE.Euler();
let isGameOver = false;
let isGameWon = false;
let isMainMenu = true;
// NEW: input buffer to prevent interaction during load
let inputReady = false;
// NEW: debug mode
let sweepImmunityUntil = 0;

// --- Mod Menu Flags ---
let modInvincible = false;
let modSuperSpeed = false;
let modInfItems = false;
let modInfStamina = false;
let modBaldiIcon = false;
let modPrincipalIgnore = false;
// Prevent bully (Bob) from stealing player's inventory
let modBullyNoSteal = false;
let modNoDarkness = false;
let modAutoplay = false; // experimental: AI-driven player movement to notebooks/exits
let modNoclip = false;

// expose simple toggles from the DOM (connected after DOM ready)
function setupModMenuBindings() {
  const menu = document.getElementById('modMenu');
  const inv = document.getElementById('modInvincible');
  const spd = document.getElementById('modSuperSpeed');
  const infIt = document.getElementById('modInfItems');
  const infSt = document.getElementById('modInfStamina');
  const bal = document.getElementById('modBaldiIcon');

  if (inv) inv.addEventListener('change', () => { modInvincible = !!inv.checked; });
  if (spd) spd.addEventListener('change', () => { modSuperSpeed = !!spd.checked; });
  if (infIt) infIt.addEventListener('change', () => { modInfItems = !!infIt.checked; });
  if (infSt) infSt.addEventListener('change', () => { modInfStamina = !!infSt.checked; });
  if (bal) bal.addEventListener('change', () => { modBaldiIcon = !!bal.checked; });

  // NEW: noclip checkbox binding
  const noclipChk = document.getElementById('modNoclip');
  if (noclipChk) {
    noclipChk.checked = !!modNoclip;
    noclipChk.addEventListener('change', (e) => {
      e.stopPropagation();
      modNoclip = !!noclipChk.checked;
    });
  }

  // NEW: autoplay checkbox binding (experimental)
  const autoplayChk = document.getElementById('modAutoplay');
  if (autoplayChk) {
    autoplayChk.checked = !!modAutoplay;
    autoplayChk.addEventListener('change', (e) => {
      e.stopPropagation();
      modAutoplay = !!autoplayChk.checked;
      // disable pointer lock while autoplay to keep UI stable
      if (modAutoplay) try { controls.unlock(); } catch (err) { }
    });
  }

  // NEW: Principal ignore binding
  const principalIgnoreChk = document.getElementById('modPrincipalIgnore');
  if (principalIgnoreChk) {
    principalIgnoreChk.checked = !!modPrincipalIgnore;
    principalIgnoreChk.addEventListener('change', (e) => {
      e.stopPropagation();
      modPrincipalIgnore = !!principalIgnoreChk.checked;
    });
  }

  // NEW: Bully doesn't steal binding (prevents Bob from stealing inventory)
  const bullyNoStealChk = document.getElementById('modBullyNoSteal');
  if (bullyNoStealChk) {
    bullyNoStealChk.checked = !!modBullyNoSteal;
    bullyNoStealChk.addEventListener('change', (e) => {
      e.stopPropagation();
      modBullyNoSteal = !!bullyNoStealChk.checked;
    });
  }

  // NEW: item spawn and utility controls
  const itemSelect = document.getElementById('modItemSelect');
  const getItemBtn = document.getElementById('modGetItemBtn');
  const tpNotebooksBtn = document.getElementById('modTpNotebooksBtn');
  const noDarkChk = document.getElementById('modNoDarkBtn');
  const nextLevelBtn = document.getElementById('modNextLevelBtn');

  function spawnSelectedItemNearPlayer(type) {
    if (!type) return;
    // map type => material
    const map = {
      blue_soda: blueSodaMat,
      purple_chocolate: purpleChocolateMat,
      walkie_talkie: walkieTalkieMat,
      wd40: wd40Mat,
      old_boots: oldBootsMat,
      point_orange: orangePointMat,
      point_green: greenPointMat,
      point_pink: pinkPointMat,
      point_mega: megaPointMat
    };
    const mat = map[type] || blueSodaMat;
    const size = 0.8;
    const geom = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geom, mat);
    const playerPos = controls.getObject().position.clone();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0;
    if (dir.lengthSq() === 0) dir.set(0, 0, -1);
    dir.normalize();
    mesh.position.set(playerPos.x + dir.x * 1.2, wallHeight / 2, playerPos.z + dir.z * 1.2);
    mesh.userData.type = type;
    itemGroup.add(mesh);
    itemStates.push({ mesh, type, roomIndex: null, baseY: wallHeight / 2 });
    // immediate HUD feedback
    try { notebookPickupSound.currentTime = 0; notebookPickupSound.play(); } catch (e) { }
  }

  if (getItemBtn) {
    getItemBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = itemSelect ? itemSelect.value : 'blue_soda';
      spawnSelectedItemNearPlayer(sel);
    });
  }

  if (tpNotebooksBtn) {
    tpNotebooksBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = controls.getObject().position.clone();
      let offset = 0;
      for (const nb of notebookStates) {
        if (!nb) continue;
        // teleport only uncollected ones
        if (!nb.collected) {
          offset += 0.35;
          nb.mesh.position.set(p.x + (Math.random() - 0.5) * 0.6, nb.baseY, p.z + offset);
          nb.mesh.visible = true;
        }
      }
      // ensure counter and visuals update
      updateNotebookCounter();
      try { walkieTalkieBeepSound.currentTime = 0; walkieTalkieBeepSound.play(); } catch (e) { }
    });
  }

  if (noDarkChk) {
    noDarkChk.checked = !!modNoDarkness;
    noDarkChk.addEventListener('change', (e) => {
      e.stopPropagation();
      modNoDarkness = !!noDarkChk.checked;
      if (modNoDarkness) {
        scene.fog.color.setHex(0xffffff);
        scene.background = new THREE.Color(0xffffff);
      }
    });
  }

  if (nextLevelBtn) {
    nextLevelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      try {
        triggerWin();
      } catch (err) {
        console.warn('next level button failed to trigger:', err);
      }
    });
  }
}

// Toggle menu with backtick (`) key
document.addEventListener('keydown', (e) => {
  if (e.key === '`') {
    const menu = document.getElementById('modMenu');
    if (!menu) return;
    if (menu.style.display === 'none' || menu.style.display === '') {
      menu.style.display = 'block';
      // focus first checkbox for accessibility
      const cb = menu.querySelector('input[type="checkbox"]');
      if (cb) cb.focus();
      setupModMenuBindings();
    } else {
      menu.style.display = 'none';
    }
    e.preventDefault();
  }
});

// NEW: Difficulty settings
const difficulties = ['easy', 'peaceful', 'normal', 'hard', 'nightmare'];
const savedDiff = localStorage.getItem('rooms_maze_difficulty');
let currentDifficulty = (savedDiff && difficulties.includes(savedDiff)) ? savedDiff : 'normal';
const diffSettings = {
  easy: { color: '#00ff00', speedInc: 0.15, darkBonus: 0.9, spawnAt: 4, itemChance: 1.0, staminaNotebookFactor: 0.06, baseSpeedMult: 1.0, fog: 0xffffff, darkFog: 0x000000 },
  peaceful: { color: '#00cccc', speedInc: 0.0, darkBonus: 0.0, spawnAt: -1, itemChance: 1.0, staminaNotebookFactor: 0.06, baseSpeedMult: 1.0, fog: 0xffffff, darkFog: 0x000000 },
  normal: { color: '#ffaa00', speedInc: 0.3, darkBonus: 1.0, spawnAt: 0, itemChance: 1.0, staminaNotebookFactor: 0.06, baseSpeedMult: 1.0, fog: 0xffffff, darkFog: 0x000000 },
  hard: { color: '#ff0000', speedInc: 0.4, darkBonus: 1.5, spawnAt: 0, itemChance: 0.6, staminaNotebookFactor: 0.03, baseSpeedMult: 1.0, fog: 0xffffff, darkFog: 0x000000 },
  nightmare: { color: '#8800ff', speedInc: 0.5, darkBonus: 1.5, spawnAt: 0, itemChance: 0.1, staminaNotebookFactor: 0.06, baseSpeedMult: 1.5, fog: 0x5500aa, darkFog: 0x1a0033 }
};

// NEW: Look Behind State
let isLookingBehind = false;
const lookBehindBaseRotation = new THREE.Euler();

// NEW: helper to toggle pause state (shared by keyboard and button)
function togglePause() {
  isPaused = !isPaused;
  if (isPaused) {
    pausedLook.copy(camera.rotation);
  } else {
    lastFrameTime = performance.now() * 0.001;
  }
  if (pauseOverlay) {
    pauseOverlay.style.display = isPaused ? 'flex' : 'none';
    // Reset restart button state when opening/closing pause menu
    if (pauseRestartBtn) {
      pauseRestartBtn.textContent = 'restart';
      pauseRestartBtn.style.color = '#fff';
      pauseRestartBtn.style.borderColor = '#fff';
      pauseRestartConfirmed = false;
      if (pauseRestartTimeout) clearTimeout(pauseRestartTimeout);
    }
  }
}

// NEW: Pause restart button logic
let pauseRestartConfirmed = false;
let pauseRestartTimeout = null;

if (pauseRestartBtn) {
  pauseRestartBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!pauseRestartConfirmed) {
      pauseRestartConfirmed = true;
      pauseRestartBtn.textContent = 'are you sure?';
      pauseRestartBtn.style.color = '#ff0000';
      pauseRestartBtn.style.borderColor = '#ff0000';

      if (pauseRestartTimeout) clearTimeout(pauseRestartTimeout);
      pauseRestartTimeout = setTimeout(() => {
        pauseRestartConfirmed = false;
        pauseRestartBtn.textContent = 'restart';
        pauseRestartBtn.style.color = '#fff';
        pauseRestartBtn.style.borderColor = '#fff';
      }, 5000);
    } else {
      // Confirmed
      if (pauseRestartTimeout) clearTimeout(pauseRestartTimeout);
      goToMainMenu();
    }
  });
}

// NEW: hook up pause button (if present)
if (pauseButtonEl) {
  pauseButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isGameOver || isGameWon) return;
    togglePause();
  });
}

if (useItemButtonEl) {
  const handleUse = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isGameOver || isGameWon) return;
    useHeldItem();
  };
  useItemButtonEl.addEventListener('touchstart', handleUse, { passive: false });
  useItemButtonEl.addEventListener('mousedown', handleUse);
}

// NEW: Look Behind Button Logic
if (lookBehindButtonEl) {
  lookBehindButtonEl.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (isGameOver || isGameWon) return;
    if (!isLookingBehind) {
      lookBehindBaseRotation.copy(camera.rotation);
      isLookingBehind = true;
    }
  }, { passive: false });

  lookBehindButtonEl.addEventListener('touchend', (e) => {
    e.preventDefault();
    isLookingBehind = false;
  }, { passive: false });
}

// NEW: mobile joystick logic (Updated for multi-touch support)
if (joystickEl && joystickBaseEl && joystickStickEl) {
  let joystickActive = false;
  let joystickTouchId = null; // NEW: track specific finger
  let originX = 0;
  let originY = 0;
  const maxRadius = 50; // px
  const deadZone = 10; // px

  function resetJoystick() {
    joystickActive = false;
    joystickTouchId = null;
    joystickStickEl.style.transform = 'translate(-50%, -50%)';
    move.fwd = false;
    move.back = false;
    move.left = false;
    move.right = false;
    move.sprint = false;
  }

  function updateFromDelta(dx, dy) {
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < deadZone) {
      move.fwd = move.back = move.left = move.right = false;
      move.sprint = false;
      joystickStickEl.style.transform = 'translate(-50%, -50%)';
      return;
    }
    const clampedDist = Math.min(dist, maxRadius);
    const nx = dx / (dist || 1);
    const ny = dy / (dist || 1);
    const stickX = nx * clampedDist;
    const stickY = ny * clampedDist;
    joystickStickEl.style.transform = `translate(calc(-50% + ${stickX}px), calc(-50% + ${stickY}px))`;

    // Invert Y so dragging up is forward
    move.fwd = ny < -0.3;
    move.back = ny > 0.3;
    move.left = nx < -0.3;
    move.right = nx > 0.3;

    // Sprint when pushing joystick to (near) max radius
    const sprintThreshold = maxRadius * 0.9;
    move.sprint = clampedDist >= sprintThreshold;
  }

  joystickEl.addEventListener('touchstart', (e) => {
    if (isGameOver || isGameWon || joystickActive) return;
    const t = e.changedTouches[0];
    joystickTouchId = t.identifier;
    joystickActive = true;
    const rect = joystickBaseEl.getBoundingClientRect();
    originX = rect.left + rect.width / 2;
    originY = rect.top + rect.height / 2;
    const dx = t.clientX - originX;
    const dy = t.clientY - originY;
    updateFromDelta(dx, dy);
    // e.preventDefault(); // Don't prevent default blindly to allow multi-touch flow elsewhere if needed, but here it's fine
  }, { passive: false });

  joystickEl.addEventListener('touchmove', (e) => {
    if (!joystickActive || isGameOver || isGameWon) return;

    // Find our specific finger
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joystickTouchId) {
        const t = e.changedTouches[i];
        const dx = t.clientX - originX;
        const dy = t.clientY - originY;
        updateFromDelta(dx, dy);
        break;
      }
    }
    e.preventDefault();
  }, { passive: false });

  joystickEl.addEventListener('touchend', (e) => {
    if (!joystickActive) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joystickTouchId) {
        resetJoystick();
        break;
      }
    }
    e.preventDefault();
  }, { passive: false });

  joystickEl.addEventListener('touchcancel', (e) => {
    if (!joystickActive) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === joystickTouchId) {
        resetJoystick();
        break;
      }
    }
    e.preventDefault();
  }, { passive: false });
}

// NEW: Swipe to look on mobile
let lookTouchId = null;
let lookLastX = 0;
let lookLastY = 0;
const lookSpeed = 0.005;

canvas.addEventListener('touchstart', (e) => {
  if (isGameOver || isGameWon || isPaused) return;
  const t = e.changedTouches[0];
  lookTouchId = t.identifier;
  lookLastX = t.clientX;
  lookLastY = t.clientY;
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (isGameOver || isGameWon || isPaused || isLookingBehind) return;
  e.preventDefault();

  for (let i = 0; i < e.changedTouches.length; i++) {
    const t = e.changedTouches[i];
    if (t.identifier === lookTouchId) {
      const dx = t.clientX - lookLastX;
      const dy = t.clientY - lookLastY;
      // Update Y tracking even if unused for look, to keep state consistent
      lookLastX = t.clientX;
      lookLastY = t.clientY;

      // Only horizontal look (yaw) allowed on mobile swipe
      camera.rotation.y -= dx * lookSpeed;

      break;
    }
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  for (let i = 0; i < e.changedTouches.length; i++) {
    if (e.changedTouches[i].identifier === lookTouchId) {
      lookTouchId = null;
      break;
    }
  }
}, { passive: false });

// simple movement
const move = { fwd: false, back: false, left: false, right: false, sprint: false };
const MAX_SLOTS = 5;
document.addEventListener('keydown', e => {
  if (isMainMenu && seedInputActive) return;

  // toggle pause with P
  if (e.code === 'KeyP') {
    togglePause();
    return;
  }

  // NEW: R key restart logic
  if (e.code === 'KeyR') {
    if (isMainMenu || isGameOver || isGameWon) return; // Prevent restart if not playing normally
    handleRestartRequest();
    return;
  }

  // NEW: Space to look behind
  if (e.code === 'Space') {
    if (!isLookingBehind) {
      lookBehindBaseRotation.copy(camera.rotation);
      isLookingBehind = true;
    }
  }

  // NEW: ignore movement/input when game over
  if (isGameOver || isGameWon) return;

  // inventory slot selection with keys 1-5
  for (let i = 0; i < MAX_SLOTS; i++) {
    if (e.code === 'Digit' + (i + 1)) {
      selectInventorySlot(i);
      return;
    }
  }

  if (e.code === 'KeyW') move.fwd = true;
  if (e.code === 'KeyS') move.back = true;
  if (e.code === 'KeyA') move.left = true;
  if (e.code === 'KeyD') move.right = true;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.sprint = true;
});
document.addEventListener('keyup', e => {
  if (e.code === 'KeyW') move.fwd = false;
  if (e.code === 'KeyS') move.back = false;
  if (e.code === 'KeyA') move.left = false;
  if (e.code === 'KeyD') move.right = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') move.sprint = false;
  // NEW: Release space to stop looking behind
  if (e.code === 'Space') isLookingBehind = false;
});

const clock = new THREE.Timer();

// build maze
const TILE = 3; // each grid cell is 3 units, making cells physically larger
const GW = 60, GH = 60;
let grid = [], rooms = [], doors = [], blockedDoorEdges = [];
// index of the room reserved for the Principal (detention); declared here to avoid ReferenceError
let principalRoomIndex = -1;
const blockedPathSet = new Set();

function initGame() {
  // Setup RNG
  let seedVal;
  if (seedStr === "" || isNaN(parseInt(seedStr, 10))) {
    seedVal = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  } else {
    seedVal = parseInt(seedStr, 10);
  }
  currentActiveSeed = seedVal; // Store for display

  // Load persisted points (if any)
  try {
    const savedPoints = localStorage.getItem('rooms_maze_points');
    points = savedPoints !== null ? parseInt(savedPoints, 10) || 0 : 0;
  } catch (e) {
    points = 0;
  }

  // Mulberry32
  rng = function () {
    let t = seedVal += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  // Clear existing
  floorGroup.clear();
  roofGroup.clear();
  wallGroup.clear();
  doorGroup.clear();
  itemGroup.clear();
  exitGroup.clear();
  notebookGroup.clear();
  colliders.length = 0;
  doorStates.length = 0;
  itemStates.length = 0;
  notebookStates.length = 0;
  exitStates.length = 0;
  activeSplashes.length = 0;
  splashGroup.clear();
  blockedPathSet.clear();

  // Reset Enemy Mesh (fix for persisting enemy position on restart)
  if (enemyMesh) {
    scene.remove(enemyMesh);
    enemyMesh = null;
  }

  // Reset Game State
  darkModeApplied = false;
  isJumpScare = false;
  hasResetOnCatch = false;

  // Reset AI State
  chaserAI.state = AI_STATES.ROAMING;
  chaserAI.heardDoorPos = null;
  chaserAI.investigatingRoomIndex = null;
  chaserAI.isInvestigating = false;
  chaserAI.lastSeenPlayerPos = null;
  chaserAI.roamingTarget = null;
  chaserAI.roamingTimer = 0;

  // Reset Enemy Physics State
  enemyState.pushTime = 0;
  enemyState.pushDir = null;
  enemyState.pushAttachedSplash = null;
  enemyState.lastPathUpdate = 0;
  enemyState.targetGridX = 0;
  enemyState.targetGridY = 0;

  // NEW: Reset Sweep
  sweepAI.active = false;
  sweepAI.state = 'IDLE';
  sweepAI.pushing = false;
  sweepAI.nextSweepTime = 0;

  // Generate Maze - read user-configured level generation settings from UI if present
  let genAttempts = 600;
  let genTargetRooms = 12;

  try {
    const aEl = document.getElementById('levelAttemptsInput');
    const rEl = document.getElementById('levelRoomsInput');
    const maxExEl = document.getElementById('levelMaxExitsInput');
    const corruptEl = document.getElementById('levelCorruptMazeChk');

    if (aEl) genAttempts = parseInt(aEl.value, 10);
    if (rEl) genTargetRooms = parseInt(rEl.value, 10);
    if (maxExEl) {
      genMaxExits = parseInt(maxExEl.value, 10);
      exitsNeeded = genMaxExits;
    }

    try {
      const maxFloorsEl = document.getElementById('levelMaxFloorsInput');
      if (maxFloorsEl) maxFloors = parseInt(maxFloorsEl.value, 10);
    } catch (e) {
      // ignore and keep existing maxFloors if parsing fails
    }
    if (corruptEl) genCorruptMaze = !!corruptEl.checked;
  } catch (e) {
    // fallback to defaults on any parsing error
    genAttempts = 600;
    genTargetRooms = 12;
    genMaxExits = 4;
    genCorruptMaze = false;
  }

  // If the generator supports passing corridor widen chance, we can set it by
  // temporarily patching Math.random via RNG choices inside generateRooms; for now
  // build roomSizes from optional UI inputs and pass them along with attempts/targetRooms

  let roomSizesParam = undefined;
  try {
    const sizeXEl = document.getElementById('roomSizeXInput');
    const sizeZEl = document.getElementById('roomSizeZInput');
    const sx = sizeXEl ? parseInt(sizeXEl.value, 10) : NaN;
    const sz = sizeZEl ? parseInt(sizeZEl.value, 10) : NaN;
    if (Number.isInteger(sx) && Number.isInteger(sz) && sx >= 1 && sz >= 1) {
      // pass a single allowed room size derived from inputs
      roomSizesParam = [[sx, sz]];
    }
  } catch (e) { roomSizesParam = undefined; }

  const result = generateRooms(GW, GH, roomSizesParam, genAttempts, genTargetRooms);
  // If the generator returned blockedDoorEdges, keep them; otherwise default
  grid = result.grid;
  rooms = result.rooms;
  doors = result.doors;
  blockedDoorEdges = result.blockedDoorEdges || [];

  // NEW: optional "corrupt maze" feature flips some floor tiles to empty to create random holes
  if (genCorruptMaze) {
    // small corruption ratio (2%) seeded via rng
    for (let y = 1; y < GH - 1; y++) {
      for (let x = 1; x < GW - 1; x++) {
        if (!grid[y][x]) continue;
        // avoid corrupting room centers heavily: preserve tiles that are inside rooms
        if (isPositionInRoom(x, y, rooms)) continue;
        if (rng() < 0.02) grid[y][x] = 0;
      }
    }
    // After corruption, we don't rebuild rooms/doors here; collision creation will reflect the new grid.
  }

  // NEW: Reserve a room for Principal (detention) if there is at least one room
  principalRoomIndex = -1;
  if (rooms.length) {
    // choose a random room to be "detention"
    principalRoomIndex = Math.floor(rng() * rooms.length);
    // mark it for easy lookup (userData)
    rooms[principalRoomIndex].isDetention = true;
  }

  // Read spawn-other-characters toggle early so sweep/principal spawns respect it
  const spawnOthers = (() => {
    try {
      const el = document.getElementById('spawnOtherCharChk');
      return el ? !!el.checked : true;
    } catch (e) {
      return true;
    }
  })();

  // Setup Sweep Base (only spawn sweep if spawnOthers is enabled)
  if (result.specialRoom) {
    sweepAI.baseGridX = result.specialRoom.x;
    sweepAI.baseGridY = result.specialRoom.y;
    if (spawnOthers) {
      spawnSweep();
    } else {
      // Cleanup if exists from prior game but not used in this one
      if (sweepMesh) {
        scene.remove(sweepMesh);
        sweepMesh = null;
      }
    }
  } else {
    // Cleanup if exists from prior game but not used in this one
    if (sweepMesh) {
      scene.remove(sweepMesh);
      sweepMesh = null;
    }
  }

  // NEW: spawn character placeholders for Principal, Bob, Playgirl, and Second Prize
  // We'll create simple billboard meshes and state entries; behavior is handled in animate loop below.
  // Remove any existing npc meshes from prior run
  if (typeof npcGroup !== 'undefined' && npcGroup) {
    scene.remove(npcGroup);
  }
  // create npc group and states
  npcGroup = new THREE.Group();
  scene.add(npcGroup);
  npcStates.length = 0;

  function spawnNPCAtRoom(roomIndex, texPath, type) {
    if (!rooms[roomIndex]) return null;
    const r = rooms[roomIndex];
    const cx = (r.x + r.w / 2 - GW / 2) * TILE;
    const cz = (r.y + r.h / 2 - GH / 2) * TILE;
    const size = wallHeight * 0.9;
    const geom = new THREE.PlaneGeometry(size * 0.6, size);
    const tex = textureLoader.load(texPath);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, wallHeight / 2, cz);
    mesh.userData.type = type;
    npcGroup.add(mesh);
    const state = {
      type,
      mesh,
      roomIndex,
      basePos: mesh.position.clone(),
      cooldown: 0,
      // wandering state similar to sweep: target grid, last path update, AI state and roaming target
      targetGridX: null,
      targetGridY: null,
      lastPathUpdate: 0,
      state: 'ROAMING', // 'ROAMING' | 'RETURNING' etc (kept simple)
      roamingTarget: null,
      roamingTimer: 0
    };
    npcStates.push(state);
    return state;
  }

  // spawn Principal in the detention room (if available) - only when spawnOthers is enabled
  if (principalRoomIndex !== -1 && spawnOthers) {
    // use provided asset if present
    spawnNPCAtRoom(principalRoomIndex, './principal schooler.png', 'principal');
  }

  // spawn Bob, Playgirl, Second Prize in random rooms (not the detention one) - controlled by spawnOthers
  if (spawnOthers) {
    const otherRoomIndices = rooms.map((r, i) => i).filter(i => i !== principalRoomIndex);
    if (otherRoomIndices.length) {
      // pick up to 3 distinct rooms
      for (const pair of [['./Bob.png', 'bob'], ['./playgirl.jpg', 'playgirl'], ['./second prize.png', 'second_prize']]) {
        if (!otherRoomIndices.length) break;
        const idx = Math.floor(rng() * otherRoomIndices.length);
        const ri = otherRoomIndices.splice(idx, 1)[0];
        spawnNPCAtRoom(ri, pair[0], pair[1]);
      }
    }
  }

  // Pre-calculate blocked paths where walls exist between connected grid cells
  for (const b of blockedDoorEdges) {
    let nx = b.x, ny = b.y;
    if (b.dir === 'N') ny -= 1;
    else if (b.dir === 'S') ny += 1;
    else if (b.dir === 'E') nx += 1;
    else if (b.dir === 'W') nx -= 1;
    // Store blocked edge bidirectionally: "x,y|nx,ny"
    blockedPathSet.add(`${b.x},${b.y}|${nx},${ny}`);
    blockedPathSet.add(`${nx},${ny}|${b.x},${b.y}`);
  }

  // Create floor tiles and roof
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      if (grid[y][x]) {
        const floor = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), floorMat);
        floor.rotation.x = -Math.PI / 2;
        floor.position.set((x - GW / 2 + 0.5) * TILE, 0, (y - GH / 2 + 0.5) * TILE);
        floor.receiveShadow = true;
        // store base rotation for shake effect
        floor.userData.baseRotation = floor.rotation.clone();
        floorGroup.add(floor);

        const roof = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), roofMat);
        roof.rotation.x = Math.PI / 2;
        // place roof exactly on top of walls (slightly above to avoid z-fighting)
        roof.position.set((x - GW / 2 + 0.5) * TILE, wallHeight - 0.02, (y - GH / 2 + 0.5) * TILE);
        // store base rotation for shake effect
        roof.userData.baseRotation = roof.rotation.clone();
        roofGroup.add(roof);
      }
    }
  }

  // Build walls
  // Build a quick lookup for door edges so we can skip walls where a door exists
  const doorEdgeSet = new Set();
  if (Array.isArray(doors)) {
    for (const d of doors) {
      doorEdgeSet.add(`${d.x},${d.y},${d.dir}`);
    }
  }

  // NEW: track hallway cells that already have posters to enforce spacing
  const posterCells = [];

  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      if (!grid[y][x]) continue;
      const cx = (x - GW / 2 + 0.5) * TILE;
      const cz = (y - GH / 2 + 0.5) * TILE;
      // check four neighbors; if neighbor is empty -> wall
      const neighbors = [
        { dx: 0, dy: -1, dir: 'N' },
        { dx: 1, dy: 0, dir: 'E' },
        { dx: 0, dy: 1, dir: 'S' },
        { dx: -1, dy: 0, dir: 'W' }
      ];
      for (const n of neighbors) {
        const nx = x + n.dx, ny = y + n.dy;
        const needWall = (nx < 0 || nx >= GW || ny < 0 || ny >= GH) || !grid[ny][nx];
        if (!needWall) continue;

        // skip this wall if it corresponds to a door edge
        if (doorEdgeSet.has(`${x},${y},${n.dir}`)) continue;

        // Wall as a single plane facing into the room/corridor
        const geom = new THREE.PlaneGeometry(
          TILE,          // full tile width
          wallHeight     // uniform wall height
        );

        // NEW: 1-in-12 chance to turn hallway walls into posters (random poster texture),
        // but only if no other poster is within a 3-cell radius.
        let wallMaterial = wallMat;
        const isHallwayTile = !roomAtGrid(x, y);
        if (isHallwayTile && posterMats.length && rng() < 0.1) {
          let tooClose = false;
          for (const p of posterCells) {
            const dx = p.x - x;
            const dy = p.y - y;
            if (dx * dx + dy * dy <= 9) { // 3-cell radius
              tooClose = true;
              break;
            }
          }
          if (!tooClose) {
            // Check neighbors within 7-cell radius to avoid same poster texture
            const usedIndices = new Set();
            for (const p of posterCells) {
              const dx = p.x - x;
              const dy = p.y - y;
              if (dx * dx + dy * dy <= 49) { // 7^2 = 49
                if (p.matIndex !== undefined) usedIndices.add(p.matIndex);
              }
            }

            // Find available indices that are NOT used nearby
            const availableIndices = [];
            for (let i = 0; i < posterMats.length; i++) {
              if (!usedIndices.has(i)) availableIndices.push(i);
            }

            // If all variants are used nearby (unlikely), fallback to all indices
            if (availableIndices.length === 0) {
              for (let i = 0; i < posterMats.length; i++) availableIndices.push(i);
            }

            const chosenIdx = availableIndices[Math.floor(rng() * availableIndices.length)];
            wallMaterial = posterMats[chosenIdx];
            posterCells.push({ x, y, matIndex: chosenIdx });
          }
        }

        const mesh = new THREE.Mesh(geom, wallMaterial);
        mesh.position.set(
          cx + (n.dx * TILE) / 2,
          wallHeight / 2,
          cz + (n.dy * TILE) / 2
        );

        // Orient plane so its front side faces the interior tile (this cell)
        if (n.dir === 'N') {
          // neighbor is north, interior is south => normal +Z
          mesh.rotation.y = 0;
        } else if (n.dir === 'S') {
          // neighbor is south, interior is north => normal -Z
          mesh.rotation.y = Math.PI;
        } else if (n.dir === 'E') {
          // neighbor is east, interior is west => normal -X
          mesh.rotation.y = -Math.PI / 2;
        } else if (n.dir === 'W') {
          // neighbor is west, interior is east => normal +X
          mesh.rotation.y = Math.PI / 2;
        }

        wallGroup.add(mesh);
        colliders.push(mesh);
      }
    }
  }

  // Add solid walls for non-door candidate edges
  if (Array.isArray(blockedDoorEdges)) {
    for (const b of blockedDoorEdges) {
      const x = b.x;
      const y = b.y;
      const dir = b.dir;

      const cx = (x - GW / 2 + 0.5) * TILE;
      const cz = (y - GH / 2 + 0.5) * TILE;

      const geom = new THREE.PlaneGeometry(TILE, wallHeight);

      // For blocked door edges we keep the standard wall material (room-side walls)
      const mesh = new THREE.Mesh(geom, wallMat);

      let dx = 0, dz = 0, rotY = 0;
      if (dir === 'N') {
        dz = -TILE / 2;
        rotY = 0;
      } else if (dir === 'S') {
        dz = TILE / 2;
        rotY = Math.PI;
      } else if (dir === 'W') {
        dx = -TILE / 2;
        rotY = Math.PI / 2;
      } else if (dir === 'E') {
        dx = TILE / 2;
        rotY = -Math.PI / 2;
      }

      mesh.position.set(cx + dx, wallHeight / 2, cz + dz);
      mesh.rotation.y = rotY;

      wallGroup.add(mesh);
      colliders.push(mesh);
    }
  }

  for (const wall of wallGroup.children) {
    // store base rotation for shake effect
    wall.userData.baseRotation = wall.rotation.clone();
  }

  // colliderBoxes update in separate step but here we can't easily access the const colliderBoxes
  // so we'll just rebuild them after

  // Create doors
  if (Array.isArray(doors)) {
    for (const d of doors) {
      const x = d.x;
      const y = d.y;
      const dir = d.dir;

      const cx = (x - GW / 2 + 0.5) * TILE;
      const cz = (y - GH / 2 + 0.5) * TILE;

      const geom = new THREE.PlaneGeometry(TILE, wallHeight);

      // group with separate front (room-facing) and back (corridor-facing) planes
      const group = new THREE.Group();

      const front = new THREE.Mesh(geom, doorClosedMat);
      const back = new THREE.Mesh(geom, doorClosedMat);

      let dx = 0, dz = 0, rotY = 0;
      if (dir === 'N') {
        dz = -TILE / 2;
        rotY = 0;
      } else if (dir === 'S') {
        dz = TILE / 2;
        rotY = Math.PI;
      } else if (dir === 'W') {
        dx = -TILE / 2;
        rotY = Math.PI / 2;
      } else if (dir === 'E') {
        dx = TILE / 2;
        rotY = -Math.PI / 2;
      }

      group.position.set(cx + dx, wallHeight / 2, cz + dz);
      group.rotation.y = rotY;

      // front faces the room, back faces the corridor
      // aligned with wall (single plane look)
      front.position.set(0, 0, 0);
      front.rotation.set(0, 0, 0);

      back.position.set(0, 0, 0);
      back.rotation.y = Math.PI;

      group.add(front);
      group.add(back);

      doorGroup.add(group);

      // store base rotation for shake effect
      group.userData.baseRotation = group.rotation.clone();

      const box = new THREE.Box3().setFromObject(group);
      // expand box for consistent collision thickness
      box.expandByScalar(0.15);

      doorStates.push({
        group,
        front,
        back,
        box,
        openUntil: 0,
        isOpen: false,
        roomIndex: d.room
      });
    }
  }

  // Notebooks
  for (const r of rooms) {
    const cx = (r.x + r.w / 2 - GW / 2) * TILE;
    const cz = (r.y + r.h / 2 - GH / 2) * TILE;
    const geom = new THREE.PlaneGeometry(1.2, 1.2);
    const mesh = new THREE.Mesh(geom, notebookMat);
    mesh.position.set(cx, wallHeight / 2, cz);
    // billboard the notebook to always face the camera initially
    mesh.rotation.y = 0;
    notebookGroup.add(mesh);
    // store room index for the notebook so we can avoid spawning enemy exactly in that room when it's just collected
    notebookStates.push({
      mesh,
      collected: false,
      baseY: wallHeight / 2,
      roomIndex: r.id !== undefined ? r.id : null
    });
  }

  // Re-calc collider boxes
  colliderBoxes.length = 0;
  for (const c of colliders) {
    const box = new THREE.Box3().setFromObject(c);
    box.expandByScalar(0.3);
    colliderBoxes.push(box);
  }

  // Spawn Player
  if (rooms.length) {
    // If exits exist, deterministically pick one using the seeded rng and spawn the player
    // in front of that exit (so the same seed yields the same elevator spawn).
    let sx = 0, sz = 0;
    if (exitStates && exitStates.length) {
      const idx = Math.floor(rng() * exitStates.length);
      const chosen = exitStates[idx];
      const exPos = chosen.mesh.position.clone();
      // mesh.rotation.y is the rotation used when the exit was placed; compute forward vector
      const ry = chosen.mesh.rotation.y || 0;
      // exit plane normal (points toward corridor side when placed) => use negative Z math:
      // forward = (-sin(ry), 0, -cos(ry))
      const fx = -Math.sin(ry);
      const fz = -Math.cos(ry);
      // place player 1.2 units away from the exit face into the hallway
      // use the opposite direction so the player spawns on the corridor side (in front of the exit)
      sx = exPos.x - fx * 1.2;
      sz = exPos.z - fz * 1.2;
    } else {
      // fallback: collect corridor tiles that are not in any room
      const hallwayTiles = [];
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          if (!grid[y][x]) continue;
          if (roomAtGrid(x, y)) continue;
          hallwayTiles.push({ x, y });
        }
      }

      if (hallwayTiles.length) {
        const choice = hallwayTiles[Math.floor(rng() * hallwayTiles.length)];
        sx = (choice.x - GW / 2 + 0.5) * TILE;
        sz = (choice.y - GH / 2 + 0.5) * TILE;
      } else {
        let best = rooms[0];
        let bestArea = best.w * best.h;
        for (let i = 1; i < rooms.length; i++) {
          const a = rooms[i].w * rooms[i].h;
          if (a > bestArea) { best = rooms[i]; bestArea = a; }
        }
        let gx, gz;
        if (bestArea > 2) {
          gx = best.x + best.w / 2;
          gz = best.y + best.h / 2;
        } else {
          gx = GW / 2;
          gz = GH / 2;
        }
        sx = (gx - GW / 2) * TILE;
        sz = (gz - GH / 2) * TILE;
      }
    }

    controls.getObject().position.set(sx, 1.6, sz);
  }

  // Spawn Enemy
  const settings = diffSettings[currentDifficulty];

  // Reset scene environment
  scene.background = new THREE.Color(0xffffff);
  scene.fog.near = 2;
  scene.fog.far = 35;

  if (settings.fog !== undefined) {
    scene.fog.color.setHex(settings.fog);
  } else {
    scene.fog.color.setHex(0xffffff);
  }

  // Restore lighting and clear any dark-mode audio/state that may have persisted
  try {
    // Restore directional / ambient intensities to defaults
    if (typeof dir !== 'undefined' && dir) dir.intensity = 3.0;
    if (typeof ambientLight !== 'undefined' && ambientLight) ambientLight.intensity = 1.4;
  } catch (e) { }

  // Stop any lingering dark-mode ambience or run loop
  try { windHowlSound.pause(); windHowlSound.currentTime = 0; } catch (e) { }
  try { runSound.pause(); runSound.currentTime = 0; } catch (e) { }

  // Reset dark-mode flags so the new floor starts bright
  darkModeApplied = false;
  darkModeSpeedBonus = 0;

  // Play the schoolhouse loop when the game initializes; it should run until 2 notebooks are collected.
  try {
    schoolhouseSound.currentTime = 0;
    schoolhouseSound.play();
  } catch (e) {
    // ignore autoplay restrictions
  }

  // NOTE: Enemy (Balder) will NOT spawn at init. It will spawn when exactly 2 notebooks have been collected.
  // This prevents Balder from appearing immediately when play starts.

  totalRooms = rooms.length;
  notebooksCollected = 0;
  exitsCollected = 0;
  updateNotebookCounter();
  if (notebookCounterEl) notebookCounterEl.style.display = 'block';

  spawnRoomItems();
  spawnHallwayItems();
  spawnExits();

  // Ensure player spawns in front of a chosen exit (elevator) if exits exist
  if (exitStates && exitStates.length) {
    const idx = Math.floor(rng() * exitStates.length);
    const chosen = exitStates[idx];
    const exPos = chosen.mesh.position.clone();
    const ry = chosen.mesh.rotation.y || 0;
    // exit plane normal (points toward corridor side when placed)
    const fx = -Math.sin(ry);
    const fz = -Math.cos(ry);
    // place player slightly in front of the exit face into the hallway
    const sx = exPos.x - fx * 1.2;
    const sz = exPos.z - fz * 1.2;
    controls.getObject().position.set(sx, 1.6, sz);
  }

  // Update Info UI
  updateInfoDisplays();

  // enforce the rule immediately on init: characters & schoolhouse music must not remain after 2 notebooks
  enforceTwoNotebookRule();

  // Ensure Purple Chocolate
  (function ensurePurpleChocolatePresence() {
    if (itemStates.some(it => it.type === 'purple_chocolate')) return;
    if (itemStates.length > 0) {
      const idx = Math.floor(rng() * itemStates.length);
      const it = itemStates[idx];
      it.type = 'purple_chocolate';
      it.mesh.userData.type = 'purple_chocolate';
      it.mesh.material = purpleChocolateMat;
      return;
    }
    if (!rooms.length) return;
    const r = rooms[Math.floor(rng() * rooms.length)];
    const cx = (r.x + r.w / 2 - GW / 2) * TILE;
    const cz = (r.y + r.h / 2 - GH / 2) * TILE;

    const size = 0.8;
    const geom = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geom, purpleChocolateMat);
    const baseY = wallHeight / 2;
    mesh.position.set(cx + 0.4, baseY, cz + 0.4);
    mesh.userData.type = 'purple_chocolate';
    itemGroup.add(mesh);
    itemStates.push({ mesh, type: 'purple_chocolate', roomIndex: null, baseY });
  })();
}

function spawnEnemy() {
  if (!rooms.length || enemyMesh) return;
  // pick a room for enemy spawn, but avoid the room containing the last-collected notebook grid cell if known
  let r = null;
  let attempts = 0;
  const maxAttempts = 20;
  do {
    r = rooms[Math.floor(rng() * rooms.length)];
    attempts++;
    if (!lastCollectedNotebookGrid) break;
    // if lastCollectedNotebookGrid falls inside this room, try again
    if (!(lastCollectedNotebookGrid.x >= r.x && lastCollectedNotebookGrid.x < r.x + r.w &&
      lastCollectedNotebookGrid.y >= r.y && lastCollectedNotebookGrid.y < r.y + r.h)) {
      break;
    }
    r = null;
  } while (attempts < maxAttempts);

  // fallback to any room if none found after attempts
  if (!r) r = rooms[Math.floor(rng() * rooms.length)];

  const cx = (r.x + r.w / 2 - GW / 2) * TILE;
  const cz = (r.y + r.h / 2 - GH / 2) * TILE;

  const enemyHeight = wallHeight * 0.75;
  const enemyWidth = enemyHeight * 0.3;

  if (!enemyMesh) {
    const geom = new THREE.PlaneGeometry(enemyWidth, enemyHeight);
    enemyMesh = new THREE.Mesh(geom, enemyMat);
    scene.add(enemyMesh);
  }

  enemyMesh.position.set(cx, enemyHeight / 2, cz);
  enemyState.gridX = Math.floor(r.x + r.w / 2);
  enemyState.gridY = Math.floor(r.y + r.h / 2);
}

// NEW: Spawn Sweep
function spawnSweep() {
  if (!sweepMesh) {
    // Square, height of wall
    const size = wallHeight;
    const geom = new THREE.PlaneGeometry(size, size);
    sweepMesh = new THREE.Mesh(geom, sweepMat);
    scene.add(sweepMesh);
  }

  const wx = (sweepAI.baseGridX - GW / 2 + 0.5) * TILE;
  const wz = (sweepAI.baseGridY - GH / 2 + 0.5) * TILE;

  sweepMesh.position.set(wx, wallHeight / 2, wz);
  sweepAI.active = true;
  sweepAI.state = 'IDLE';
  sweepAI.nextSweepTime = clock.getElapsedTime() + 120; // 2 minutes from now
  console.log("Sweep spawned. Next sweep at:", sweepAI.nextSweepTime);
}

function startSweepRun() {
  if (!sweepMesh) return;
  console.log("Sweep starting run!");
  sweepAI.state = 'ROAMING';
  sweepAI.sweepDuration = 0;
  sweepAI.cooldownTimer = 0;
  sweepAI.lastCheck = clock.getElapsedTime();

  // Pick initial target (far away to ensure roaming)
  const t = pickRoamingTarget(sweepMesh ? sweepMesh.position : null, 30);
  if (t) {
    sweepAI.targetGridX = Math.floor(t.x / TILE + GW / 2);
    sweepAI.targetGridY = Math.floor(t.z / TILE + GH / 2);
  }
}

let totalRooms = 0;
let notebooksCollected = 0;
// track grid coordinate of the last-collected notebook to avoid spawning enemy there
let lastCollectedNotebookGrid = null;
// NEW: exit tracking
let exitsCollected = 0;
let exitsNeeded = 4;
const notebookCounterEl = document.getElementById('notebookCounter');

// NEW: Floors
let currentFloor = 1;
let maxFloors = 5;
const floorDisplayEl = document.getElementById('floorDisplay');

// NEW: track when all notebooks were collected and an incremental enemy speed bonus
let allNotebooksCollectedAt = 0; // 0 = not triggered
let enemySpeedBonus = 0.0; // added to enemy movement speed progressively

function updateNotebookCounter() {
  if (darkModeApplied) {
    notebookCounterEl.textContent = `${exitsCollected}/${exitsNeeded} exits`;
    // Make the "0/4 exits" sign red when nothing has been collected, otherwise default to white
    if (exitsCollected === 0) {
      notebookCounterEl.style.color = '#ff0000';
    } else {
      notebookCounterEl.style.color = '#ffffff';
    }
  } else {
    notebookCounterEl.textContent = `${notebooksCollected}/${totalRooms} notebooks`;
    notebookCounterEl.style.color = '#ffffff';
  }
}

function updateInfoDisplays() {
  if (seedDisplayEl) {
    seedDisplayEl.textContent = `seed: ${currentActiveSeed} | floor ${currentFloor}/${maxFloors} | ${points}pts`;
    seedDisplayEl.style.display = isInfoDisplayEnabled ? 'block' : 'none';
  }
  if (difficultyDisplayEl) {
    difficultyDisplayEl.textContent = `difficulty: ${currentDifficulty}`;
    difficultyDisplayEl.style.color = diffSettings[currentDifficulty].color;
    difficultyDisplayEl.style.display = isInfoDisplayEnabled ? 'block' : 'none';
  }
  if (floorDisplayEl) {
    floorDisplayEl.textContent = `floor ${currentFloor}/${maxFloors}`;
    floorDisplayEl.style.display = isInfoDisplayEnabled ? 'block' : 'none';
  }
}

/**
 * Enforce rule: characters (NPC group + enemy) and the schoolhouse music
 * must only be present until 2 notebooks are collected.
 * This can be called safely from initGame() and animate() to ensure immediate enforcement.
 */
function enforceTwoNotebookRule() {
  try {
    // Desired behaviour:
    // - While fewer than 2 notebooks have been collected: ensure Balder (enemy) is NOT present and the schoolhouse music is playing.
    // - When notebooksCollected reaches 2 (or greater): spawn Balder if missing and stop the schoolhouse loop.
    if (notebooksCollected < 2) {
      // Ensure enemy is removed if it somehow exists before threshold
      if (enemyMesh) {
        try { scene.remove(enemyMesh); } catch (e) { }
        enemyMesh = null;
        try { chaseMusic.pause(); chaseMusic.currentTime = 0; } catch (e) { }
      }
      // Make sure schoolhouse loop plays while under threshold
      try {
        if (schoolhouseSound.paused) {
          schoolhouseSound.currentTime = 0;
          schoolhouseSound.play();
        }
      } catch (e) {
        // ignore autoplay restrictions
      }
    } else {
      // When threshold met spawn Balder if missing and stop the schoolhouse loop.
      // Spawn only once when hitting the threshold.
      if (!enemyMesh && !isPeaceful()) {
        try {
          spawnEnemy();
        } catch (e) {
          console.error('spawnEnemy failed in enforceTwoNotebookRule:', e);
        }
      }
      try {
        if (!schoolhouseSound.paused) {
          schoolhouseSound.pause();
          schoolhouseSound.currentTime = 0;
        }
      } catch (e) {
        // ignore audio errors
      }
    }
  } catch (err) {
    // Swallow errors to avoid breaking the main loop
    console.error('enforceTwoNotebookRule error:', err);
  }
}

// when enough notebooks are collected, darken the whole scene and change fog
function checkNotebookCompletion() {
  if (darkModeApplied) return;

  const settings = diffSettings[currentDifficulty];
  // Delayed spawn for easy mode
  if (settings.spawnAt > 0 && notebooksCollected === settings.spawnAt && !enemyMesh) {
    spawnEnemy();
    // make sure he spawns far away from player if possible
    // (re-randomize if too close is handled by standard RNG usually, but this is simple enough)
  }

  // NEW: Characters (enemy + NPCs) and the schoolhouse music are only present until more than 2 notebooks are collected.
  if (notebooksCollected >= 2) {
    // Remove enemy if present
    if (enemyMesh) {
      try { scene.remove(enemyMesh); } catch (e) { }
      enemyMesh = null;
      // stop chase music as enemy is gone
      try { chaseMusic.pause(); chaseMusic.currentTime = 0; } catch (e) { }
    }
    // Remove NPC group if present
    if (npcGroup) {
      try { scene.remove(npcGroup); } catch (e) { }
      npcGroup = null;
      npcStates.length = 0;
    }
    // Stop schoolhouse loop now that threshold is exceeded
    try { schoolhouseSound.pause(); schoolhouseSound.currentTime = 0; } catch (e) { }
  }

  if (notebooksCollected >= totalRooms) {
    darkModeApplied = true;
    darkModeSpeedBonus = settings.darkBonus;

    // NEW: switch chaser to ANGRY mode permanently
    chaserAI.state = AI_STATES.ANGRY;

    // spawnExits(); // moved to init so they exist in normal mode too
    updateNotebookCounter();

    // make the scene fully dark
    if (!modNoDarkness) {
      scene.background = new THREE.Color(0x000000);
      if (scene.fog) {
        scene.fog.color.setHex(settings.darkFog);
        // extremely dense black fog
        scene.fog.near = 0.4;
        scene.fog.far = 12;
      }

      // make lights almost completely dark
      setTimeout(() => {
        dir.intensity = 0.05;
        if (typeof ambientLight !== 'undefined' && ambientLight) {
          ambientLight.intensity = 0.03;
        }
      }, 0);
    }

    // play wind howling sound
    try {
      windHowlSound.currentTime = 0;
      windHowlSound.play();
    } catch (e) { }
  }
}

updateNotebookCounter();

// NEW: global audio setup
// background hum, quiet loop
const humSound = new Audio('./room-with-buzz-incandescent-light-bulb-23892.mp3');
humSound.loop = true;
humSound.volume = 0.18;
humSound.preload = 'auto';

// Monkey-patch HTMLMediaElement.play to catch and ignore rejected play() promises
// (prevents "The play() request was interrupted by a call to pause()" unhandledRejection)
(function safeAudioPlayPatch() {
  try {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      const p = origPlay.apply(this, arguments);
      if (p && typeof p.catch === 'function') p.catch(() => { });
      return p;
    };
  } catch (e) {
    // If monkey-patch fails (e.g., environment restrictions), ignore and continue.
    console.warn('safeAudioPlayPatch failed:', e);
  }
})();

// Global handler to suppress noisy pointer-lock related promise rejections
// (e.g. "Pointer lock cannot be acquired immediately after the user has exited the lock")
// We preventDefault() on unhandledrejection events so they don't appear in console as uncaught.
window.addEventListener('unhandledrejection', (ev) => {
  try {
    // Optionally, filter specific messages if you want to allow other rejections to surface.
    // For simplicity and robustness across browsers, suppress all unhandled promise rejections here.
    ev.preventDefault();
  } catch (err) {
    // swallow any errors from the handler itself
  }
});

// NEW: Schoolhouse looped music that plays until 2 notebooks are collected
const schoolhouseSound = new Audio('./The schoolhouse.wav');
schoolhouseSound.loop = true;
schoolhouseSound.volume = 0.9;
schoolhouseSound.preload = 'auto';

// NEW: looped RUN.. sound that plays when all notebooks are collected
const runSound = new Audio('./RUN..wav');
runSound.loop = true;
runSound.volume = 0.9;
runSound.preload = 'auto';

// NEW: play button and mode toggle logic
const mainMenuEl = document.getElementById('mainMenu');
const playButtonEl = document.getElementById('playButton');
const modeToggleButtonEl = document.getElementById('modeToggleButton');
const loudnessToggleButtonEl = document.getElementById('loudnessToggleButton');
const showInfoToggleButtonEl = document.getElementById('showInfoToggleButton');
const seedUI = document.getElementById('seedUI');
const difficultyUI = document.getElementById('difficultyUI');

if (difficultyUI) {
  // Init UI from loaded difficulty
  difficultyUI.textContent = `difficulty: ${currentDifficulty}`;
  difficultyUI.style.color = diffSettings[currentDifficulty].color;

  difficultyUI.addEventListener('click', (e) => {
    e.stopPropagation();
    const idx = difficulties.indexOf(currentDifficulty);
    const next = difficulties[(idx + 1) % difficulties.length];
    currentDifficulty = next;
    localStorage.setItem('rooms_maze_difficulty', currentDifficulty);
    const settings = diffSettings[next];
    difficultyUI.textContent = `difficulty: ${next}`;
    difficultyUI.style.color = settings.color;
  });
}

if (seedUI) {
  seedUI.addEventListener('click', (e) => {
    e.stopPropagation();
    seedInputActive = !seedInputActive;
    if (seedInputActive) {
      seedUI.style.color = '#ffff00'; // highlight yellow when typing
      seedUI.style.textShadow = '2px 2px 0 #000';
      seedUI.textContent = "seed: " + seedStr + "_";
      if (seedInputHidden) {
        seedInputHidden.value = seedStr;
        seedInputHidden.focus();
      }
    } else {
      seedUI.style.color = '#000';
      seedUI.style.textShadow = 'none';
      seedUI.textContent = "seed: " + seedStr;
      if (seedInputHidden) seedInputHidden.blur();
    }
  });
}

if (seedInputHidden) {
  seedInputHidden.addEventListener('input', () => {
    if (seedInputActive) {
      // sanitize input to digits and minus
      const val = seedInputHidden.value.replace(/[^0-9-]/g, '');
      if (val !== seedInputHidden.value) seedInputHidden.value = val;

      seedStr = val;
      if (seedUI) seedUI.textContent = "seed: " + seedStr + "_";
    }
  });
  // Handle blur? 
  // For now let's rely on explicit toggle to keep the UI state consistent with the 'Active' flag
}

const savedLoudness = localStorage.getItem('rooms_maze_loudness');
let isLoudnessEnabled = savedLoudness === null ? true : (savedLoudness === 'true');

const savedInfo = localStorage.getItem('rooms_maze_info');
let isInfoDisplayEnabled = savedInfo === 'true';

/* peaceful is now a difficulty option; helper to check it */
function isPeaceful() {
  return currentDifficulty === 'peaceful';
}

// NEW: minimap notebook reveal timer and index
let showNotebookOnMinimapUntil = 0;
let showNotebookIndex = -1;

let showEnemyOnMinimapUntil = 0;

// info display toggle logic
if (showInfoToggleButtonEl) {
  showInfoToggleButtonEl.textContent = isInfoDisplayEnabled ? 'disable info display' : 'enable info display';
  showInfoToggleButtonEl.style.color = '#000000';

  showInfoToggleButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    isInfoDisplayEnabled = !isInfoDisplayEnabled;
    localStorage.setItem('rooms_maze_info', isInfoDisplayEnabled);
    showInfoToggleButtonEl.textContent = isInfoDisplayEnabled ? 'disable info display' : 'enable info display';
  });
}

// loudness toggle logic
if (loudnessToggleButtonEl) {
  loudnessToggleButtonEl.textContent = isLoudnessEnabled ? 'disable loudness' : 'enable loudness';

  loudnessToggleButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    isLoudnessEnabled = !isLoudnessEnabled;
    localStorage.setItem('rooms_maze_loudness', isLoudnessEnabled);
    loudnessToggleButtonEl.textContent = isLoudnessEnabled ? 'disable loudness' : 'enable loudness';
  });
}

/* removed separate peaceful UI; peaceful is selected via difficulty UI */

// ensure initial label matches current render mode
if (modeToggleButtonEl) {
  modeToggleButtonEl.textContent = isHdMode ? 'switch to authentic' : 'switch to hd';

  modeToggleButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    // toggle render mode flag
    isHdMode = !isHdMode;
    localStorage.setItem('rooms_maze_hd', isHdMode);
    // reconfigure renderer with new settings
    applyRenderMode();
    // update button label to reflect new mode
    modeToggleButtonEl.textContent = isHdMode ? 'switch to authentic' : 'switch to hd';
  });
}

if (playButtonEl) {
  playButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    // start at selected floor when pressing play (read from level editor settings dropdown if present)
    try {
      const selectEl = document.getElementById('levelStartFloorSelect');
      const val = selectEl ? parseInt(selectEl.value, 10) : NaN;
      currentFloor = (Number.isInteger(val) && val >= 1) ? Math.min(Math.max(val, 1), 20) : 1;
    } catch (err) {
      currentFloor = 1;
    }

    initGame();
    if (mainMenuEl) mainMenuEl.style.display = 'none';

    // Show HUD
    if (minimap) minimap.style.display = 'block';
    if (inventoryEl) inventoryEl.style.display = 'flex';

    isMainMenu = false;
    inputReady = false;
    // Buffer input to prevent instant interaction
    setTimeout(() => { inputReady = true; }, 400);

    // reset frame time to prevent jump when game actually starts moving
    lastFrameTime = performance.now() * 0.001;
  });
}

// --- Level Editor support ---
let inLevelEditor = false;
let editorTool = 'hall'; // 'hall','room','elevator','notebook','item'
const editorObjects = new Map(); // key "x,y" -> mesh

const levelEditorButtonEl = document.getElementById('levelEditorButton');

function createEditorPanel() {
  // simple floating panel with 2D + 3D previews
  let panel = document.getElementById('levelEditorPanel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'levelEditorPanel';
  Object.assign(panel.style, {
    position: 'fixed',
    right: '12px',
    top: '12px',
    zIndex: 600,
    background: 'rgba(0,0,0,0.88)',
    color: '#fff',
    padding: '10px',
    fontFamily: 'Times New Roman, serif',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    border: '1px solid #666',
    width: '220px'
  });

  const title = document.createElement('div');
  title.textContent = 'Level Editor';
  title.style.fontSize = '16px';
  title.style.marginBottom = '4px';
  panel.appendChild(title);

  // Tool buttons + preview area container
  const toolsRow = document.createElement('div');
  Object.assign(toolsRow.style, { display: 'flex', gap: '6px', flexWrap: 'wrap' });
  const tools = ['hall', 'room', 'elevator', 'notebook', 'item'];
  tools.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t;
    b.dataset.tool = t;
    Object.assign(b.style, {
      padding: '6px 8px',
      cursor: 'pointer',
      background: 'transparent',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.06)',
      fontSize: '13px'
    });
    b.addEventListener('click', (ev) => {
      editorTool = t;
      // highlight selection
      Array.from(toolsRow.querySelectorAll('button')).forEach(btn => btn.style.outline = '');
      b.style.outline = '2px solid #fff';
      updateEditorPreviews(t);
    });
    toolsRow.appendChild(b);
    if (t === editorTool) b.style.outline = '2px solid #fff';
  });
  panel.appendChild(toolsRow);

  // Previews container (2D + 3D)
  const previews = document.createElement('div');
  Object.assign(previews.style, { display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'space-between' });

  // 2D preview canvas (small)
  const preview2D = document.createElement('canvas');
  preview2D.id = 'editor2DPreview';
  preview2D.width = 88;
  preview2D.height = 88;
  Object.assign(preview2D.style, {
    background: '#111',
    border: '1px solid rgba(255,255,255,0.06)',
    imageRendering: 'pixelated'
  });

  // 3D-ish preview (simple CSS-transformed image to simulate a 3D billboard)
  const preview3D = document.createElement('div');
  preview3D.id = 'editor3DPreview';
  Object.assign(preview3D.style, {
    width: '88px',
    height: '88px',
    background: '#000',
    border: '1px solid rgba(255,255,255,0.06)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    perspective: '420px',
    overflow: 'hidden'
  });

  const preview3DInner = document.createElement('div');
  preview3DInner.id = 'editor3DInner';
  Object.assign(preview3DInner.style, {
    width: '72px',
    height: '72px',
    transformStyle: 'preserve-3d',
    transition: 'transform 220ms ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  });
  preview3D.appendChild(preview3DInner);

  previews.appendChild(preview2D);
  previews.appendChild(preview3D);
  panel.appendChild(previews);

  // Quick action buttons
  const btnRow = document.createElement('div');
  Object.assign(btnRow.style, { display: 'flex', gap: '6px', marginTop: '6px' });

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'clear markers';
  Object.assign(clearBtn.style, { padding: '6px', cursor: 'pointer', background: 'transparent', color: '#fff', border: '1px solid #444' });
  clearBtn.addEventListener('click', () => {
    for (const m of editorObjects.values()) {
      if (m && m.parent) scene.remove(m);
    }
    editorObjects.clear();
  });
  btnRow.appendChild(clearBtn);

  const exitBtn = document.createElement('button');
  exitBtn.textContent = 'exit editor';
  Object.assign(exitBtn.style, { padding: '6px', cursor: 'pointer', background: 'transparent', color: '#fff', border: '1px solid #444' });
  exitBtn.addEventListener('click', () => exitLevelEditor());
  btnRow.appendChild(exitBtn);

  panel.appendChild(btnRow);

  document.body.appendChild(panel);

  // Helper: mapping tool -> image for the 2D preview
  const previewMap = {
    hall: './2025_12_09_0yv_Kleki.png',
    room: './2025_12_09_0ys_Kleki.png',
    elevator: './exitt.png',
    notebook: './2025_12_09_0z4_Kleki (6).png',
    item: './dither_it_2025_12_10_0is_Kleki.png'
  };

  // Update function to draw the 2D preview and set a 3D-styled billboard
  function updateEditorPreviews(tool) {
    const imgSrc = previewMap[tool] || previewMap['hall'];
    const img = new Image();
    img.src = imgSrc;
    img.onload = () => {
      // 2D: draw centered, pixelated look
      const ctx = preview2D.getContext('2d');
      ctx.clearRect(0, 0, preview2D.width, preview2D.height);
      // draw a dark framed background
      ctx.fillStyle = '#0b0b0b';
      ctx.fillRect(0, 0, preview2D.width, preview2D.height);
      // compute draw size preserving aspect fit
      const pad = 8;
      const w = preview2D.width - pad * 2;
      const h = preview2D.height - pad * 2;
      let dw = w, dh = h;
      if (img.width > img.height) {
        dh = Math.floor(w * (img.height / img.width));
      } else {
        dw = Math.floor(h * (img.width / img.height));
      }
      const ox = Math.floor((preview2D.width - dw) / 2);
      const oy = Math.floor((preview2D.height - dh) / 2);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, ox, oy, dw, dh);

      // 3D: set inner element background and apply a subtle tilt to simulate 3D
      preview3DInner.style.backgroundImage = `url("${imgSrc}")`;
      preview3DInner.style.backgroundSize = 'cover';
      preview3DInner.style.backgroundPosition = 'center';
      // random slight rotation for liveliness
      preview3DInner.style.transform = `rotateX(18deg) rotateY(-18deg) translateZ(6px)`;
      // add subtle hover parallax
      preview3DInner.onmousemove = (ev) => {
        const r = preview3D.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const rx = (ev.clientX - cx) / (r.width / 2);
        const ry = (ev.clientY - cy) / (r.height / 2);
        const tiltX = (ry * 8);
        const tiltY = (rx * -8);
        preview3DInner.style.transform = `rotateX(${18 + tiltX}deg) rotateY(${-18 + tiltY}deg) translateZ(6px)`;
      };
      preview3DInner.onmouseleave = () => {
        preview3DInner.style.transform = `rotateX(18deg) rotateY(-18deg) translateZ(6px)`;
      };
    };
    img.onerror = () => {
      // clear canvases on error
      const ctx = preview2D.getContext('2d');
      ctx.clearRect(0, 0, preview2D.width, preview2D.height);
      preview3DInner.style.backgroundImage = '';
    };
  }

  // Initialize previews to current tool
  updateEditorPreviews(editorTool || 'hall');

  return panel;
}

function enterLevelEditor() {
  // Enter a dedicated level-editor state that is separate from normal gameplay.
  // We do NOT call initGame here — the editor should present an empty playstate
  // where the world is renderable but game AI and progression are suspended.
  inLevelEditor = true;
  isMainMenu = false;
  // hide main menu but keep canvas active so user can see the world
  if (mainMenuEl) mainMenuEl.style.display = 'none';
  // show minimap and inventory for context while editing
  if (minimap) minimap.style.display = 'block';
  if (inventoryEl) inventoryEl.style.display = 'flex';
  // create editor UI panel
  createEditorPanel();
  // make the input system ready for editor interactions and allow movement
  inputReady = true;
  // allow player movement in editor by keeping updates running but mark editor active
  isPaused = false;       // allow the normal update loop to run so player can move
  isGameOver = false;     // editor is not a game-over state
  isGameWon = false;
  // release any pointer locks to allow UI interactions
  try { controls.unlock(); } catch (e) { }
  // hide in-game overlays that would interfere
  if (pauseOverlay) pauseOverlay.style.display = 'none';
  if (winOverlay) winOverlay.style.display = 'none';
}

function exitLevelEditor() {
  inLevelEditor = false;
  // remove panel
  const panel = document.getElementById('levelEditorPanel');
  if (panel) panel.remove();
  // return to main menu
  goToMainMenu();
}

// map editor tool -> color
const editorColors = {
  hall: 0x999999,
  room: 0x44aa44,
  elevator: 0xffaa00,
  notebook: 0xffff66,
  item: 0x88ccff
};

function placeEditorMarkerAtGrid(gx, gy, type) {
  const key = `${gx},${gy}`;
  // remove existing marker for that key (we will replace)
  if (editorObjects.has(key)) {
    const old = editorObjects.get(key);
    if (old && old.parent) scene.remove(old);
    editorObjects.delete(key);
  }

  // small box for marker
  const size = TILE * 0.6;
  const geo = new THREE.BoxGeometry(size, 0.4, size);
  const mat = new THREE.MeshStandardMaterial({ color: editorColors[type] || 0xffffff });
  const mesh = new THREE.Mesh(geo, mat);
  const wx = (gx - GW / 2 + 0.5) * TILE;
  const wz = (gy - GH / 2 + 0.5) * TILE;
  mesh.position.set(wx, 0.2, wz);
  mesh.userData.editorType = type;
  scene.add(mesh);
  editorObjects.set(key, mesh);

  // Also apply the selected placement to the game world:
  // - hall: carve a floor tile at grid cell and add floor/roof visuals
  // - room: carve a small 3x3 room centered on the chosen cell (if it fits)
  // - notebook: spawn a notebook at the cell
  // - item: spawn a blue soda item at the cell
  // - elevator: place an exit marker (exit sign) on the cell
  try {
    // bounds check
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return;

    if (type === 'hall') {
      if (!grid[gy]) grid[gy] = new Array(GW).fill(0);
      grid[gy][gx] = 1;

      // add floor tile
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(wx, 0, wz);
      floor.receiveShadow = true;
      floor.userData.baseRotation = floor.rotation.clone();
      floorGroup.add(floor);

      const roof = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), roofMat);
      roof.rotation.x = Math.PI / 2;
      roof.position.set(wx, wallHeight - 0.02, wz);
      roof.userData.baseRotation = roof.rotation.clone();
      roofGroup.add(roof);

    } else if (type === 'room') {
      // carve a 3x3 room centered at gx,gy if it fits inside map
      const rw = 3, rh = 3;
      const startX = gx - Math.floor(rw / 2);
      const startY = gy - Math.floor(rh / 2);
      if (startX >= 1 && startY >= 1 && startX + rw < GW && startY + rh < GH) {
        for (let yy = startY; yy < startY + rh; yy++) {
          for (let xx = startX; xx < startX + rw; xx++) {
            if (!grid[yy]) grid[yy] = new Array(GW).fill(0);
            grid[yy][xx] = 1;
            const fx = (xx - GW / 2 + 0.5) * TILE;
            const fz = (yy - GH / 2 + 0.5) * TILE;
            const floor = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), floorMat);
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(fx, 0, fz);
            floor.userData.baseRotation = floor.rotation.clone();
            floorGroup.add(floor);
            const roof = new THREE.Mesh(new THREE.PlaneGeometry(TILE, TILE), roofMat);
            roof.rotation.x = Math.PI / 2;
            roof.position.set(fx, wallHeight - 0.02, fz);
            roof.userData.baseRotation = roof.rotation.clone();
            roofGroup.add(roof);
          }
        }
        // register a room entry (minimal): id based on current rooms length
        const roomId = rooms.length;
        const roomObj = { x: startX, y: startY, w: rw, h: rh, id: roomId };
        rooms.push(roomObj);
      }
    } else if (type === 'notebook') {
      // spawn a notebook plane at this location
      const geom = new THREE.PlaneGeometry(1.2, 1.2);
      const nb = new THREE.Mesh(geom, notebookMat);
      nb.position.set(wx, wallHeight / 2, wz);
      nb.rotation.y = 0;
      notebookGroup.add(nb);
      notebookStates.push({ mesh: nb, collected: false, baseY: wallHeight / 2, roomIndex: null });
    } else if (type === 'item') {
      // spawn a blue soda item at this location
      const sizeItem = 0.8;
      const geom = new THREE.PlaneGeometry(sizeItem, sizeItem);
      const meshItem = new THREE.Mesh(geom, blueSodaMat);
      meshItem.position.set(wx, wallHeight / 2, wz);
      meshItem.userData.type = 'blue_soda';
      itemGroup.add(meshItem);
      itemStates.push({ mesh: meshItem, type: 'blue_soda', roomIndex: null, baseY: wallHeight / 2 });
    } else if (type === 'elevator') {
      // place an exit plane at this tile (same as spawnExits creation)
      const geom = new THREE.PlaneGeometry(TILE, wallHeight);
      const mesh = new THREE.Mesh(geom, exitMat);
      mesh.position.set(wx, wallHeight / 2, wz);
      exitGroup.add(mesh);
      exitStates.push({ mesh, collected: false });
    }
  } catch (e) { console.warn('Editor placement error:', e); }
}

// helper: raycast center of screen to floor to get grid cell
function getEditorGridFromCenter() {
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(0, 0), camera);

  // Try precise hit against existing floor tiles first
  const hits = rc.intersectObjects(floorGroup.children, true);
  if (hits && hits.length) {
    const hit = hits[0];
    const x = hit.point.x;
    const z = hit.point.z;
    const gx = Math.floor(x / TILE + GW / 2);
    const gy = Math.floor(z / TILE + GH / 2);
    if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return null;
    return { gx, gy };
  }

  // Fallback: intersect with an infinite ground plane at y=0 so editor placements work
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y=0
  const origin = rc.ray.origin;
  const dir = rc.ray.direction;
  const targetPoint = new THREE.Vector3();
  const intersect = groundPlane.intersectLine(new THREE.Line3(origin, origin.clone().add(dir.clone().multiplyScalar(1000))), targetPoint);

  // If intersectLine returned undefined, try Raycaster .ray.intersectPlane
  if (!intersect) {
    const tmp = new THREE.Vector3();
    if (!rc.ray.intersectPlane(groundPlane, tmp)) return null;
    targetPoint.copy(tmp);
  }

  const x = targetPoint.x;
  const z = targetPoint.z;
  const gx = Math.floor(x / TILE + GW / 2);
  const gy = Math.floor(z / TILE + GH / 2);
  if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) return null;
  return { gx, gy };
}

// click handler for editor placement (left mouse button)
canvas.addEventListener('mousedown', (e) => {
  if (!inLevelEditor) return;
  if (e.button !== 0) return;
  e.preventDefault();
  const gridPos = getEditorGridFromCenter();
  if (!gridPos) return;
  placeEditorMarkerAtGrid(gridPos.gx, gridPos.gy, editorTool);
});

// bind level editor main menu button
if (levelEditorButtonEl) {
  levelEditorButtonEl.addEventListener('click', (e) => {
    e.stopPropagation();
    enterLevelEditor();
  });
}

// allow exiting editor with ESC
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Esc') {
    if (inLevelEditor) {
      exitLevelEditor();
      e.preventDefault();
    }
  }
});

// buzzer on catch (replaced with scream)
const catchBuzzerSound = new Audio('./GAHHH.wav');
catchBuzzerSound.preload = 'auto';
catchBuzzerSound.volume = 1.0;

// chase music, looped; volume controlled by distance
const chaseMusic = new Audio('./ItReallyGetsBalder.wav');
chaseMusic.loop = true;
chaseMusic.preload = 'auto';

// NEW: wind howling ambience for dark mode
const windHowlSound = new Audio('./wind_howling_02-78263.mp3');
windHowlSound.loop = true;
windHowlSound.preload = 'auto';
windHowlSound.volume = 0.85;

// start hum and lock pointer on first game click (not on main menu)
let humStarted = false;

/**
 * Pointer lock cooldown guard and safe lock helper.
 * Some browsers produce an error if lock() is requested immediately after exiting;
 * we use a short cooldown and retry loop to avoid unhandled rejections.
 */
let pointerLockCooldown = false;

document.addEventListener('pointerlockerror', () => {
  // if an error occurs, prevent immediate re-lock attempts for a short window
  pointerLockCooldown = true;
  setTimeout(() => { pointerLockCooldown = false; }, 300);
});

document.addEventListener('pointerlockchange', () => {
  // if pointer is locked to our canvas, clear cooldown; otherwise set a tiny cooldown
  if (document.pointerLockElement === canvas) {
    pointerLockCooldown = false;
  } else {
    pointerLockCooldown = true;
    setTimeout(() => { pointerLockCooldown = false; }, 180);
  }
});

/**
 * Attempt to acquire pointer lock safely. If a recent unlock/error happened,
 * wait a bit before retrying to avoid "cannot be acquired immediately after the user has exited" errors.
 */
function safeLock(retries = 6, delayMs = 180) {
  // If we are in a cooldown window, schedule a retry instead of calling lock immediately.
  if (pointerLockCooldown) {
    if (retries > 0) {
      setTimeout(() => safeLock(retries - 1, delayMs), delayMs);
    }
    return;
  }

  try {
    // Some browsers may produce an asynchronous rejection internally when lock()
    // is requested immediately after an exit; wrap call so any returned promise
    // has a catch to avoid unhandledRejection.
    try {
      const p = Promise.resolve().then(() => controls.lock());
      if (p && typeof p.catch === 'function') p.catch(() => { });
    } catch (syncErr) {
      // controls.lock() threw synchronously; handle like before by scheduling retry.
      if (retries > 0) {
        setTimeout(() => safeLock(retries - 1, delayMs), delayMs);
      } else {
        pointerLockCooldown = true;
        setTimeout(() => { pointerLockCooldown = false; }, delayMs);
      }
    }
  } catch (err) {
    // Fallback safety: schedule retry rather than letting an unhandled rejection bubble.
    if (retries > 0) {
      setTimeout(() => safeLock(retries - 1, delayMs), delayMs);
    } else {
      pointerLockCooldown = true;
      setTimeout(() => { pointerLockCooldown = false; }, delayMs);
    }
  }
}

canvas.addEventListener('click', () => {
  if (isMainMenu) return; // no pointer lock or hum while in main menu

  // Use safeLock to avoid "Pointer lock cannot be acquired immediately" errors
  safeLock();

  if (!humStarted) {
    humStarted = true;
    try {
      humSound.currentTime = 0;
      humSound.play();
    } catch { }
  }
});

// load notebook pickup sound
const notebookPickupSound = new Audio('./paper-rustle-81855.mp3');
notebookPickupSound.preload = 'auto';

// walkie-talkie beep sound
const walkieTalkieBeepSound = new Audio('./beep-329314.mp3');
walkieTalkieBeepSound.preload = 'auto';
walkieTalkieBeepSound.volume = 0.9;

// purple chocolate crunch sound
const purpleChocolateSound = new Audio('./plastic-crunch-83779.mp3');
purpleChocolateSound.preload = 'auto';
purpleChocolateSound.volume = 0.9;

// sound that plays after the jumpscare during blackout
const postJumpscareSound = new Audio('./bbbbb.wav');
postJumpscareSound.preload = 'auto';
postJumpscareSound.volume = 1.0;

// full-screen blackout overlay for post-jumpscare
const blackoutOverlay = document.createElement('div');
Object.assign(blackoutOverlay.style, {
  position: 'fixed',
  inset: '0',
  background: '#000',
  zIndex: '40',
  display: 'none'
});
document.body.appendChild(blackoutOverlay);

// load door sounds
const doorOpenSound = new Audio('./door-opening-397990.mp3');
doorOpenSound.preload = 'auto';

const doorCloseSound = new Audio('./close-door-382723.mp3');
doorCloseSound.preload = 'auto';

// helper to play a door sound with volume based on distance to player
function playDoorSoundForDoor(audio, doorGroup) {
  try {
    const listenerPos = camera.position;
    const doorPos = new THREE.Vector3();
    doorGroup.getWorldPosition(doorPos);
    const distance = listenerPos.distanceTo(doorPos);

    const maxHearDistance = TILE * 10; // beyond this, sound is nearly inaudible
    const vol = Math.max(0, Math.min(1, 1 - distance / maxHearDistance));

    if (vol <= 0) return;

    audio.currentTime = 0;
    audio.volume = vol;
    audio.play();
  } catch (e) {
    // ignore playback errors
  }
}

// NEW: soda open sound for blue soda usage
const sodaOpenSound = new Audio('./soda-can-open-183214.mp3');
sodaOpenSound.preload = 'auto';
sodaOpenSound.volume = 0.85;

// NEW: spray sound for wd40
const spraySound = new Audio('./spray-bottle-36050.mp3');
spraySound.preload = 'auto';
spraySound.volume = 1.0;

// NEW: Sweep sound
const sweepSound = new Audio('./35f37130-9444-4e22-bbe3-982795157c9a.wav');
sweepSound.preload = 'auto';
sweepSound.loop = true;
sweepSound.volume = 1.0;

// colors / materials
const textureLoader = new THREE.TextureLoader();
const wallTex = textureLoader.load('./2025_12_09_0ys_Kleki.png');
wallTex.magFilter = THREE.NearestFilter;
wallTex.minFilter = THREE.NearestFilter;
wallTex.wrapS = THREE.RepeatWrapping;
wallTex.wrapT = THREE.RepeatWrapping;
wallTex.generateMipmaps = false;

const floorTex = textureLoader.load('./2025_12_09_0yv_Kleki.png');
floorTex.magFilter = THREE.NearestFilter;
floorTex.minFilter = THREE.NearestFilter;
floorTex.wrapS = THREE.RepeatWrapping;
floorTex.wrapT = THREE.RepeatWrapping;
floorTex.generateMipmaps = false;

const roofTex = textureLoader.load('./roofff.png');
roofTex.magFilter = THREE.NearestFilter;
roofTex.minFilter = THREE.NearestFilter;
roofTex.wrapS = THREE.RepeatWrapping;
roofTex.wrapT = THREE.RepeatWrapping;
roofTex.generateMipmaps = false;

const notebookTex = textureLoader.load('./2025_12_09_0z4_Kleki (6).png');
notebookTex.magFilter = THREE.NearestFilter;
notebookTex.minFilter = THREE.NearestFilter;
notebookTex.generateMipmaps = false;

// enemy billboard texture
const enemyTex = textureLoader.load('./itgetsbalder.png');
enemyTex.magFilter = THREE.NearestFilter;
enemyTex.minFilter = THREE.NearestFilter;
enemyTex.generateMipmaps = false;

// door textures
const doorTex = textureLoader.load('./door.png');
doorTex.magFilter = THREE.NearestFilter;
doorTex.minFilter = THREE.NearestFilter;
doorTex.generateMipmaps = false;

const doorOpenedTex = textureLoader.load('./door_opened.png');
doorOpenedTex.magFilter = THREE.NearestFilter;
doorOpenedTex.minFilter = THREE.NearestFilter;
doorOpenedTex.generateMipmaps = false;

// NEW: poster textures for hallway walls
const posterTex1 = textureLoader.load('./poster1.png');
posterTex1.magFilter = THREE.NearestFilter;
posterTex1.minFilter = THREE.NearestFilter;
posterTex1.generateMipmaps = false;

const posterTex2 = textureLoader.load('./poster2.png');
posterTex2.magFilter = THREE.NearestFilter;
posterTex2.minFilter = THREE.NearestFilter;
posterTex2.generateMipmaps = false;

const posterTex3 = textureLoader.load('./poster3.png');
posterTex3.magFilter = THREE.NearestFilter;
posterTex3.minFilter = THREE.NearestFilter;
posterTex3.generateMipmaps = false;

const posterTex4 = textureLoader.load('./poster4.png');
posterTex4.magFilter = THREE.NearestFilter;
posterTex4.minFilter = THREE.NearestFilter;
posterTex4.generateMipmaps = false;

const posterTex5 = textureLoader.load('./poster5.png');
posterTex5.magFilter = THREE.NearestFilter;
posterTex5.minFilter = THREE.NearestFilter;
posterTex5.generateMipmaps = false;

// NEW: poster 6 texture
const posterTex6 = textureLoader.load('./poster6.png');
posterTex6.magFilter = THREE.NearestFilter;
posterTex6.minFilter = THREE.NearestFilter;
posterTex6.generateMipmaps = false;

// NEW: poster 7 texture
const posterTex7 = textureLoader.load('./poster7.png');
posterTex7.magFilter = THREE.NearestFilter;
posterTex7.minFilter = THREE.NearestFilter;
posterTex7.generateMipmaps = false;

// NEW: poster 8 texture
const posterTex8 = textureLoader.load('./poster8.png');
posterTex8.magFilter = THREE.NearestFilter;
posterTex8.minFilter = THREE.NearestFilter;
posterTex8.generateMipmaps = false;

// NEW: poster 9 texture
const posterTex9 = textureLoader.load('./poster9.png');
posterTex9.magFilter = THREE.NearestFilter;
posterTex9.minFilter = THREE.NearestFilter;
posterTex9.generateMipmaps = false;

const oldBootsTex = textureLoader.load('./boots.png');
oldBootsTex.magFilter = THREE.NearestFilter;
oldBootsTex.minFilter = THREE.NearestFilter;
oldBootsTex.generateMipmaps = false;

// NEW: Sweep texture
const sweepTex = textureLoader.load('./2025_12_14_0sd_Kleki (1).png');
sweepTex.magFilter = THREE.NearestFilter;
sweepTex.minFilter = THREE.NearestFilter;
sweepTex.generateMipmaps = false;

// NEW: array of poster materials used for random hallway wall posters
const posterMats = [
  new THREE.MeshStandardMaterial({
    map: posterTex1,
    transparent: true,
    side: THREE.DoubleSide
  }),
  new THREE.MeshStandardMaterial({
    map: posterTex2,
    transparent: true,
    side: THREE.DoubleSide
  }),
  new THREE.MeshStandardMaterial({
    map: posterTex3,
    transparent: true,
    side: THREE.DoubleSide
  }),
  new THREE.MeshStandardMaterial({
    map: posterTex4,
    transparent: true,
    side: THREE.DoubleSide
  }),
  new THREE.MeshStandardMaterial({
    map: posterTex5,
    transparent: true,
    side: THREE.DoubleSide
  }),
  // NEW: material for poster 6
  new THREE.MeshStandardMaterial({
    map: posterTex6,
    transparent: true,
    side: THREE.DoubleSide
  }),
  // NEW: material for poster 7
  new THREE.MeshStandardMaterial({
    map: posterTex7,
    transparent: true,
    side: THREE.DoubleSide
  }),
  // NEW: material for poster 8
  new THREE.MeshStandardMaterial({
    map: posterTex8,
    transparent: true,
    side: THREE.DoubleSide
  }),
  // NEW: material for poster 9
  new THREE.MeshStandardMaterial({
    map: posterTex9,
    transparent: true,
    side: THREE.DoubleSide
  })
];

// NEW: item and splash textures
const blueSodaTex = textureLoader.load('./dither_it_2025_12_10_0is_Kleki.png');
blueSodaTex.magFilter = THREE.NearestFilter;
blueSodaTex.minFilter = THREE.NearestFilter;
blueSodaTex.generateMipmaps = false;

const purpleChocolateTex = textureLoader.load('./2025_12_10_0kd_Kleki.png');
purpleChocolateTex.magFilter = THREE.NearestFilter;
purpleChocolateTex.minFilter = THREE.NearestFilter;
purpleChocolateTex.generateMipmaps = false;

// Preload DOM icon for purple chocolate
const purpleChocolateIconSrc = './2025_12_10_0kd_Kleki.png';
const purpleChocolateIcon = new Image();
purpleChocolateIcon.src = purpleChocolateIconSrc;

// NEW: minimap icon images for notebooks, player, and balder
const notebookIconSrc = './2025_12_09_0z4_Kleki (6).png';
const notebookIcon = new Image();
notebookIcon.src = notebookIconSrc;

const playerIconSrc = './thumn.png';
const playerIcon = new Image();
playerIcon.src = playerIconSrc;

const balderIconSrc = './itgetsbalder.png';
const balderIcon = new Image();
balderIcon.src = balderIconSrc;

const walkieTalkieTex = textureLoader.load('./dither_it_2025_12_10_0lk_Kleki.png');
walkieTalkieTex.magFilter = THREE.NearestFilter;
walkieTalkieTex.minFilter = THREE.NearestFilter;
walkieTalkieTex.generateMipmaps = false;

const walkieTalkieIconSrc = './dither_it_2025_12_10_0lk_Kleki.png';
const walkieTalkieIcon = new Image();
walkieTalkieIcon.src = walkieTalkieIconSrc;

const wd40Tex = textureLoader.load('./fineButImGonnaUseApaintnetplugin.png');
wd40Tex.magFilter = THREE.NearestFilter;
wd40Tex.minFilter = THREE.NearestFilter;
wd40Tex.generateMipmaps = false;

const oldBootsIconSrc = './boots.png';
const oldBootsIcon = new Image();
oldBootsIcon.src = oldBootsIconSrc;

const sparkleTex = textureLoader.load('./Sparkle.webp');
sparkleTex.magFilter = THREE.NearestFilter;
sparkleTex.minFilter = THREE.NearestFilter;
sparkleTex.generateMipmaps = false;

const wd40IconSrc = './fineButImGonnaUseApaintnetplugin.png';
const wd40Icon = new Image();
wd40Icon.src = wd40IconSrc;

const splashTex = textureLoader.load('./2025_12_10_0iv_Kleki (1).png');
splashTex.magFilter = THREE.NearestFilter;
splashTex.minFilter = THREE.NearestFilter;
splashTex.generateMipmaps = false;

// NEW: exit textures
const exitTex = textureLoader.load('./exitt.png');           // open/default EXIT sign
exitTex.magFilter = THREE.NearestFilter;
exitTex.minFilter = THREE.NearestFilter;

const exitUsedTex = textureLoader.load('./wuhohhh (1).png'); // closed/used: smiley card
exitUsedTex.magFilter = THREE.NearestFilter;
exitUsedTex.minFilter = THREE.NearestFilter;

// Preload DOM icon images for items so inventory icons appear instantly
const blueSodaIconSrc = './dither_it_2025_12_10_0is_Kleki.png';
const blueSodaIcon = new Image();
blueSodaIcon.src = blueSodaIconSrc;

const floorMat = new THREE.MeshStandardMaterial({
  map: floorTex,
  color: 0xffffff
}); // textured floor
const roofMat = new THREE.MeshStandardMaterial({
  map: roofTex,
  side: THREE.DoubleSide
});
const wallMat = new THREE.MeshStandardMaterial({
  map: wallTex,
  color: 0xffffff,
  side: THREE.DoubleSide
}); // textured walls, double-sided
const doorClosedMat = new THREE.MeshStandardMaterial({
  map: doorTex,
  transparent: true,
  side: THREE.FrontSide,
  color: 0xffffff
});
const doorOpenedMat = new THREE.MeshStandardMaterial({
  map: doorOpenedTex,
  transparent: true,
  side: THREE.FrontSide,
  color: 0xffffff
});

// ensure wall and door colors are white so their textures appear the same brightness
wallMat.color.set(0xffffff);
doorClosedMat.color.set(0xffffff);
doorOpenedMat.color.set(0xffffff);

// create flipped maps for the corridor-facing (back) side of the doors
const doorTexBack = doorTex.clone();
doorTexBack.repeat.x = -1;
doorTexBack.offset.x = 1;

const doorOpenedTexBack = doorOpenedTex.clone();
doorOpenedTexBack.repeat.x = -1;
doorOpenedTexBack.offset.x = 1;

const doorClosedBackMat = new THREE.MeshStandardMaterial({
  map: doorTexBack,
  transparent: true,
  side: THREE.FrontSide
});
const doorOpenedBackMat = new THREE.MeshStandardMaterial({
  map: doorOpenedTexBack,
  transparent: true,
  side: THREE.FrontSide
});

// tint doors to match wall color
doorClosedMat.color.copy(wallMat.color);
doorOpenedMat.color.copy(wallMat.color);
doorClosedBackMat.color.copy(wallMat.color);
doorOpenedBackMat.color.copy(wallMat.color);

const notebookMat = new THREE.MeshStandardMaterial({
  map: notebookTex,
  transparent: true,
  side: THREE.DoubleSide
});

const enemyMat = new THREE.MeshStandardMaterial({
  map: enemyTex,
  transparent: true,
  side: THREE.DoubleSide
});

// NEW: item and splash materials
const blueSodaMat = new THREE.MeshStandardMaterial({
  map: blueSodaTex,
  transparent: true,
  side: THREE.DoubleSide
});

const purpleChocolateMat = new THREE.MeshStandardMaterial({
  map: purpleChocolateTex,
  transparent: true,
  side: THREE.DoubleSide
});

const walkieTalkieMat = new THREE.MeshStandardMaterial({
  map: walkieTalkieTex,
  transparent: true,
  side: THREE.DoubleSide
});

const wd40Mat = new THREE.MeshStandardMaterial({
  map: wd40Tex,
  transparent: true,
  side: THREE.DoubleSide
});

const oldBootsMat = new THREE.MeshStandardMaterial({
  map: oldBootsTex,
  transparent: true,
  side: THREE.DoubleSide
});

// NEW: point pickup textures & materials (non-inventory pickups that award points)
const orangePointTex = textureLoader.load('./orange point.png');
orangePointTex.magFilter = THREE.NearestFilter;
orangePointTex.minFilter = THREE.NearestFilter;
orangePointTex.generateMipmaps = false;

const greenPointTex = textureLoader.load('./green point.png');
greenPointTex.magFilter = THREE.NearestFilter;
greenPointTex.minFilter = THREE.NearestFilter;
greenPointTex.generateMipmaps = false;

const pinkPointTex = textureLoader.load('./pink point.png');
pinkPointTex.magFilter = THREE.NearestFilter;
pinkPointTex.minFilter = THREE.NearestFilter;
pinkPointTex.generateMipmaps = false;

const megaPointTex = textureLoader.load('./mega point.png');
megaPointTex.magFilter = THREE.NearestFilter;
megaPointTex.minFilter = THREE.NearestFilter;
megaPointTex.generateMipmaps = false;

const orangePointMat = new THREE.MeshStandardMaterial({
  map: orangePointTex,
  transparent: true,
  side: THREE.DoubleSide
});
const greenPointMat = new THREE.MeshStandardMaterial({
  map: greenPointTex,
  transparent: true,
  side: THREE.DoubleSide
});
const pinkPointMat = new THREE.MeshStandardMaterial({
  map: pinkPointTex,
  transparent: true,
  side: THREE.DoubleSide
});
const megaPointMat = new THREE.MeshStandardMaterial({
  map: megaPointTex,
  transparent: true,
  side: THREE.DoubleSide
});

const sparkleMat = new THREE.MeshBasicMaterial({
  map: sparkleTex,
  transparent: true,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending
});

const splashMat = new THREE.MeshStandardMaterial({
  map: splashTex,
  transparent: true,
  side: THREE.DoubleSide
});

const exitMat = new THREE.MeshStandardMaterial({
  map: exitTex,
  transparent: true,
  side: THREE.FrontSide,
  color: 0xffffff
});
const exitUsedMat = new THREE.MeshStandardMaterial({
  map: exitUsedTex,
  transparent: true,
  side: THREE.FrontSide,
  color: 0xffffff
});

const sweepMat = new THREE.MeshStandardMaterial({
  map: sweepTex,
  transparent: true,
  side: THREE.DoubleSide
});

const ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
scene.add(ambientLight);
const dir = new THREE.DirectionalLight(0xffffff, 3.0);
dir.position.set(6, 10, 4);
scene.add(dir);

// A parent for collision objects
const colliders = [];

// shared wall/roof height
const wallHeight = 2.6;

// Create floor tiles and roof
const floorGroup = new THREE.Group();
const roofGroup = new THREE.Group();
scene.add(floorGroup);
scene.add(roofGroup);

// colliders update
const wallGroup = new THREE.Group();
scene.add(wallGroup);

// Precompute static bounding boxes for all colliders (walls don't move)
const colliderBoxes = [];

// Create door meshes from detected door edges
const doorGroup = new THREE.Group();
scene.add(doorGroup);

const doorStates = []; // { group, front, back, box, openUntil, isOpen }

let enemyMesh = null;
let sweepMesh = null; // NEW: Sweep mesh
let speedBoostUntil = 0;
showEnemyOnMinimapUntil = 0;

// NEW: exit states
const exitGroup = new THREE.Group();
scene.add(exitGroup);
const exitStates = []; // { mesh, collected }

function spawnExits() {
  // Find all hallway wall spots
  const candidates = [];

  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      // Must be a floor tile
      if (!grid[y][x]) continue;
      // Must NOT be a room tile (strictly hallway)
      if (roomAtGrid(x, y)) continue;

      // Check 4 neighbors for empty space (walls)
      // North
      if (y - 1 < 0 || !grid[y - 1][x]) {
        candidates.push({ x, y, dir: 'N' });
      }
      // South
      if (y + 1 >= GH || !grid[y + 1][x]) {
        candidates.push({ x, y, dir: 'S' });
      }
      // West
      if (x - 1 < 0 || !grid[y][x - 1]) {
        candidates.push({ x, y, dir: 'W' });
      }
      // East
      if (x + 1 >= GW || !grid[y][x + 1]) {
        candidates.push({ x, y, dir: 'E' });
      }
    }
  }

  // Shuffle candidates
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  // Pick 4
  // choose up to configured exits (genMaxExits global), clamp safely
  const num = Math.max(1, Math.min(12, Math.floor(genMaxExits) || 4));
  const chosen = candidates.slice(0, num);

  chosen.forEach(c => {
    // Calculate wall position
    const cx = (c.x - GW / 2 + 0.5) * TILE;
    const cz = (c.y - GH / 2 + 0.5) * TILE;

    let wx = cx, wz = cz;
    let ry = 0;

    if (c.dir === 'N') {
      wz -= TILE / 2;
      ry = 0;
    } else if (c.dir === 'S') {
      wz += TILE / 2;
      ry = Math.PI;
    } else if (c.dir === 'W') {
      wx -= TILE / 2;
      ry = Math.PI / 2;
    } else if (c.dir === 'E') {
      wx += TILE / 2;
      ry = -Math.PI / 2;
    }

    // Try to find existing wall to replace
    const epsilon = 0.1;
    const wallToRemove = wallGroup.children.find(w =>
      Math.abs(w.position.x - wx) < epsilon &&
      Math.abs(w.position.z - wz) < epsilon
    );

    if (wallToRemove) {
      wallGroup.remove(wallToRemove);
      // We keep the collider box since the exit acts as a solid wall at the same location
    }

    // Create wall-sized exit
    const geom = new THREE.PlaneGeometry(TILE, wallHeight);
    const mesh = new THREE.Mesh(geom, exitMat);

    mesh.position.set(wx, wallHeight / 2, wz);
    mesh.rotation.y = ry;

    exitGroup.add(mesh);
    exitStates.push({ mesh, collected: false });
  });
}

// NEW: AI state machine for chaser
const AI_STATES = {
  ROAMING: 'roaming',
  HEARD: 'heard',
  FOUND: 'found',
  ANGRY: 'angry'
};

const chaserAI = {
  state: AI_STATES.ROAMING,
  heardDoorPos: null,
  investigatingRoomIndex: null,
  isInvestigating: false,
  lastSeenPlayerPos: null,
  roamingTarget: null,
  roamingTimer: 0
};

// NEW: Sweep AI state
const sweepAI = {
  active: false,
  baseGridX: 0,
  baseGridY: 0,
  targetGridX: 0,
  targetGridY: 0,
  state: 'IDLE', // 'IDLE', 'ROAMING', 'RETURNING'
  cooldownTimer: 0,
  sweepDuration: 0,
  lastPathUpdate: 0,
  lastCheck: 0
};

// NEW: NPC system (Principal, Bob, Playgirl, Second Prize)
// npcGroup and npcStates are created/cleared in initGame; here we just ensure arrays exist
let npcGroup = null;
const npcStates = []; // { type, mesh, roomIndex, basePos, cooldown }

// helper: send player to detention (principal behavior)
let detentionActive = false;
function sendPlayerToDetention(durationSec = 15) {
  if (detentionActive) return;
  // find principal room center
  const pr = rooms.find(r => r.isDetention);
  if (!pr) return;
  detentionActive = true;

  // Save current position to restore after detention
  const savedPos = controls.getObject().position.clone();

  // Teleport player to detention center (a little inside the room)
  const tx = (pr.x + pr.w / 2 - GW / 2) * TILE;
  const tz = (pr.y + pr.h / 2 - GH / 2) * TILE;
  controls.getObject().position.set(tx, savedPos.y, tz);

  // disable input and lock camera
  inputReady = false;
  move.fwd = move.back = move.left = move.right = move.sprint = false;
  controls.unlock();
  controls.enabled = false;

  // optionally show a subtle indicator (we'll reuse blackoutOverlay briefly)
  blackoutOverlay.style.display = 'block';

  detentionTimeout = setTimeout(() => {
    // restore position (try to put back where player was)
    controls.getObject().position.copy(savedPos);
    controls.enabled = true;
    inputReady = true;
    detentionActive = false;
    blackoutOverlay.style.display = 'none';
    detentionTimeout = null;
  }, durationSec * 1000);
}

// helper: bob steals a random inventory item when close
function bobAttemptSteal(state) {
  // Respect mod: if bully stealing is disabled, do nothing
  if (modBullyNoSteal) return;

  // only attempt if cooldown elapsed
  if (state.cooldown > clock.getElapsedTime()) return;
  // pick a non-empty slot
  const occupied = inventory.map((it, i) => it ? i : -1).filter(i => i !== -1);
  if (!occupied.length) return;
  const idx = occupied[Math.floor(rng() * occupied.length)];
  // drop the item (simulated: remove from inventory)
  inventory[idx] = null;
  refreshInventoryHUD();
  // small cooldown before next steal
  state.cooldown = clock.getElapsedTime() + 8.0;
  // play a light sound (reusing pickup) as feedback
  try { notebookPickupSound.currentTime = 0; notebookPickupSound.play(); } catch (e) { }
}

// helper: playgirl forces a brief interaction like Playtime
function playgirlForcePlay(state) {
  if (state.cooldown > clock.getElapsedTime()) return;
  // Freeze player briefly and nudge them to hop in place (we'll just disable movement for 3s)
  inputReady = false;
  controls.enabled = false;
  state.cooldown = clock.getElapsedTime() + 12.0; // cooldown before re-trigger
  setTimeout(() => {
    controls.enabled = true;
    inputReady = true;
  }, 3000);
}

// helper: second prize nudges player forward like 1st prize
function secondPrizeNudge(state) {
  if (state.cooldown > clock.getElapsedTime()) return;
  const playerPos = controls.getObject().position;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  dir.y = 0;
  dir.normalize();
  const push = dir.multiplyScalar(1.2);
  const proposed = playerPos.clone().add(push);
  if (!collides(proposed)) {
    controls.getObject().position.copy(proposed);
  }
  state.cooldown = clock.getElapsedTime() + 4.0;
}

// Principal reacts when player sprints nearby or uses soda/purple next to him
function principalReact(state) {
  // respect mod: principal can be set to ignore player reactions
  if (modPrincipalIgnore) return;
  if (state.cooldown > clock.getElapsedTime()) return;
  const playerPos = controls.getObject().position;
  const d = state.mesh.position.distanceTo(playerPos);
  const sprinting = move.sprint;
  // If player sprints within 6 units or uses certain items near (we will detect usage in useHeldItem),
  // send to detention
  if (sprinting && d < TILE * 2) {
    sendPlayerToDetention(15);
    state.cooldown = clock.getElapsedTime() + 20.0;
  }
}

// Hook: when using soda or purple near principal, send to detention
const originalUseHeldItem = useHeldItem;
useHeldItem = function () {
  // capture player's held item type before original logic clears it
  const held = inventory[selectedInvIndex] ? inventory[selectedInvIndex].type : null;

  // call original behaviour
  originalUseHeldItem();

  // if used blue_soda or purple_chocolate, check nearby principals
  if (held === 'blue_soda' || held === 'purple_chocolate') {
    const now = clock.getElapsedTime();
    for (const st of npcStates) {
      if (st.type === 'principal') {
        // Respect mod: if Principal is set to ignore the player, skip reaction
        if (modPrincipalIgnore) continue;

        // Respect per-principal cooldown to avoid repeated immediate detentions
        if (st.cooldown && st.cooldown > now) continue;

        const d = st.mesh.position.distanceTo(controls.getObject().position);
        if (d < TILE * 3) {
          sendPlayerToDetention(15);
          st.cooldown = now + 20.0;
        }
      }
    }
  }
};

// NEW: Enemy physical state (grid pos, push physics)
const enemyState = {
  gridX: 0,
  gridY: 0,
  targetGridX: 0,
  targetGridY: 0,
  lastPathUpdate: 0,
  pushTime: 0,
  pushDir: null,
  pushSpeed: 0,
  pushAttachedSplash: null
};

// NEW: Jumpscare state flags
let isJumpScare = false;
let hasResetOnCatch = false;
let jumpShakeStartTime = 0;



// Notebooks in room centers
const notebookGroup = new THREE.Group();
scene.add(notebookGroup);

const notebookStates = []; // { mesh, collected }

/* helper to know if a tile belongs to a room (for hallway spawn and AI logic) */
function roomAtGrid(i, j) {
  return isPositionInRoom(i, j, rooms);
}

// NEW: inventory state (5 slots)
const inventory = [null, null, null, null, null];
let selectedInvIndex = 0;

// helper: update inventory HUD visuals
function refreshInventoryHUD() {
  for (let i = 0; i < invSlotEls.length; i++) {
    const slotEl = invSlotEls[i];
    const iconEl = invIconEls[i];
    const item = inventory[i];
    if (item) {
      if (item.type === 'blue_soda') {
        if (iconEl.src !== blueSodaIconSrc && !iconEl.src.endsWith(blueSodaIconSrc)) {
          iconEl.src = blueSodaIconSrc;
        }
        iconEl.style.display = 'block';
      } else if (item.type === 'purple_chocolate') {
        if (iconEl.src !== purpleChocolateIconSrc && !iconEl.src.endsWith(purpleChocolateIconSrc)) {
          iconEl.src = purpleChocolateIconSrc;
        }
        iconEl.style.display = 'block';
      } else if (item.type === 'walkie_talkie') {
        if (iconEl.src !== walkieTalkieIconSrc && !iconEl.src.endsWith(walkieTalkieIconSrc)) {
          iconEl.src = walkieTalkieIconSrc;
        }
        iconEl.style.display = 'block';
      } else if (item.type === 'wd40') {
        if (iconEl.src !== wd40IconSrc && !iconEl.src.endsWith(wd40IconSrc)) {
          iconEl.src = wd40IconSrc;
        }
        iconEl.style.display = 'block';
      } else if (item.type === 'old_boots') {
        if (iconEl.src !== oldBootsIconSrc && !iconEl.src.endsWith(oldBootsIconSrc)) {
          iconEl.src = oldBootsIconSrc;
        }
        iconEl.style.display = 'block';
      } else {
        iconEl.src = '';
        iconEl.style.display = 'none';
      }
    } else {
      iconEl.src = '';
      iconEl.style.display = 'none';
    }
    if (i === selectedInvIndex) {
      slotEl.classList.add('selected');
    } else {
      slotEl.classList.remove('selected');
    }
  }

  // update use button visibility
  if (useItemButtonEl) {
    const isMobile = navigator.maxTouchPoints > 0;
    const hasItem = inventory[selectedInvIndex] !== null;
    if (isMobile && hasItem) {
      useItemButtonEl.style.display = 'flex';
    } else {
      useItemButtonEl.style.display = 'none';
    }
  }
}

// helper: select slot programmatically
function selectInventorySlot(index) {
  if (index < 0 || index >= inventory.length) return;
  selectedInvIndex = index;
  refreshInventoryHUD();
}

// allow clicking HUD slots to select
if (invSlotEls.length) {
  invSlotEls.forEach((slotEl, idx) => {
    slotEl.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      if (isGameOver) return;
      selectInventorySlot(idx);
    });
  });
}

// NEW: scroll wheel to change selected inventory slot (wraps around)
window.addEventListener('wheel', (e) => {
  if (isGameOver) return;
  if (!inventory.length) return;

  if (e.deltaY < 0) {
    // scroll up: move one slot left
    const nextIndex = (selectedInvIndex - 1 + inventory.length) % inventory.length;
    selectInventorySlot(nextIndex);
  } else if (e.deltaY > 0) {
    // scroll down: move one slot right
    const nextIndex = (selectedInvIndex + 1) % inventory.length;
    selectInventorySlot(nextIndex);
  }
}, { passive: true });

// NEW: world item group and states
const itemGroup = new THREE.Group();
scene.add(itemGroup);
const itemStates = []; // { mesh, type, roomIndex }

// NEW: active silent areas (WD40 effect)
const activeSilentAreas = []; // { x, z, radius, expiresAt, group }

// NEW: splash projectiles
const splashGroup = new THREE.Group();
scene.add(splashGroup);
const activeSplashes = []; // { mesh, dir, speed, life }

// NEW: Debug Markers
const debugGroup = new THREE.Group();
scene.add(debugGroup);

function updateDebugVisuals() {
  // Clear old markers
  while (debugGroup.children.length > 0) {
    debugGroup.remove(debugGroup.children[0]);
  }

  // Chaser Marker (Green)
  if (enemyMesh) {
    const geom = new THREE.SphereGeometry(0.5, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, depthTest: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(enemyMesh.position);
    mesh.position.y = wallHeight + 1; // float above
    debugGroup.add(mesh);

    // Line down
    const points = [new THREE.Vector3(0, -10, 0), new THREE.Vector3(0, 0, 0)];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(lineGeom, mat);
    mesh.add(line);
  }

  // Sweep Marker (Black)
  if (sweepMesh) {
    const geom = new THREE.SphereGeometry(0.5, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0x000000, wireframe: true, depthTest: false });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(sweepMesh.position);
    mesh.position.y = wallHeight + 1;
    debugGroup.add(mesh);

    const points = [new THREE.Vector3(0, -10, 0), new THREE.Vector3(0, 0, 0)];
    const lineGeom = new THREE.BufferGeometry().setFromPoints(points);
    const line = new THREE.Line(lineGeom, mat);
    mesh.add(line);
  }
}

// keep a reference enemyHeight for later camera alignment on catch
const ENEMY_HEIGHT = wallHeight * 0.75;

// Simple collision: check future camera position against colliders bounding boxes
function collides(pos) {
  // If noclip mod is enabled, ignore collisions so the player can pass through walls
  if (modNoclip) return false;

  const pad = 0.18;
  const box = new THREE.Box3(
    new THREE.Vector3(pos.x - pad, pos.y - 0.3, pos.z - pad),
    new THREE.Vector3(pos.x + pad, pos.y + 0.3, pos.z + pad)
  );
  for (const cb of colliderBoxes) {
    if (cb.intersectsBox(box)) return true;
  }
  // also collide with closed doors (doors with an active bounding box)
  for (const d of doorStates) {
    if (!d.box) continue;
    if (d.box.intersectsBox(box)) return true;
  }
  return false;
}

// Enemy collision: slightly slimmer bounds so it can fit through doorways
function enemyCollides(pos) {
  const pad = 0.06; // reduced padding to prevent sticking on door frames
  const box = new THREE.Box3(
    new THREE.Vector3(pos.x - pad, 0.0, pos.z - pad),
    new THREE.Vector3(pos.x + pad, wallHeight, pos.z + pad)
  );
  // collide with static wall colliders
  for (const cb of colliderBoxes) {
    if (cb.intersectsBox(box)) return true;
  }
  // also collide with any closed doors (those with an active bounding box)
  for (const d of doorStates) {
    if (!d.box) continue;
    if (d.box.intersectsBox(box)) return true;
  }
  return false;
}

// enemy auto-opens doors it bumps into
function enemyOpenNearbyDoors() {
  if (!enemyMesh || !doorStates.length) return;
  const enemyPos = enemyMesh.position;

  const openRadius = TILE * 0.75;
  const openRadiusSq = openRadius * openRadius;

  for (const d of doorStates) {
    if (d.isOpen) continue;
    const doorPos = new THREE.Vector3();
    d.group.getWorldPosition(doorPos);
    const dx = doorPos.x - enemyPos.x;
    const dz = doorPos.z - enemyPos.z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= openRadiusSq) {
      openDoorState(d, true);
    }
  }
}

// create minimap canvas and helper
const minimap = document.getElementById('minimap');
const mmCtx = minimap.getContext('2d');
const mmW = minimap.width;
const mmH = minimap.height;
function drawMinimap() {
  // defensive: ensure we have a valid canvas context
  if (!mmCtx || !minimap) return;

  // clear
  try { mmCtx.clearRect(0, 0, mmW, mmH); } catch (e) { return; }

  // scale to grid
  const px = Math.floor(mmW / GW);
  const py = Math.floor(mmH / GH);
  const s = Math.max(1, Math.min(px, py));

  // background
  mmCtx.fillStyle = '#070707';
  mmCtx.fillRect(0, 0, mmW, mmH);

  // draw floor/corridor tiles
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      if (grid && grid[y] && grid[y][x]) {
        mmCtx.fillStyle = '#2b2b2b'; // floor
        mmCtx.fillRect(x * s, y * s, s, s);
      }
    }
  }

  // Draw exits (guard for exitStates entries)
  if (Array.isArray(exitStates)) {
    for (const es of exitStates) {
      if (!es || !es.mesh || !es.mesh.position) continue;
      const gx = Math.floor((es.mesh.position.x / TILE) + GW / 2);
      const gy = Math.floor((es.mesh.position.z / TILE) + GH / 2);
      // Green if active (uncollected), Red if used (collected)
      mmCtx.fillStyle = es.collected ? '#ff0000' : '#00ff00';
      mmCtx.fillRect(gx * s, gy * s, s, s);
    }
  }

  // get player grid coordinates once
  const p = controls && controls.getObject ? controls.getObject().position : { x: 0, z: 0 };
  const gx = Math.floor((p.x / TILE) + GW / 2);
  const gy = Math.floor((p.z / TILE) + GH / 2);

  // determine which room (if any) the player is currently in
  let currentRoom = null;
  if (Array.isArray(rooms)) {
    for (const r of rooms) {
      if (!r) continue;
      if (gx >= r.x && gx < r.x + r.w && gy >= r.y && gy < r.y + r.h) {
        currentRoom = r;
        break;
      }
    }
  }

  // draw rooms, highlighting the current room in green
  if (Array.isArray(rooms)) {
    for (const r of rooms) {
      if (!r) continue;
      if (currentRoom && r === currentRoom) {
        mmCtx.fillStyle = '#00aa00';
      } else {
        mmCtx.fillStyle = '#b0b0b0';
      }
      mmCtx.fillRect(r.x * s, r.y * s, r.w * s, r.h * s);
    }
  }

  // draw player icon
  const playerCx = gx * s + s / 2;
  const playerCy = gy * s + s / 2;
  const playerSize = Math.max(6, Math.floor(s * 1.6));
  if (playerIcon && playerIcon.complete) {
    try {
      mmCtx.drawImage(playerIcon, playerCx - playerSize / 2, playerCy - playerSize / 2, playerSize, playerSize);
    } catch (e) {
      // ignore drawing errors
    }
  } else {
    // fallback small circle
    mmCtx.fillStyle = '#00ff80';
    mmCtx.beginPath();
    mmCtx.arc(playerCx, playerCy, 5, 0, Math.PI * 2);
    mmCtx.fill();
  }

  // show enemy (Balder) if walkie talkie active OR if modBaldiIcon toggled: draw Balder icon blinking
  const now = clock.getElapsedTime();
  const shouldShowBalder = (typeof enemyMesh !== 'undefined' && enemyMesh && (now < showEnemyOnMinimapUntil)) || (typeof enemyMesh !== 'undefined' && enemyMesh && modBaldiIcon);
  if (enemyMesh && shouldShowBalder) {
    if (Math.floor(now * 10) % 2 === 0) {
      if (enemyMesh.position) {
        const ex = Math.floor((enemyMesh.position.x / TILE) + GW / 2);
        const ey = Math.floor((enemyMesh.position.z / TILE) + GH / 2);
        const enemyCx = ex * s + s / 2;
        const enemyCy = ey * s + s / 2;
        const iconSize = Math.max(6, Math.floor(s * 1.6));
        if (balderIcon && balderIcon.complete) {
          try {
            mmCtx.drawImage(balderIcon, enemyCx - iconSize / 2, enemyCy - iconSize / 2, iconSize, iconSize);
          } catch (e) { }
        } else {
          mmCtx.fillStyle = '#ff0000';
          mmCtx.beginPath();
          mmCtx.arc(enemyCx, enemyCy, 5, 0, Math.PI * 2);
          mmCtx.fill();
        }
      }
    }
  }

  // NEW: show all uncollected notebooks as blinking icons
  if (Array.isArray(notebookStates) && notebookStates.length) {
    for (let i = 0; i < notebookStates.length; i++) {
      const nb = notebookStates[i];
      if (!nb || nb.collected) continue;
      if (!nb.mesh || !nb.mesh.position) continue;
      const nbPos = nb.mesh.position;
      const nx = Math.floor((nbPos.x / TILE) + GW / 2);
      const ny = Math.floor((nbPos.z / TILE) + GH / 2);
      const cx = nx * s + s / 2;
      const cy = ny * s + s / 2;
      const iconSize = Math.max(6, Math.floor(s * 1.2));
      const blink = (Math.floor(now * 4 + (i % 3)) % 2) === 0;
      if (notebookIcon && notebookIcon.complete) {
        // slightly tint/alpha when blinking to emulate the old blink
        mmCtx.globalAlpha = blink ? 1.0 : 0.7;
        try {
          mmCtx.drawImage(notebookIcon, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
        } catch (e) { }
        mmCtx.globalAlpha = 1.0;
      } else {
        mmCtx.fillStyle = blink ? '#ffff66' : '#ffd400';
        const size = Math.max(2, Math.min(6, Math.floor(s * 0.6)));
        mmCtx.beginPath();
        mmCtx.arc(cx, cy, size, 0, Math.PI * 2);
        mmCtx.fill();
        mmCtx.strokeStyle = 'rgba(0,0,0,0.6)';
        mmCtx.lineWidth = 1;
        mmCtx.stroke();
      }
    }
  }

  // NEW: show nearest notebook when peaceful walkie used (retain cyan blink)
  if (now < showNotebookOnMinimapUntil && showNotebookIndex >= 0 && Array.isArray(notebookStates) && notebookStates[showNotebookIndex] && !notebookStates[showNotebookIndex].collected) {
    const nbEntry = notebookStates[showNotebookIndex];
    if (nbEntry && nbEntry.mesh && nbEntry.mesh.position) {
      const nbPos = nbEntry.mesh.position;
      const nx = Math.floor((nbPos.x / TILE) + GW / 2);
      const ny = Math.floor((nbPos.z / TILE) + GH / 2);
      const noteCx = nx * s + s / 2;
      const noteCy = ny * s + s / 2;
      mmCtx.save();
      mmCtx.globalAlpha = 0.95;
      mmCtx.fillStyle = '#00ffff';
      mmCtx.beginPath();
      mmCtx.arc(noteCx, noteCy, 5, 0, Math.PI * 2);
      mmCtx.fill();
      mmCtx.restore();
    }
  }
}

// Resize
window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// Raycaster for clicking doors, notebooks, and items
const raycaster = new THREE.Raycaster();
const mouseCenter = new THREE.Vector2(0, 0);
const INTERACT_REACH = TILE * 2;

function triggerWin() {
  // If already in a final win state, ignore
  if (isGameWon) return;

  // If we have more floors to play, advance to next floor instead of final win overlay
  if (currentFloor < maxFloors) {
    // stop sounds and show a brief transition (blackout)
    stopAllSounds();
    blackoutOverlay.style.display = 'block';
    // small delay to make transition feel noticeable
    setTimeout(() => {
      // increment floor and re-init the game state for the next floor while keeping the same seed
      currentFloor++;
      // re-run initGame to generate a fresh layout for the new floor
      initGame();
      // ensure menus remain hidden and UI shown
      if (mainMenuEl) mainMenuEl.style.display = 'none';
      if (minimap) minimap.style.display = 'block';
      if (inventoryEl) inventoryEl.style.display = 'flex';
      // hide blackout and update displays
      blackoutOverlay.style.display = 'none';
      updateInfoDisplays();
      // Reset camera lock state/time
      lastFrameTime = performance.now() * 0.001;
    }, 1000);
    return;
  }

  // Otherwise this is the final floor completion: show final win overlay
  isGameWon = true;
  isGameOver = true; // stops updates

  // persist points on win
  try {
    localStorage.setItem('rooms_maze_points', String(points));
  } catch (e) { }

  // stop all audio immediately on win
  stopAllSounds();

  // Disable controls
  controls.unlock();
  controls.enabled = false;

  // Show win overlay
  if (winOverlay) {
    winOverlay.style.display = 'flex';
  }

  // Hide UI
  if (notebookCounterEl) notebookCounterEl.style.display = 'none';
  if (seedDisplayEl) seedDisplayEl.style.display = 'none';
  if (difficultyDisplayEl) difficultyDisplayEl.style.display = 'none';
  if (inventoryEl) inventoryEl.style.display = 'none';
  if (minimap) minimap.style.display = 'none';
  const wm = document.getElementById('watermark');
  if (wm) wm.style.display = 'none';
}

function tryInteractExit() {
  if (!darkModeApplied) return;
  if (!exitStates.length) return;

  raycaster.setFromCamera(mouseCenter, camera);
  const meshes = exitStates.map(e => e.mesh);
  const hits = raycaster.intersectObjects(meshes, false);

  if (!hits.length) return;
  const hit = hits[0];
  if (hit.distance > INTERACT_REACH) return;

  const es = exitStates.find(e => e.mesh === hit.object);
  if (!es || es.collected) return;

  // Collect exit
  es.collected = true;
  es.mesh.material = exitUsedMat; // Switch texture

  exitsCollected++;
  updateNotebookCounter();

  // Win condition check
  if (exitsCollected >= exitsNeeded) {
    triggerWin();
  }
}

// shared helper to open a door state (used by player and enemy)
function openDoorState(door, openedByEnemy = false) {
  if (!door) return;
  const now = clock.getElapsedTime();
  if (door.isOpen && now < door.openUntil) return;

  // open door: switch both sides to opened sprite and disable collision for 3 seconds
  door.front.material = doorOpenedMat;
  door.back.material = doorOpenedMat;
  door.box = null;
  door.isOpen = true;
  door.openUntil = now + 3.0;

  // play open sound with distance-based volume
  playDoorSoundForDoor(doorOpenSound, door.group);

  // NEW: Check if door is within a silent area (WD40 effect)
  const doorPos = new THREE.Vector3();
  door.group.getWorldPosition(doorPos);

  let isSilenced = false;
  for (const area of activeSilentAreas) {
    const dx = area.x - doorPos.x;
    const dz = area.z - doorPos.z;
    if (dx * dx + dz * dz <= area.radius * area.radius) {
      isSilenced = true;
      break;
    }
  }

  // NEW: notify chaser AI of door opening if not in ANGRY mode
  // Only trigger if NOT opened by enemy AND not silenced
  if (chaserAI.state !== AI_STATES.ANGRY && !openedByEnemy && enemyMesh && !isSilenced) {
    const distance = enemyMesh.position.distanceTo(doorPos);
    const hearingRange = 26 * TILE; // approx 54 world units

    // Visual indicator logic (Baldicator)
    if (baldicatorEl) {
      // Always reset any existing timeout so the indicator stays fresh
      if (baldicatorTimeout) clearTimeout(baldicatorTimeout);
      baldicatorEl.style.display = 'none'; // force hide to ensure reset if needed

      if (distance <= hearingRange) {
        baldicatorEl.src = './Baldicator_Look.webp';
      } else {
        baldicatorEl.src = './Baldicator_Think.webp';
      }

      // Force a reflow to ensure display change registers if it was already block
      void baldicatorEl.offsetWidth;
      baldicatorEl.style.display = 'block';

      baldicatorTimeout = setTimeout(() => {
        baldicatorEl.style.display = 'none';
        baldicatorTimeout = null;
      }, 2000);
    }

    // Only switch to HEARD if within hearing range
    if (distance <= hearingRange) {
      chaserAI.state = AI_STATES.HEARD;
      chaserAI.heardDoorPos = doorPos.clone();
      chaserAI.investigatingRoomIndex = door.roomIndex;
      chaserAI.isInvestigating = false;
      // Force path update
      enemyState.lastPathUpdate = 0;
    }
  }
}

function tryOpenDoor() {
  if (!doorStates.length) return;
  raycaster.setFromCamera(mouseCenter, camera);
  const doorMeshes = doorStates.flatMap(d => [d.front, d.back]);
  const hits = raycaster.intersectObjects(doorMeshes, false);
  if (!hits.length) return;

  const hit = hits[0];
  if (hit.distance > INTERACT_REACH) return;

  const hitMesh = hit.object;
  const door = doorStates.find(d => d.front === hitMesh || d.back === hitMesh);
  if (!door) return;

  openDoorState(door);
}

function tryCollectNotebook() {
  if (!notebookStates.length) return;
  raycaster.setFromCamera(mouseCenter, camera);
  const notebookMeshes = notebookStates.filter(n => !n.collected).map(n => n.mesh);
  if (!notebookMeshes.length) return;
  const hits = raycaster.intersectObjects(notebookMeshes, false);
  if (!hits.length) return;

  const hit = hits[0];
  if (hit.distance > INTERACT_REACH) return;

  const mesh = hit.object;
  const nb = notebookStates.find(n => n.mesh === mesh && !n.collected);
  if (!nb) return;

  nb.collected = true;
  nb.mesh.visible = false;
  // record grid coords of this collected notebook so future spawns avoid appearing exactly at it
  try {
    const gridX = Math.floor(nb.mesh.position.x / TILE + GW / 2);
    const gridY = Math.floor(nb.mesh.position.z / TILE + GH / 2);
    lastCollectedNotebookGrid = { x: gridX, y: gridY };
  } catch (e) {
    lastCollectedNotebookGrid = null;
  }
  notebooksCollected = Math.min(notebooksCollected + 1, totalRooms);

  // Award 1 point per notebook collected and persist immediately
  try {
    const oldPoints = (typeof points === 'number' ? points : 0);
    points = oldPoints + 1;
    localStorage.setItem('rooms_maze_points', String(points));
    // show animated feedback for +1
    showPointsEarned(1);
  } catch (e) {
    // ignore storage errors
  }
  // update any info displays that show points
  updateInfoDisplays();

  // NEW: Regenerate player's stamina on notebook pickup (fully refill)
  currentStamina = maxStamina;
  if (staminaBarEl) staminaBarEl.style.width = `${(currentStamina / maxStamina) * 100}%`;

  updateNotebookCounter();
  checkNotebookCompletion();

  // play pickup sound
  try {
    notebookPickupSound.currentTime = 0;
    notebookPickupSound.play();
  } catch (e) {
    // ignore playback errors (e.g., autoplay restrictions)
  }

  // If this pickup resulted in collecting all notebooks, start the RUN.. loop and mark time
  if (totalRooms > 0 && notebooksCollected >= totalRooms) {
    // mark moment when all collected (if not already marked)
    if (!allNotebooksCollectedAt) {
      allNotebooksCollectedAt = clock.getElapsedTime();
      // reset any previous speed bonus
      enemySpeedBonus = 0.0;
      try {
        runSound.currentTime = 0;
        runSound.play();
      } catch (e) {
        // ignore autoplay/permission errors
      }
    }
  }
}

// NEW: picking up items into inventory (blue soda, purple chocolate)
function tryPickupItem() {
  if (!itemStates.length) return;
  raycaster.setFromCamera(mouseCenter, camera);
  const availableMeshes = itemStates.map(i => i.mesh);
  if (!availableMeshes.length) return;
  const hits = raycaster.intersectObjects(availableMeshes, false);
  if (!hits.length) return;

  const hit = hits[0];
  if (hit.distance > INTERACT_REACH) return;

  const mesh = hit.object;
  const item = itemStates.find(i => i.mesh === mesh);
  if (!item) return;

  // If this is a points pickup, award points directly and do NOT put into inventory
  if (item.type && item.type.startsWith('point_')) {
    // base random between 55 and 75 inclusive
    const base = Math.floor(rng() * (75 - 55 + 1)) + 55;
    let multiplier = 1;
    if (item.type === 'point_orange') multiplier = 1;
    else if (item.type === 'point_green') multiplier = 2;
    else if (item.type === 'point_pink') multiplier = 3;
    else if (item.type === 'point_mega') multiplier = 7;

    const award = base * multiplier;
    // update persistent points and HUD animation
    try {
      const oldPoints = (typeof points === 'number' ? points : 0);
      points = oldPoints + award;
      localStorage.setItem('rooms_maze_points', String(points));
      showPointsEarned(award);
    } catch (e) {
      // ignore storage errors
    }
    updateInfoDisplays();

    // play pickup sound and remove the world mesh
    try {
      notebookPickupSound.currentTime = 0;
      notebookPickupSound.play();
    } catch (e) { }

    itemGroup.remove(item.mesh);
    itemStates.splice(itemStates.indexOf(item), 1);
    refreshInventoryHUD(); // keep HUD state correct
    return;
  }

  // Existing logic for normal inventory items (unchanged)
  const newItem = { type: item.type };

  // find next free slot
  let freeIndex = inventory.findIndex(s => s === null);
  if (freeIndex !== -1) {
    inventory[freeIndex] = newItem;
    // remove world item
    itemGroup.remove(item.mesh);
    itemStates.splice(itemStates.indexOf(item), 1);
  } else {
    // no free slot: replace item in currently selected slot
    const current = inventory[selectedInvIndex];
    if (!current) {
      // shouldn't happen if no free slot, but just in case
      inventory[selectedInvIndex] = newItem;
      itemGroup.remove(item.mesh);
      itemStates.splice(itemStates.indexOf(item), 1);
    } else {
      // swap: world item becomes the item we were holding
      const oldType = current.type;

      // update world item state and visual to match the dropped item
      item.type = oldType;
      item.mesh.userData.type = oldType;

      if (oldType === 'blue_soda') item.mesh.material = blueSodaMat;
      else if (oldType === 'purple_chocolate') item.mesh.material = purpleChocolateMat;
      else if (oldType === 'walkie_talkie') item.mesh.material = walkieTalkieMat;
      else if (oldType === 'wd40') item.mesh.material = wd40Mat;
      else if (oldType === 'old_boots') item.mesh.material = oldBootsMat;

      inventory[selectedInvIndex] = newItem;
    }
  }

  refreshInventoryHUD();
}

// Listen for clicks to interact (items, notebooks, then doors)
window.addEventListener('mousedown', (e) => {
  // block interactions while main menu is open OR loading
  if (isMainMenu || !inputReady) return;

  // primary button: interact
  if (e.button === 0) {
    // NEW: no interaction when game over
    if (isGameOver) return;

    // try pickups in order: items first, then notebooks/exits, then doors
    tryPickupItem();
    tryCollectNotebook();
    tryInteractExit();
    tryOpenDoor();
  }

  // right mouse button: use held item
  if (e.button === 2) {
    e.preventDefault();
    if (isGameOver) return;
    useHeldItem();
  }
});

// also prevent default context menu so right-click feels clean
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

let lastFrameTime = 0;
// targetDelta is defined earlier and adjusted by applyRenderMode

const baseEnemySpeed = 3.5;
const enemyPathUpdateInterval = 0.25;

// --- NEW: spawn items near room sides, away from doors ---

// build quick lookup for doors by room index and direction
const doorsByRoomDir = new Map();

// helper: given room and side, compute a candidate position a bit inside the room
function sidePosition(room, side) {
  const margin = 0.6; // how far in from wall (in grid tiles)
  const innerX0 = room.x + 0.2;
  const innerX1 = room.x + room.w - 0.2;
  const innerY0 = room.y + 0.2;
  const innerY1 = room.y + room.h - 0.2;

  let gx, gy;
  if (side === 'N') {
    gx = innerX0 + rng() * (innerX1 - innerX0);
    gy = room.y + margin;
  } else if (side === 'S') {
    gx = innerX0 + rng() * (innerX1 - innerX0);
    gy = room.y + room.h - margin;
  } else if (side === 'W') {
    gx = room.x + margin;
    gy = innerY0 + rng() * (innerY1 - innerY0);
  } else { // 'E'
    gx = room.x + room.w - margin;
    gy = innerY0 + rng() * (innerY1 - innerY0);
  }

  const wx = (gx - GW / 2) * TILE;
  const wz = (gy - GH / 2) * TILE;
  return { wx, wz, gx, gy };
}

// helper: check if candidate is near any door for this room on that side
function isNearDoor(roomIndex, side, gx, gy) {
  const entry = doorsByRoomDir.get(roomIndex);
  if (!entry) return false;
  const doorsForSide = entry[side] || [];
  const maxDist = 1.2; // in grid tiles
  for (const dInfo of doorsForSide) {
    const d = dInfo.door;
    // door is on inside edge of room at grid cell d.x,d.y
    const dx = d.x - gx;
    const dy = d.y - gy;
    if (dx * dx + dy * dy <= maxDist * maxDist) return true;
  }
  return false;
}

function spawnRoomItems() {
  if (!rooms.length) return;
  const settings = diffSettings[currentDifficulty];

  // helper: pick a random side of a room
  function randomSideRoom(room) {
    const sides = ['N', 'S', 'E', 'W'].sort(() => rng() - 0.5);
    for (const side of sides) {
      const pos = sidePosition(room, side);
      if (!isNearDoor(room.index, side, pos.gx, pos.gy)) {
        return pos;
      }
    }
    return null;
  }

  rooms.forEach((room, ri) => {
    // Difficulty chance check
    if (rng() > settings.itemChance) return;

    // Increased chance: 80% to have at least one item
    if (rng() < 0.2) return;

    // Up to 2 items per room
    const itemCount = rng() < 0.4 ? 2 : 1;
    const sides = ['N', 'S', 'E', 'W'].sort(() => rng() - 0.5);

    let spawned = 0;
    for (const side of sides) {
      if (spawned >= itemCount) break;
      const pos = sidePosition(room, side);
      if (isNearDoor(ri, side, pos.gx, pos.gy)) {
        continue;
      }

      // choose item type
      const r = rng();
      let itemType, mat;
      // Common items still fill most cases; rare chance to spawn point pickups (non-inventory)
      if (r < 0.45) {
        itemType = 'blue_soda';
        mat = blueSodaMat;
      } else if (r < 0.68) {
        itemType = 'purple_chocolate';
        mat = purpleChocolateMat;
      } else if (r < 0.80) {
        itemType = 'walkie_talkie';
        mat = walkieTalkieMat;
      } else if (r < 0.88) {
        itemType = 'wd40';
        mat = wd40Mat;
      } else if (r < 0.94) {
        // standard pickup item
        itemType = 'old_boots';
        mat = oldBootsMat;
      } else {
        // Rare: spawn a points pickup (one of 4 variants)
        const pr = rng();
        if (pr < 0.60) {
          itemType = 'point_orange';
          mat = orangePointMat;
        } else if (pr < 0.80) {
          itemType = 'point_green';
          mat = greenPointMat;
        } else if (pr < 0.95) {
          itemType = 'point_pink';
          mat = pinkPointMat;
        } else {
          itemType = 'point_mega';
          mat = megaPointMat;
        }
      }

      const size = 0.8;
      const geom = new THREE.PlaneGeometry(size, size);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(pos.wx, wallHeight / 2, pos.wz);
      mesh.userData.type = itemType;
      itemGroup.add(mesh);
      itemStates.push({ mesh, type: itemType, roomIndex: ri, baseY: wallHeight / 2 });
      spawned++;
    }
  });
}

function spawnHallwayItems() {
  // find 2-cell-wide hallway segments (double-wide corridors) and rarely spawn items there
  const settings = diffSettings[currentDifficulty];
  const hallwaySegments = [];

  // horizontal double-wide corridors: rows y and y+1 both corridor and not in rooms
  for (let y = 0; y < GH - 1; y++) {
    let start = -1;
    for (let x = 0; x < GW; x++) {
      const top = grid[y][x] && !roomAtGrid(x, y);
      const bottom = grid[y + 1][x] && !roomAtGrid(x + 1, y);
      if (top && bottom) {
        if (start === -1) start = x;
      } else {
        if (start !== -1 && x - start >= 2) {
          hallwaySegments.push({ x: start, y, len: x - start, dir: 'H2' });
        }
        start = -1;
      }
    }
    if (start !== -1 && GW - start >= 2) {
      hallwaySegments.push({ x: start, y, len: GW - start, dir: 'H2' });
    }
  }

  // vertical double-wide corridors: columns x and x+1 both corridor and not in rooms
  for (let x = 0; x < GW - 1; x++) {
    let start = -1;
    for (let y = 0; y < GH; y++) {
      const left = grid[y][x] && !roomAtGrid(x, y);
      const right = grid[y][x + 1] && !roomAtGrid(x + 1, y);
      if (left && right) {
        if (start === -1) start = y;
      } else {
        if (start !== -1 && y - start >= 2) {
          hallwaySegments.push({ x, y: start, len: y - start, dir: 'V2' });
        }
        start = -1;
      }
    }
    if (start !== -1 && GH - start >= 2) {
      hallwaySegments.push({ x, y: start, len: GH - start, dir: 'V2' });
    }
  }

  // spawn items very rarely (e.g. 7% chance per double-wide segment)
  hallwaySegments.forEach(seg => {
    if (rng() > 0.07) return;
    if (rng() > settings.itemChance) return;

    // pick midpoint of segment in world space
    const midOffset = Math.floor(seg.len / 2);
    let gx, gy;
    if (seg.dir === 'H2') {
      gx = seg.x + midOffset;
      gy = seg.y; // use top row of the 2-wide corridor
    } else { // 'V2'
      gx = seg.x; // use left column of the 2-wide corridor
      gy = seg.y + midOffset;
    }

    const wx = (gx - GW / 2 + 0.5) * TILE;
    const wz = (gy - GH / 2 + 0.5) * TILE;

    // mix of items in wide halls
    const r = rng();
    let itemType, mat;
    // Mirror room-spawn probabilities but slightly favor normal items; include rare point pickups
    if (r < 0.45) {
      itemType = 'blue_soda';
      mat = blueSodaMat;
    } else if (r < 0.68) {
      itemType = 'purple_chocolate';
      mat = purpleChocolateMat;
    } else if (r < 0.80) {
      itemType = 'walkie_talkie';
      mat = walkieTalkieMat;
    } else if (r < 0.88) {
      itemType = 'wd40';
      mat = wd40Mat;
    } else if (r < 0.94) {
      itemType = 'old_boots';
      mat = oldBootsMat;
    } else {
      const pr = rng();
      if (pr < 0.60) {
        itemType = 'point_orange';
        mat = orangePointMat;
      } else if (pr < 0.80) {
        itemType = 'point_green';
        mat = greenPointMat;
      } else if (pr < 0.95) {
        itemType = 'point_pink';
        mat = pinkPointMat;
      } else {
        itemType = 'point_mega';
        mat = megaPointMat;
      }
    }

    const size = 0.8;
    const geom = new THREE.PlaneGeometry(size, size);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(wx, wallHeight / 2, wz);
    mesh.userData.type = itemType;
    itemGroup.add(mesh);
    itemStates.push({ mesh, type: itemType, roomIndex: null, baseY: wallHeight / 2 });
  });
}



// initial inventory HUD
refreshInventoryHUD();

// NEW: use current held inventory item (right-click)
function useHeldItem() {
  const item = inventory[selectedInvIndex];
  if (!item) return;

  // Helper to optionally consume depending on modInfItems
  function maybeConsume() {
    if (!modInfItems) {
      inventory[selectedInvIndex] = null;
      refreshInventoryHUD();
    }
  }

  if (item.type === 'blue_soda') {
    // consume item (unless inf items)
    maybeConsume();

    // play soda opening sound
    try {
      sodaOpenSound.currentTime = 0;
      sodaOpenSound.play();
    } catch (e) {
      // ignore playback errors (e.g., autoplay restrictions)
    }

    // spawn splash billboard
    const dirVec = new THREE.Vector3();
    camera.getWorldDirection(dirVec);
    dirVec.y = 0;
    if (dirVec.lengthSq() === 0) {
      dirVec.set(0, 0, -1);
    }
    dirVec.normalize();

    const splashSize = wallHeight;
    const geom = new THREE.PlaneGeometry(splashSize, splashSize);
    const mesh = new THREE.Mesh(geom, splashMat);

    const origin = controls.getObject().position.clone();
    const startOffset = 0.6;
    mesh.position.set(
      origin.x + dirVec.x * startOffset,
      splashSize / 2,
      origin.z + dirVec.z * startOffset
    );

    // face along direction of travel
    const angle = Math.atan2(dirVec.x, dirVec.z);
    mesh.rotation.y = angle;

    splashGroup.add(mesh);
    activeSplashes.push({
      mesh,
      dir: dirVec.clone(),
      speed: 7.0,
      life: 5.0
    });
  } else if (item.type === 'purple_chocolate') {
    // consume item unless inf items
    maybeConsume();

    // play chocolate crunch sound
    try {
      purpleChocolateSound.currentTime = 0;
      purpleChocolateSound.play();
    } catch (e) {
      // ignore playback errors
    }

    // apply speed boost for 12 seconds (no dark mode / lighting changes)
    const now = clock.getElapsedTime();
    speedBoostUntil = now + 12.0;

    // immediately top off stamina
    currentStamina = maxStamina;

  } else if (item.type === 'walkie_talkie') {
    // consume item unless inf items
    maybeConsume();

    const now = clock.getElapsedTime();
    if (isPeaceful()) {
      // reveal nearest uncollected notebook on the minimap for a short time
      let nearestIdx = -1;
      let bestDist = Infinity;
      const playerPos = controls.getObject().position;
      for (let i = 0; i < notebookStates.length; i++) {
        const nb = notebookStates[i];
        if (!nb || nb.collected) continue;
        const d = nb.mesh.position.distanceTo(playerPos);
        if (d < bestDist) {
          bestDist = d;
          nearestIdx = i;
        }
      }
      if (nearestIdx !== -1) {
        showNotebookIndex = nearestIdx;
        showNotebookOnMinimapUntil = now + 8.0;
      } else {
        // fallback behaviour: small beep if no notebooks available
        try { walkieTalkieBeepSound.currentTime = 0; walkieTalkieBeepSound.play(); } catch (e) { }
      }
    } else {
      // original behaviour: show enemy on minimap for 8 seconds
      showEnemyOnMinimapUntil = now + 8.0;

      // play walkie-talkie beep sound
      try {
        walkieTalkieBeepSound.currentTime = 0;
        walkieTalkieBeepSound.play();
      } catch (e) { }
    }
  } else if (item.type === 'wd40') {
    // consume item unless inf items
    maybeConsume();

    // Create silent area (5 tiles radius)
    const pos = controls.getObject().position.clone();
    const radius = TILE * 5;
    const duration = 180.0; // 3 minutes
    const now = clock.getElapsedTime();

    // Create visual effect group
    const group = new THREE.Group();
    // Center vertically on camera so particles surround the player's view
    group.position.set(pos.x, pos.y, pos.z);

    // Add WAY more sparkles to fill the vision
    const particleCount = 60;
    for (let i = 0; i < particleCount; i++) {
      const size = 0.1 + Math.random() * 0.5;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), sparkleMat);

      // random position within cylinder, centered on player
      const r = Math.sqrt(Math.random()) * radius; // uniform area distribution
      const theta = Math.random() * Math.PI * 2;
      // wider vertical spread relative to camera height
      const h = (Math.random() - 0.5) * 8.0;

      mesh.position.set(r * Math.cos(theta), h, r * Math.sin(theta));

      // Store random rotation params
      mesh.userData.rotSpeedY = (Math.random() - 0.5) * 4;
      mesh.userData.rotSpeedZ = (Math.random() - 0.5) * 4;

      group.add(mesh);
    }

    scene.add(group);

    activeSilentAreas.push({
      x: pos.x,
      z: pos.z,
      radius: radius,
      expiresAt: now + duration,
      group: group
    });

    // Play spray sound
    try {
      spraySound.currentTime = 0;
      spraySound.play();
    } catch (e) { }
  } else if (item.type === 'old_boots') {
    // consume item unless inf items
    maybeConsume();

    // Immune to sweep push for 4 minutes
    const now = clock.getElapsedTime();
    sweepImmunityUntil = now + 240.0;

    // play rustle sound
    try {
      notebookPickupSound.currentTime = 0;
      notebookPickupSound.play();
    } catch (e) { }
  }
}

// NEW: Restart Logic
let restartConfirmTimer = null;
let restartConfirmActive = false;

function handleRestartRequest() {
  if (!restartConfirmActive) {
    restartConfirmActive = true;
    if (restartConfirmEl) restartConfirmEl.style.display = 'block';

    // Clear any existing timer just in case
    if (restartConfirmTimer) clearTimeout(restartConfirmTimer);

    restartConfirmTimer = setTimeout(() => {
      restartConfirmActive = false;
      if (restartConfirmEl) restartConfirmEl.style.display = 'none';
    }, 5000);
  } else {
    // Confirmed
    if (restartConfirmTimer) clearTimeout(restartConfirmTimer);
    restartConfirmActive = false;
    if (restartConfirmEl) restartConfirmEl.style.display = 'none';
    goToMainMenu();
  }
}

function goToMainMenu() {
  // Stop everything
  // persist points when leaving to main menu
  try {
    localStorage.setItem('rooms_maze_points', String(points));
  } catch (e) { }
  stopAllSounds();
  // reset all-notebooks state
  allNotebooksCollectedAt = 0;
  enemySpeedBonus = 0.0;
  controls.unlock();

  // Hide In-Game UI
  if (notebookCounterEl) notebookCounterEl.style.display = 'none';
  if (seedDisplayEl) seedDisplayEl.style.display = 'none';
  if (difficultyDisplayEl) difficultyDisplayEl.style.display = 'none';
  if (inventoryEl) inventoryEl.style.display = 'none';
  if (minimap) minimap.style.display = 'none';
  if (pauseOverlay) pauseOverlay.style.display = 'none';
  if (staminaBarEl) staminaBarEl.parentElement.style.display = 'none';
  if (baldicatorEl) baldicatorEl.style.display = 'none';
  if (crosshair) document.getElementById('crosshair').style.display = 'none';

  // Show Main Menu
  isMainMenu = true;
  isPaused = false;
  isGameOver = false;
  if (mainMenuEl) mainMenuEl.style.display = 'flex';

  // Show watermark again if it was hidden
  const wm = document.getElementById('watermark');
  if (wm) wm.style.display = 'block';
}

// NEW: helper to pick random roaming target in hallways
function pickRoamingTarget(origin = null, minDistance = 0) {
  for (let i = 0; i < 5; i++) {
    const pos = getRandomHallwayPosition(grid, rooms, GW, GH, TILE, rng);
    if (!pos) continue;
    const vec = new THREE.Vector3(pos.x, pos.y, pos.z);
    if (origin && minDistance > 0) {
      if (origin.distanceTo(vec) >= minDistance) return vec;
    } else {
      return vec;
    }
  }
  // fallback if no distant point found
  const pos = getRandomHallwayPosition(grid, rooms, GW, GH, TILE, rng);
  return pos ? new THREE.Vector3(pos.x, pos.y, pos.z) : null;
}

// NEW: raycast to check if chaser can see player (360 degree vision)
function chaserCanSeePlayer() {
  if (!enemyMesh) return false;
  const playerPos = controls.getObject().position;
  const enemyPos = enemyMesh.position;

  // Check distance first
  const dx = enemyPos.x - playerPos.x;
  const dz = enemyPos.z - playerPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist > 15) return false;

  const dir = new THREE.Vector3(dx, 0, dz);
  if (dist > 0.001) dir.normalize();
  else dir.set(0, 0, -1);

  // Raycast from enemy to player to check for walls blocking line of sight
  // Limit ray length to distance to player minus padding to avoid hitting walls behind the player
  const raycaster = new THREE.Raycaster(enemyPos, dir, 0, Math.max(0, dist - 0.2));

  // Check against wall colliders and closed doors
  const obstacles = [...colliders];
  for (const d of doorStates) {
    // Explicitly treat non-open doors as visual obstacles
    if (!d.isOpen) obstacles.push(d.group);
  }

  const hits = raycaster.intersectObjects(obstacles, true);

  // If any hit occurs before reaching the player
  if (hits.length > 0) return false;

  return true;
}

// NEW: AI state machine logic
function animate(time) {
  // convert rAF time (ms) to seconds
  clock.update(time);
  const t = time * 0.001;
  const delta = t - lastFrameTime;
  const now = clock.getElapsed();

  // Ensure characters and schoolhouse loop are removed as soon as 2+ notebooks exist,
  // but only while in a running game (not while the main menu is shown).
  if (!isMainMenu) enforceTwoNotebookRule();

  // if main menu, skip logic
  if (isMainMenu) {
    requestAnimationFrame(animate);
    return;
  }

  // If we're in the Level Editor mode, allow the normal update loop to run so the player can move,
  // but keep editor UI visible and avoid forcing pointer-lock or main-menu transitions.
  if (inLevelEditor) {
    // Editor mode UI tweaks
    if (staminaBarEl) staminaBarEl.parentElement.style.display = 'none';
    if (document.getElementById('crosshair')) document.getElementById('crosshair').style.display = 'none';
    // Keep minimap and inventory visible as context (they were enabled on enter)
    drawMinimap();
    // Do not return here so the rest of the loop (movement, rendering, lightweight updates) runs;
    // heavy AI and timed systems will still run but the editor remains interactive and player can move.
  }

  // if paused, just keep rendering without updating game state
  if (isPaused) {
    // force camera to stay looked at the paused angle (prevents mouse look)
    camera.rotation.copy(pausedLook);

    lastFrameTime = t;
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
    return;
  }

  // lock update/render rate to 15fps
  if (delta < targetDelta) {
    requestAnimationFrame(animate);
    return;
  }

  lastFrameTime = t;
  const dt = Math.min(0.05, delta);

  // NEW: Update active silent areas (WD40 effect)
  for (let i = activeSilentAreas.length - 1; i >= 0; i--) {
    const area = activeSilentAreas[i];

    // Check expiration
    if (now > area.expiresAt) {
      scene.remove(area.group);
      activeSilentAreas.splice(i, 1);
      continue;
    }

    // Animate sparkles
    // Rotate entire group
    area.group.rotation.y += 0.5 * dt;

    // Rotate individual particles
    area.group.children.forEach(p => {
      p.rotation.z += (p.userData.rotSpeedZ || 1) * dt;
      p.lookAt(camera.position); // billboard effect mixed with rotation
    });
  }

  // NEW: if game over, skip all game state updates except rendering and minimap
  if (isGameOver) {
    if (isGameWon) {
      // Just render static scene if won, UI overlay handles the rest
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
      return;
    }
    if (isJumpScare) applyEnvironmentShake();
    drawMinimap();
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
    return;
  }

  // NEW: Debug Visuals
  updateDebugVisuals();

  // auto-close doors whose timer has expired
  // (now that we have `now` earlier, just reuse it)
  for (const d of doorStates) {
    if (d.isOpen && now > d.openUntil) {
      d.isOpen = false;
      d.front.material = doorClosedMat;
      d.back.material = doorClosedMat;
      d.box = new THREE.Box3().setFromObject(d.group);
      // expand box for consistent collision thickness
      d.box.expandByScalar(0.15);

      // play close sound with distance-based volume
      playDoorSoundForDoor(doorCloseSound, d.group);
    }
  }

  // make notebooks bob up/down and face the camera (billboard)
  for (const n of notebookStates) {
    if (!n.mesh.visible) continue;

    const bobSpeed = 1.2;
    const bobAmp = 0.12;
    const tBob = now * bobSpeed;
    const offset = Math.sin(tBob + n.baseY) * bobAmp;
    n.mesh.position.y = n.baseY + offset;

    const pos = n.mesh.position.clone();
    n.mesh.lookAt(new THREE.Vector3(camera.position.x, pos.y, camera.position.z));
  }

  // NEW: make items bob and face camera
  for (const it of itemStates) {
    const mesh = it.mesh;
    const bobSpeed = 1.4;
    const bobAmp = 0.08;
    const tBob = now * bobSpeed;
    const offset = Math.sin(tBob + it.baseY) * bobAmp;
    mesh.position.y = it.baseY + offset;

    const pos = mesh.position.clone();
    mesh.lookAt(new THREE.Vector3(camera.position.x, pos.y, camera.position.z));
  }

  // Show UI elements if playing
  if (!isMainMenu && !isGameOver) {
    if (staminaBarEl) staminaBarEl.parentElement.style.display = 'block';
    if (document.getElementById('crosshair')) document.getElementById('crosshair').style.display = 'block';
    // Inventory visibility is managed by initGame/pickup but we ensure it's visible here
    if (inventoryEl && inventoryEl.style.display === 'none') inventoryEl.style.display = 'flex';
  }

  // enemy AI: chase player using grid pathfinding
  // NOTE: the BFS path uses only `grid[y][x]` floor tiles as walkable nodes.
  // Doors are *visual planes between tiles*, not their own grid cells, so
  // the enemy "ignores door tiles" in the sense that it paths from room tile
  // center to corridor tile center and just walks through the door plane in between.
  if (enemyMesh) {
    const playerPos = controls.getObject().position;
    const playerGridX = Math.floor(playerPos.x / TILE + GW / 2);
    const playerGridY = Math.floor(playerPos.z / TILE + GH / 2);

    let enemyGridX = Math.floor(enemyMesh.position.x / TILE + GW / 2);
    let enemyGridY = Math.floor(enemyMesh.position.z / TILE + GH / 2);
    enemyState.gridX = enemyGridX;
    enemyState.gridY = enemyGridY;

    // let doors react when the enemy is close, same as if you opened them
    enemyOpenNearbyDoors();

    if (enemyState.pushTime > 0 && enemyState.pushDir) {
      // being pushed by a soda splash: move smoothly and pause pathfinding
      const dirToPush = enemyState.pushDir.clone();
      dirToPush.y = 0;
      if (dirToPush.lengthSq() > 0) {
        dirToPush.normalize();
        const moveDist = enemyState.pushSpeed * dt;

        const startPos = enemyMesh.position.clone();

        // try full push first
        const proposed = enemyMesh.position.clone().addScaledVector(dirToPush, moveDist);
        if (!enemyCollides(proposed)) {
          enemyMesh.position.copy(proposed);
        } else {
          // axis-separated sliding so it can slide through walls while being pushed
          const stepX = new THREE.Vector3(dirToPush.x, 0, 0).multiplyScalar(moveDist);
          const stepZ = new THREE.Vector3(0, 0, dirToPush.z).multiplyScalar(moveDist);

          const posX = enemyMesh.position.clone().add(stepX);
          if (!enemyCollides(posX)) {
            enemyMesh.position.copy(posX);
          }

          const posZ = enemyMesh.position.clone().add(stepZ);
          if (!enemyCollides(posZ)) {
            enemyMesh.position.copy(posZ);
          }
        }

        const movedDist = enemyMesh.position.distanceTo(startPos);

        // check if attached splash still exists in active list
        if (enemyState.pushAttachedSplash) {
          if (!activeSplashes.includes(enemyState.pushAttachedSplash)) {
            // splash was removed (hit a wall), stop push immediately
            enemyState.pushTime = 0;
            enemyState.pushDir = null;
            enemyState.pushAttachedSplash = null;
          } else if (movedDist < 0.001) {
            // if attached to a splash, stop pushing once we effectively collide with a wall
            // bounce back slightly when hitting wall
            const bounceBack = dirToPush.clone().multiplyScalar(-0.3);
            const bouncePos = enemyMesh.position.clone().add(bounceBack);
            if (!enemyCollides(bouncePos)) {
              enemyMesh.position.copy(bouncePos);
            }

            enemyState.pushTime = 0;
            enemyState.pushDir = null;

            const s = enemyState.pushAttachedSplash;
            const idx = activeSplashes.indexOf(s);
            if (idx !== -1) {
              splashGroup.remove(s.mesh);
              activeSplashes.splice(idx, 1);
            }
            enemyState.pushAttachedSplash = null;
          }
        } else {
          // old timed push behaviour if no visual splash attached
          enemyState.pushTime -= dt;
          if (enemyState.pushTime <= 0) {
            enemyState.pushTime = 0;
            enemyState.pushDir = null;
          }
        }
      }
    } else {
      // NEW: AI state machine logic
      const canSeePlayer = chaserCanSeePlayer();

      // State transitions based on vision and mode
      if (chaserAI.state === AI_STATES.ROAMING) {
        if (canSeePlayer) {
          chaserAI.state = AI_STATES.FOUND;
          chaserAI.lastSeenPlayerPos = playerPos.clone();
        } else {
          // Continue roaming
          if (!chaserAI.roamingTarget || enemyMesh.position.distanceTo(chaserAI.roamingTarget) < 1.0) {
            chaserAI.roamingTarget = pickRoamingTarget();
            chaserAI.roamingTimer = now;
          }
          // Change target every 8-12 seconds
          if (now - chaserAI.roamingTimer > 8 + rng() * 4) { // Changed Math.random to rng
            chaserAI.roamingTarget = pickRoamingTarget();
            chaserAI.roamingTimer = now;
          }
        }
      } else if (chaserAI.state === AI_STATES.HEARD) {
        if (canSeePlayer) {
          chaserAI.state = AI_STATES.FOUND;
          chaserAI.lastSeenPlayerPos = playerPos.clone();
          chaserAI.isInvestigating = false;
        } else if (chaserAI.heardDoorPos) {
          // Check if reached the target (door or room center)
          if (enemyMesh.position.distanceTo(chaserAI.heardDoorPos) < 1.5) {

            // If just reached the door and we know which room it belongs to, go inside
            if (!chaserAI.isInvestigating && chaserAI.investigatingRoomIndex !== null && chaserAI.investigatingRoomIndex !== -1) {
              chaserAI.isInvestigating = true;
              const r = rooms[chaserAI.investigatingRoomIndex];
              // Set target to room center
              const cx = (r.x + r.w / 2 - GW / 2) * TILE;
              const cz = (r.y + r.h / 2 - GH / 2) * TILE;
              chaserAI.heardDoorPos = new THREE.Vector3(cx, wallHeight / 2, cz);
              enemyState.lastPathUpdate = 0; // force immediate repath
            } else {
              // Reached room center (or door if no room info), return to roaming
              chaserAI.state = AI_STATES.ROAMING;
              chaserAI.heardDoorPos = null;
              chaserAI.investigatingRoomIndex = null;
              chaserAI.isInvestigating = false;
              chaserAI.roamingTarget = pickRoamingTarget();
              chaserAI.roamingTimer = now;
            }
          }
        }
      } else if (chaserAI.state === AI_STATES.FOUND) {
        if (canSeePlayer) {
          // Keep chasing
          chaserAI.lastSeenPlayerPos = playerPos.clone();
        } else {
          // Lost sight, go to last seen position (investigate)
          chaserAI.state = AI_STATES.HEARD;
          chaserAI.heardDoorPos = chaserAI.lastSeenPlayerPos ? chaserAI.lastSeenPlayerPos.clone() : null;
          chaserAI.investigatingRoomIndex = null;
          chaserAI.isInvestigating = false;
          // Force path update
          enemyState.lastPathUpdate = 0;
        }
      }
      // ANGRY mode: always chase player directly (handled below)

      // Determine target based on state
      let goalGridX, goalGridY;

      if (chaserAI.state === AI_STATES.ANGRY || chaserAI.state === AI_STATES.FOUND) {
        // Chase player directly
        goalGridX = playerGridX;
        goalGridY = playerGridY;
      } else if (chaserAI.state === AI_STATES.HEARD && chaserAI.heardDoorPos) {
        // Go to heard door position
        goalGridX = Math.floor(chaserAI.heardDoorPos.x / TILE + GW / 2);
        goalGridY = Math.floor(chaserAI.heardDoorPos.z / TILE + GH / 2);
      } else if (chaserAI.state === AI_STATES.ROAMING && chaserAI.roamingTarget) {
        // Go to roaming target
        goalGridX = Math.floor(chaserAI.roamingTarget.x / TILE + GW / 2);
        goalGridY = Math.floor(chaserAI.roamingTarget.z / TILE + GH / 2);
      } else {
        // Fallback: pick new roaming target
        chaserAI.roamingTarget = pickRoamingTarget();
        if (chaserAI.roamingTarget) {
          goalGridX = Math.floor(chaserAI.roamingTarget.x / TILE + GW / 2);
          goalGridY = Math.floor(chaserAI.roamingTarget.z / TILE + GH / 2);
        } else {
          goalGridX = playerGridX;
          goalGridY = playerGridY;
        }
      }

      // not currently being pushed: normal pathfinding and chase movement
      enemyState.pushTime = 0;
      enemyState.pushDir = null;

      // Logic to unlock from grid:
      // If we see the player in FOUND/ANGRY, run directly to him.
      // If we are HEARD and have no path (reached cell), run directly to door pos (not cell center).
      // If we are FOUND and reached the cell of last seen, run directly to last seen pos.

      const isChasing = (chaserAI.state === AI_STATES.ANGRY || chaserAI.state === AI_STATES.FOUND) && canSeePlayer;
      const sameCellAsPlayer = (enemyGridX === playerGridX && enemyGridY === playerGridY);

      // Only chase directly if strictly inside the same cell as the player.
      // Otherwise, stay on grid pathfinding to cell centers.
      const isDirectChase = isChasing && sameCellAsPlayer;

      const distToTarget = enemyMesh.userData.targetPos ? enemyMesh.position.distanceTo(enemyMesh.userData.targetPos) : Infinity;

      // Update target condition:
      // 1. Direct chase (update every frame/frequently for smoothness)
      // 2. Interval passed
      // 3. Close to current target node
      if (isDirectChase || now - enemyState.lastPathUpdate > enemyPathUpdateInterval || distToTarget < 0.5) {
        enemyState.lastPathUpdate = now;
        enemyState.targetGridX = goalGridX;
        enemyState.targetGridY = goalGridY;

        if (isDirectChase) {
          // Direct line to player
          enemyMesh.userData.targetPos = playerPos.clone();
          enemyMesh.userData.targetPos.y = enemyMesh.position.y;
        } else {
          // Grid pathfinding
          const nextStep = findNextStep(enemyGridX, enemyGridY, goalGridX, goalGridY, grid, GW, GH, blockedPathSet);

          if (nextStep) {
            // Move to center of next grid cell
            const targetWorldX = (nextStep.x - GW / 2 + 0.5) * TILE;
            const targetWorldZ = (nextStep.y - GH / 2 + 0.5) * TILE;
            enemyMesh.userData.targetPos = new THREE.Vector3(
              targetWorldX,
              enemyMesh.position.y,
              targetWorldZ
            );
          } else {
            // Reached goal cell (or no path), refine target to exact point of interest
            if (chaserAI.state === AI_STATES.HEARD && chaserAI.heardDoorPos) {
              enemyMesh.userData.targetPos = chaserAI.heardDoorPos.clone();
              enemyMesh.userData.targetPos.y = enemyMesh.position.y;
            } else if (chaserAI.state === AI_STATES.FOUND && chaserAI.lastSeenPlayerPos) {
              enemyMesh.userData.targetPos = chaserAI.lastSeenPlayerPos.clone();
              enemyMesh.userData.targetPos.y = enemyMesh.position.y;
            } else {
              // Standard grid center fallback (Roaming or generic)
              const targetWorldX = (goalGridX - GW / 2 + 0.5) * TILE;
              const targetWorldZ = (goalGridY - GH / 2 + 0.5) * TILE;
              enemyMesh.userData.targetPos = new THREE.Vector3(
                targetWorldX,
                enemyMesh.position.y,
                targetWorldZ
              );
            }
          }
        }
      }

      const targetPos = enemyMesh.userData.targetPos;
      if (targetPos) {
        const dirToTarget = targetPos.clone().sub(enemyMesh.position);
        dirToTarget.y = 0;
        const dist = dirToTarget.length();
        if (dist > 0.001) {
          dirToTarget.normalize();

          const settings = diffSettings[currentDifficulty];
          const base = baseEnemySpeed * settings.baseSpeedMult;

          // If player collected all notebooks, progressively increase enemy speed every 5s
          if (allNotebooksCollectedAt) {
            const secondsSince = Math.max(0, clock.getElapsedTime() - allNotebooksCollectedAt);
            const increments = Math.floor(secondsSince / 5);
            // Each increment gives a small bonus; clamp to reasonable cap
            enemySpeedBonus = Math.min(6.0, increments * 0.35); // ~+0.35 units every 5s, max +6
          } else {
            enemySpeedBonus = 0.0;
          }

          const currentSpeed = base + (notebooksCollected * settings.speedInc) + darkModeSpeedBonus + enemySpeedBonus;
          const moveDist = Math.min(dist, currentSpeed * dt);

          // try full move first
          const proposed = enemyMesh.position.clone().addScaledVector(dirToTarget, moveDist);
          if (!enemyCollides(proposed)) {
            enemyMesh.position.copy(proposed);
          } else {
            // axis-separated sliding like the player so it can slip through doorways
            const stepX = new THREE.Vector3(dirToTarget.x, 0, 0).multiplyScalar(moveDist);
            const stepZ = new THREE.Vector3(0, 0, dirToTarget.z).multiplyScalar(moveDist);

            const posX = enemyMesh.position.clone().add(stepX);
            if (!enemyCollides(posX)) {
              enemyMesh.position.copy(posX);
            }

            const posZ = enemyMesh.position.clone().add(stepZ);
            if (!enemyCollides(posZ)) {
              enemyMesh.position.copy(posZ);
            }
          }
        }
      }
    }

    // billboard towards camera
    enemyMesh.lookAt(new THREE.Vector3(camera.position.x, enemyMesh.position.y, camera.position.z));

    // update chase music volume based on proximity
    updateChaseMusic(controls.getObject().position, enemyMesh.position);

    // detect when enemy actually touches the player (no message or alert now)
    const toPlayer = new THREE.Vector3().subVectors(playerPos, enemyMesh.position);
    toPlayer.y = 0;
    const touchDist = 0.7;

    // NEW: Strict catch check to prevent catching through walls
    let validCatch = false;
    const distSq = toPlayer.lengthSq();
    if (distSq <= touchDist * touchDist) {
      const dist = Math.sqrt(distSq);
      // If very close, assume valid catch (clipping); otherwise raycast for walls
      if (dist < 0.1) {
        validCatch = true;
      } else {
        const catchRay = new THREE.Raycaster(enemyMesh.position, toPlayer.clone().normalize(), 0, dist);
        const obstacles = [...colliders];
        doorStates.forEach(d => { if (d.box) obstacles.push(d.group); });

        // Only catch if there is a clear line of sight (no walls/doors in between)
        if (catchRay.intersectObjects(obstacles, true).length === 0) {
          validCatch = true;
        }
      }
    }

    if (validCatch) {
      if (!modInvincible && !hasResetOnCatch) {
        hasResetOnCatch = true;
        isGameOver = true;
        isJumpScare = true;

        // lock controls so player can't move or look
        controls.unlock();
        controls.enabled = false;

        // stop/mute other ambience so the scream is dominant
        try {
          humSound.pause();
        } catch (e) { }
        try {
          chaseMusic.pause();
        } catch (e) { }

        // aim camera at top of billboard (face area), from a bit back so it's fully visible
        const faceTarget = new THREE.Vector3(
          enemyMesh.position.x,
          enemyMesh.position.y + ENEMY_HEIGHT * 0.2, // look slightly above center
          enemyMesh.position.z
        );
        const backDir = new THREE.Vector3().subVectors(controls.getObject().position, enemyMesh.position);
        backDir.y = 0;
        if (backDir.lengthSq() === 0) {
          backDir.set(0, 0, 1);
        }
        // bring camera much closer to the billboard
        backDir.normalize().multiplyScalar(0.4);
        const newPos = new THREE.Vector3().addVectors(enemyMesh.position, backDir);
        // raise camera relative to the enemy's billboard, but not too high
        controls.getObject().position.set(newPos.x, enemyMesh.position.y + ENEMY_HEIGHT * 0.5, newPos.z);
        camera.lookAt(faceTarget);

        // start ramped shake timing
        jumpShakeStartTime = clock.getElapsedTime();

        // play jumpscare scream
        try {
          if (isLoudnessEnabled) {
            catchBuzzerSound.currentTime = 0;
            catchBuzzerSound.play();
          } else {
            // Replaces loud scream with bbbbb.wav
            postJumpscareSound.currentTime = 0;
            postJumpscareSound.play();
          }
        } catch (e) {
          // ignore playback errors
        }

        // after the visible jumpscare, start blackout + post-jumpscare sound
        setTimeout(() => {
          startPostJumpscareSequence();
        }, 2000);
      }
    }
  } else {
    // if no enemy, ensure chase music is stopped
    updateChaseMusic(controls.getObject().position, controls.getObject().position);
  }

  // SWEEP AI LOGIC
  if (sweepMesh && sweepAI.active) {
    // Billboard logic: explicitly look at camera (rotation Y)
    sweepMesh.lookAt(new THREE.Vector3(camera.position.x, sweepMesh.position.y, camera.position.z));

    // Manage Audio
    if (sweepAI.state !== 'IDLE') {
      if (sweepSound.paused) { try { sweepSound.play(); } catch (e) { } }
      const d = sweepMesh.position.distanceTo(controls.getObject().position);
      const vol = Math.max(0, 1 - d / 30);
      sweepSound.volume = vol;
    } else {
      sweepSound.volume = 0;
    }

    if (sweepAI.state === 'IDLE') {
      if (now >= sweepAI.nextSweepTime) {
        startSweepRun();
      }
    } else {
      // Logic Update
      if (now - sweepAI.lastPathUpdate > 0.25) {
        sweepAI.lastPathUpdate = now;

        let goalX = sweepAI.targetGridX;
        let goalY = sweepAI.targetGridY;

        // State transitions
        if (sweepAI.state === 'ROAMING') {
          sweepAI.sweepDuration += (now - (sweepAI.lastCheck || now));
          sweepAI.lastCheck = now;

          // Increased roam time to 60s
          if (sweepAI.sweepDuration > 60) {
            sweepAI.state = 'RETURNING';
            sweepAI.targetGridX = sweepAI.baseGridX;
            sweepAI.targetGridY = sweepAI.baseGridY;
          } else {
            // Check if reached current target
            const curGX = Math.floor(sweepMesh.position.x / TILE + GW / 2);
            const curGY = Math.floor(sweepMesh.position.z / TILE + GH / 2);
            if (Math.abs(curGX - goalX) <= 1 && Math.abs(curGY - goalY) <= 1) {
              // Pick a new target reasonably far away to keep him roaming broadly
              const t = pickRoamingTarget(sweepMesh.position, 25);
              if (t) {
                sweepAI.targetGridX = Math.floor(t.x / TILE + GW / 2);
                sweepAI.targetGridY = Math.floor(t.z / TILE + GH / 2);
              }
            }
          }
        } else if (sweepAI.state === 'RETURNING') {
          const curGX = Math.floor(sweepMesh.position.x / TILE + GW / 2);
          const curGY = Math.floor(sweepMesh.position.z / TILE + GH / 2);
          if (curGX === sweepAI.baseGridX && curGY === sweepAI.baseGridY) {
            sweepAI.state = 'IDLE';
            sweepAI.nextSweepTime = now + 120; // Schedule next run in 2 mins
            console.log("Sweep returned. Next sweep at:", sweepAI.nextSweepTime);
          }
        }

        // Pathfinding
        goalX = sweepAI.targetGridX;
        goalY = sweepAI.targetGridY;
        const curGX = Math.floor(sweepMesh.position.x / TILE + GW / 2);
        const curGY = Math.floor(sweepMesh.position.z / TILE + GH / 2);

        const next = findNextStep(curGX, curGY, goalX, goalY, grid, GW, GH, blockedPathSet);
        if (next) {
          sweepMesh.userData.targetPos = new THREE.Vector3((next.x - GW / 2 + 0.5) * TILE, wallHeight / 2, (next.y - GH / 2 + 0.5) * TILE);
        } else {
          // Direct fallback
          sweepMesh.userData.targetPos = new THREE.Vector3((goalX - GW / 2 + 0.5) * TILE, wallHeight / 2, (goalY - GH / 2 + 0.5) * TILE);
        }
      }

      // Movement
      if (sweepMesh.userData.targetPos) {
        const dir = sweepMesh.userData.targetPos.clone().sub(sweepMesh.position);
        dir.y = 0;
        const dist = dir.length();
        if (dist > 0.1) {
          dir.normalize();
          const speed = 11.0;
          const move = dir.multiplyScalar(speed * dt);
          sweepMesh.position.add(move);

          // Push Player
          if (sweepMesh.position.distanceTo(controls.getObject().position) < 1.5) {
            // Check immunity (Old Boots)
            const immune = (now < sweepImmunityUntil);

            if (!immune) {
              const pushVec = move.clone().multiplyScalar(1.2);
              const curPos = controls.getObject().position;
              const nextPos = curPos.clone().add(pushVec);

              // Check collisions to prevent being pushed into walls or out of map
              if (!collides(nextPos)) {
                controls.getObject().position.copy(nextPos);
              } else {
                // Try sliding along X
                const slideX = curPos.clone(); slideX.x += pushVec.x;
                if (!collides(slideX)) {
                  controls.getObject().position.copy(slideX);
                } else {
                  // Try sliding along Z
                  const slideZ = curPos.clone(); slideZ.z += pushVec.z;
                  if (!collides(slideZ)) controls.getObject().position.copy(slideZ);
                }
              }
            }
          }
          // Push Enemy
          if (enemyMesh && sweepMesh.position.distanceTo(enemyMesh.position) < 1.5) {
            const pushVec = move.clone().multiplyScalar(1.2);
            const curPos = enemyMesh.position;
            const nextPos = curPos.clone().add(pushVec);

            if (!enemyCollides(nextPos)) {
              enemyMesh.position.copy(nextPos);
            } else {
              // Try sliding along X
              const slideX = curPos.clone(); slideX.x += pushVec.x;
              if (!enemyCollides(slideX)) {
                enemyMesh.position.copy(slideX);
              } else {
                // Try sliding along Z
                const slideZ = curPos.clone(); slideZ.z += pushVec.z;
                if (!enemyCollides(slideZ)) enemyMesh.position.copy(slideZ);
              }
            }
          }
        }
      }
    }
  }

  // NEW: make NPCs wander using the same roaming/pickRoamingTarget + findNextStep logic as sweep
  if (npcGroup && npcStates.length) {
    for (const st of npcStates) {
      // Ensure npc state defaults
      if (st.touchCooldown === undefined) st.touchCooldown = 0; // prevents immediate re-trigger
      if (st.specialState === undefined) st.specialState = {}; // store per-type flags

      // TYPE: 'test' and 'cloud' are intended to stand still unless specific behavior triggers
      const isWanderer = !(st.type === 'test' || st.type === 'cloud' || st.type === 'pomp');

      // Setup roaming target for wanderers and gum kid/pomp that should move
      if (isWanderer && !st.roamingTarget) {
        st.roamingTarget = pickRoamingTarget(st.mesh.position, 8);
        if (st.roamingTarget) {
          st.targetGridX = Math.floor(st.roamingTarget.x / TILE + GW / 2);
          st.targetGridY = Math.floor(st.roamingTarget.z / TILE + GH / 2);
          st.lastPathUpdate = 0;
        }
      }

      // Path update at low frequency for wanderers and gum kid/pomp (when not in special locked states)
      if ((isWanderer || st.type === 'gum_kid' || st.type === 'pomp') && now - st.lastPathUpdate > 0.5) {
        st.lastPathUpdate = now;
        const curGX = Math.floor(st.mesh.position.x / TILE + GW / 2);
        const curGY = Math.floor(st.mesh.position.z / TILE + GH / 2);

        // if reached or no target, pick a new roaming target (unless pomp is "locked in classroom" special state)
        if ((!st.targetGridX || (Math.abs(curGX - st.targetGridX) <= 1 && Math.abs(curGY - st.targetGridY) <= 1))
          && !(st.type === 'pomp' && st.specialState.pompLocked)) {
          const t = pickRoamingTarget(st.mesh.position, 6);
          if (t) {
            st.roamingTarget = t;
            st.targetGridX = Math.floor(t.x / TILE + GW / 2);
            st.targetGridY = Math.floor(t.z / TILE + GH / 2);
          } else {
            st.targetGridX = curGX;
            st.targetGridY = curGY;
          }
        }

        // compute next step toward target
        if (st.targetGridX !== undefined) {
          const next = findNextStep(curGX, curGY, st.targetGridX, st.targetGridY, grid, GW, GH, blockedPathSet);
          if (next) {
            st.mesh.userData.targetPos = new THREE.Vector3((next.x - GW / 2 + 0.5) * TILE, st.mesh.position.y, (next.y - GH / 2 + 0.5) * TILE);
          } else {
            // direct point target fallback
            st.mesh.userData.targetPos = new THREE.Vector3((st.targetGridX - GW / 2 + 0.5) * TILE, st.mesh.position.y, (st.targetGridY - GH / 2 + 0.5) * TILE);
          }
        }
      }

      // movement toward computed target (only if not a stationary 'test' or stationary cloud or pompLocked)
      const canMove = !(st.type === 'test') && !(st.type === 'cloud') && !(st.type === 'pomp' && st.specialState.pompLocked);
      if (canMove && st.mesh.userData.targetPos) {
        const dir = st.mesh.userData.targetPos.clone().sub(st.mesh.position);
        dir.y = 0;
        const dist = dir.length();
        if (dist > 0.05) {
          dir.normalize();
          // NPC speeds: gum kid and pomp wander slightly faster; test/cloud stationary
          const npcSpeed = st.type === 'gum_kid' ? 2.6 : (st.type === 'pomp' ? 2.4 : 2.0);
          const move = dir.multiplyScalar(npcSpeed * dt);

          // avoid pushing through walls; collision check similar to NPC earlier
          const proposed = st.mesh.position.clone().add(move);
          const box = new THREE.Box3().setFromCenterAndSize(proposed.clone(), new THREE.Vector3(0.4, wallHeight, 0.4));
          let hit = false;
          for (const cb of colliderBoxes) {
            if (cb.intersectsBox(box)) { hit = true; break; }
          }
          if (!hit) {
            st.mesh.position.copy(proposed);
          } else {
            // axis sliding attempts
            const posX = st.mesh.position.clone().add(new THREE.Vector3(move.x, 0, 0));
            const boxX = new THREE.Box3().setFromCenterAndSize(posX.clone(), new THREE.Vector3(0.4, wallHeight, 0.4));
            if (!colliderBoxes.some(cb => cb.intersectsBox(boxX))) st.mesh.position.copy(posX);
            else {
              const posZ = st.mesh.position.clone().add(new THREE.Vector3(0, 0, move.z));
              const boxZ = new THREE.Box3().setFromCenterAndSize(posZ.clone(), new THREE.Vector3(0.4, wallHeight, 0.4));
              if (!colliderBoxes.some(cb => cb.intersectsBox(boxZ))) st.mesh.position.copy(posZ);
            }
          }

          // slowly face movement direction
          const angle = Math.atan2(st.mesh.position.x - st.mesh.userData.targetPos.x, st.mesh.position.z - st.mesh.userData.targetPos.z);
          st.mesh.rotation.y = angle + Math.PI;
        }
      }

      // PER-TYPE: interactions when the player 'touches' (close proximity)
      const playerPos = controls.getObject().position;
      const dToPlayer = st.mesh.position.distanceTo(playerPos);

      // small cooldown per-NPC to avoid repeated triggers
      if (dToPlayer < 1.2 && now > st.touchCooldown) {
        st.touchCooldown = now + 1.0; // 1s debounce for repeated contact

        if (st.type === 'test') {
          // Test: disappears, create black fog (blindness) for player for 10s, respawn after 10s at random hallway
          // vanish visually
          st.mesh.visible = false;
          st.specialState.testBlindUntil = now + 10.0;

          // apply blindness: quickly set a dense fog + black background for player
          scene.background = new THREE.Color(0x000000);
          if (scene.fog) {
            scene.fog.color.setHex(0x000000);
            scene.fog.near = 0.1;
            scene.fog.far = 0.6;
          }

          // schedule respawn after 10s: pick random hallway tile and place test there, visible again
          (function (state) {
            setTimeout(() => {
              const pos = getRandomHallwayPosition(grid, rooms, GW, GH, TILE, rng);
              if (pos) {
                state.mesh.position.set(pos.x, state.mesh.position.y, pos.z);
              }
              state.mesh.visible = true;
              // remove blindness only if no other black-mode is active (simple approach)
              if (!darkModeApplied && (!allNotebooksCollectedAt || clock.getElapsedTime() > state.specialState.testBlindUntil)) {
                scene.background = new THREE.Color(0xffffff);
                if (scene.fog) {
                  scene.fog.color.setHex(diffSettings[currentDifficulty].fog || 0xffffff);
                  scene.fog.near = 2;
                  scene.fog.far = 35;
                }
              }
              state.specialState.testBlindUntil = 0;
            }, 10000);
          })(st);
        } else if (st.type === 'cloud') {
          // Cloud: when touched, start an ongoing gentle wind in the cloud's facing direction that pushes players/enemies slowly for 8 seconds
          // We'll store an active wind area originating from the cloud position with a direction equal to the cloud's forward (-Z)
          const windDuration = 8.0;
          const dir = new THREE.Vector3(0, 0, -1).applyEuler(st.mesh.rotation).setY(0).normalize();
          const wind = {
            x: st.mesh.position.x,
            z: st.mesh.position.z,
            dir,
            expiresAt: now + windDuration,
            strength: 1.6 // world units/sec applied as gentle push
          };
          st.specialState.activeWind = wind;
        } else if (st.type === 'gum_kid') {
          // Gum kid: when touched, shoot a gum projectile forward toward player's current position that doesn't home,
          // if it hits the player it applies a slow effect for 10s.
          const projDir = new THREE.Vector3().subVectors(playerPos, st.mesh.position);
          projDir.y = 0;
          if (projDir.lengthSq() === 0) projDir.set(0, 0, -1);
          projDir.normalize();

          // create a simple projectile mesh (blue quad)
          const geom = new THREE.PlaneGeometry(0.4, 0.4);
          const mat = new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
          const proj = new THREE.Mesh(geom, mat);
          proj.position.set(st.mesh.position.x + projDir.x * 0.6, wallHeight / 2, st.mesh.position.z + projDir.z * 0.6);
          proj.rotation.y = Math.atan2(projDir.x, projDir.z);
          scene.add(proj);

          const projState = {
            mesh: proj,
            dir: projDir.clone(),
            speed: 8.0,
            life: 5.0
          };
          activeSplashes.push(projState); // reuse activeSplashes list for simple projectile management

          // Mark it specially so existing splash logic treats it as projectile (we'll check 'isGum' flag)
          projState.isGum = true;
          projState.gumOwner = st;
        } else if (st.type === 'pomp') {
          // Pomp: when touched, teleport to a random classroom and become stationary there, start a 2-minute countdown for player to reach her
          // If already in a 'task' state, touching does nothing
          if (st.specialState.pompTaskActive) {
            // already active: touching toggles nothing
          } else {
            // find a random room (classroom)
            if (rooms.length) {
              const chosen = rooms[Math.floor(rng() * rooms.length)];
              const tx = (chosen.x + chosen.w / 2 - GW / 2) * TILE;
              const tz = (chosen.y + chosen.h / 2 - GH / 2) * TILE;
              st.mesh.position.set(tx, st.mesh.position.y, tz);
              // lock pomp in place
              st.specialState.pompLocked = true;
              st.specialState.pompTaskActive = true;
              st.specialState.pompTaskExpires = now + 120.0; // 2 minutes
              // visually ensure she stands still by clearing target
              st.mesh.userData.targetPos = null;

              // create a marker by setting a timeout that triggers task failure if not completed
              st.specialState.pompTaskTimer = setTimeout(() => {
                // if task still active and not won, mark as failed: pomp becomes fast chaser
                if (st.specialState.pompTaskActive && !st.specialState.pompTaskWon) {
                  st.specialState.pompLocked = false;
                  st.specialState.pompAggro = true; // now chases player with pathfinding and high speed
                  st.specialState.pompTaskActive = false;
                  st.specialState.pompTaskExpires = 0;
                  // increase speed by setting a flag; actual chase behavior applied below
                }
              }, 120000);
            }
          }
        }
      }

      // POMP: if pompTaskWon earlier set, she will walk out of the classroom once player 'won' (handled below in win check)
      // POMP: aggressive chase mode when pompAggro flag set
      if (st.type === 'pomp' && st.specialState.pompAggro) {
        // use chaser-like pathfinding to pursue player (reuse findNextStep)
        const curGX = Math.floor(st.mesh.position.x / TILE + GW / 2);
        const curGY = Math.floor(st.mesh.position.z / TILE + GH / 2);
        const playerGX = Math.floor(playerPos.x / TILE + GW / 2);
        const playerGY = Math.floor(playerPos.z / TILE + GH / 2);

        if (now - (st.lastPathUpdate || 0) > 0.2) {
          st.lastPathUpdate = now;
          const next = findNextStep(curGX, curGY, playerGX, playerGY, grid, GW, GH, blockedPathSet);
          if (next) {
            st.mesh.userData.targetPos = new THREE.Vector3((next.x - GW / 2 + 0.5) * TILE, st.mesh.position.y, (next.y - GH / 2 + 0.5) * TILE);
          } else {
            st.mesh.userData.targetPos = playerPos.clone();
            st.mesh.userData.targetPos.y = st.mesh.position.y;
          }
        }

        // move toward target faster (pomp chaser)
        if (st.mesh.userData.targetPos) {
          const dir = st.mesh.userData.targetPos.clone().sub(st.mesh.position);
          dir.y = 0;
          const dist = dir.length();
          if (dist > 0.05) {
            dir.normalize();
            const pompSpeed = 4.6; // faster than normal NPCs
            const move = dir.multiplyScalar(pompSpeed * dt);
            const proposed = st.mesh.position.clone().add(move);
            const box = new THREE.Box3().setFromCenterAndSize(proposed.clone(), new THREE.Vector3(0.4, wallHeight, 0.4));
            let hit = false;
            for (const cb of colliderBoxes) {
              if (cb.intersectsBox(box)) { hit = true; break; }
            }
            if (!hit) st.mesh.position.copy(proposed);
            // rotate to face movement
            const angle = Math.atan2(st.mesh.position.x - st.mesh.userData.targetPos.x, st.mesh.position.z - st.mesh.userData.targetPos.z);
            st.mesh.rotation.y = angle + Math.PI;
          }
        }

        // if pomp catches player, begin dragging similar to broom/sweep: teleport player gradually toward pomp's classroom center
        const catchDist = 0.9;
        if (st.mesh.position.distanceTo(playerPos) < catchDist) {
          // find the classroom center she teleported to (if stored)
          let classPos = null;
          if (st.specialState.pompTaskRoom) {
            classPos = st.specialState.pompTaskRoom;
          } else {
            // fallback: current pos is used as classroom
            classPos = st.mesh.position.clone();
          }
          // start dragging: move player slowly toward classPos and lock controls
          if (!st.specialState.dragging) {
            st.specialState.dragging = true;
            // lock controls & disable input
            controls.unlock();
            controls.enabled = false;
            isGameOver = false; // keep game running visually
            // drag duration approximation based on distance
            const from = controls.getObject().position.clone();
            const to = new THREE.Vector3(classPos.x, from.y, classPos.z);
            const dragTime = Math.max(1.2, from.distanceTo(to) / 1.2);
            const startT = clock.getElapsedTime();
            const interval = setInterval(() => {
              const elapsed = clock.getElapsedTime() - startT;
              const alpha = Math.min(1, elapsed / dragTime);
              const interp = new THREE.Vector3().lerpVectors(from, to, alpha);
              controls.getObject().position.copy(interp);
              if (alpha >= 1) {
                clearInterval(interval);
                // lock classroom for 10s and set pomp into chaotic roaming inside classrooms
                st.specialState.pompLocked = false;
                st.specialState.pompAggro = false;
                st.specialState.dragging = false;
                controls.enabled = true;
                // Lock classroom by blocking exits nearby: simplest approach, we'll set a local flag and schedule unlock
                st.specialState.classroomLockedUntil = clock.getElapsedTime() + 10.0;
                // Make pomp go chaotic: random teleports between classroom centers for 20s
                st.specialState.chaoticUntil = clock.getElapsedTime() + 20.0;
              }
            }, 50);
          }
        }
      }

      // POMP: if a task is active and player reaches the classroom where pomp sits, they 'win' the task
      if (st.type === 'pomp' && st.specialState.pompTaskActive) {
        // store the classroom center when she teleported earlier for reference (if not already stored)
        if (!st.specialState.pompTaskRoom) {
          // approximate by finding the nearest room center
          let nearestRoom = null;
          let bestDist = Infinity;
          for (const r of rooms) {
            const cx = (r.x + r.w / 2 - GW / 2) * TILE;
            const cz = (r.y + r.h / 2 - GH / 2) * TILE;
            const d = Math.hypot(st.mesh.position.x - cx, st.mesh.position.z - cz);
            if (d < bestDist) { bestDist = d; nearestRoom = { x: cx, z: cz, room: r }; }
          }
          if (nearestRoom) st.specialState.pompTaskRoom = nearestRoom;
        }

        // check if player reached that location
        const roomCenter = st.specialState.pompTaskRoom;
        if (roomCenter) {
          const distToTask = Math.hypot(playerPos.x - roomCenter.x, playerPos.z - roomCenter.z);
          if (distToTask < 1.4) {
            // player wins task
            st.specialState.pompTaskWon = true;
            st.specialState.pompTaskActive = false;
            st.specialState.pompLocked = false;
            if (st.specialState.pompTaskTimer) {
              clearTimeout(st.specialState.pompTaskTimer);
              st.specialState.pompTaskTimer = null;
            }
            // pomp will now walk out of classroom once: set a short roaming target and then resume normal wander
            st.specialState.pompWalkOut = true;
            // brief behavior: pick a roaming target and mark to move
            const t = pickRoamingTarget(st.mesh.position, 6);
            if (t) {
              st.roamingTarget = t;
              st.targetGridX = Math.floor(t.x / TILE + GW / 2);
              st.targetGridY = Math.floor(t.z / TILE + GH / 2);
              st.specialState.pompLocked = false;
            }
          } else if (now > st.specialState.pompTaskExpires) {
            // if time expired, handled by timer earlier - ensure state cleared
            st.specialState.pompTaskActive = false;
          }
        }
      }

      // per-type periodic reactions handled earlier e.g., principalReact etc
      if (st.type === 'principal') principalReact(st);
      if (st.type === 'bob') bobAttemptSteal(st);
      if (st.type === 'playgirl') playgirlForcePlay(st);
      if (st.type === 'second_prize') secondPrizeNudge(st);

      // CLOUD: apply wind to players/enemies if active
      if (st.type === 'cloud' && st.specialState.activeWind) {
        const wind = st.specialState.activeWind;
        if (now > wind.expiresAt) {
          st.specialState.activeWind = null;
        } else {
          // apply gentle push to player if within a long narrow cone along the wind dir
          const playerVec = controls.getObject().position.clone();
          const dx = playerVec.x - wind.x;
          const dz = playerVec.z - wind.z;
          const forwardDist = dx * wind.dir.x + dz * wind.dir.z;
          const lateral = Math.abs(-dx * wind.dir.z + dz * wind.dir.x); // perpendicular distance
          if (forwardDist > 0.5 && forwardDist < 12 && lateral < 3.0) {
            // push player slowly backwards along -wind.dir
            const push = wind.dir.clone().multiplyScalar(-wind.strength * dt * 0.45);
            const nextPos = controls.getObject().position.clone().add(push);
            if (!collides(nextPos)) controls.getObject().position.copy(nextPos);
          }

          // push enemy if present
          if (enemyMesh) {
            const ex = enemyMesh.position;
            const edx = ex.x - wind.x;
            const edz = ex.z - wind.z;
            const eForward = edx * wind.dir.x + edz * wind.dir.z;
            const eLateral = Math.abs(-edx * wind.dir.z + edz * wind.dir.x);
            if (eForward > 0.5 && eForward < 12 && eLateral < 3.0) {
              const push = wind.dir.clone().multiplyScalar(-wind.strength * dt * 0.35);
              const proposed = enemyMesh.position.clone().add(push);
              if (!enemyCollides(proposed)) enemyMesh.position.copy(proposed);
            }
          }
        }
      }
    }
  }

  // NEW: update active splash projectiles
  if (activeSplashes.length) {
    const enemyPos = enemyMesh ? enemyMesh.position : null;
    for (let i = activeSplashes.length - 1; i >= 0; i--) {
      const s = activeSplashes[i];

      // decrement lifetime first
      s.life -= dt;
      if (s.life <= 0) {
        splashGroup.remove(s.mesh);
        activeSplashes.splice(i, 1);
        // if this splash is currently pushing the enemy, stop the push
        if (enemyState.pushAttachedSplash === s) {
          enemyState.pushTime = 0;
          enemyState.pushDir = null;
          enemyState.pushAttachedSplash = null;
        }
        continue;
      }

      // if splash is attached to the enemy, keep it visually pushing in front of him
      if (s.attachedToEnemy && enemyPos && enemyState.pushDir) {
        const attachOffset = 0.7;
        const dir = enemyState.pushDir.clone();
        dir.y = 0;
        if (dir.lengthSq() === 0) dir.set(0, 0, 1);
        dir.normalize();
        const pos = enemyPos.clone().addScaledVector(dir, attachOffset);
        s.mesh.position.set(pos.x, wallHeight / 2, pos.z);

        // do not move or kill attached splashes here
        continue;
      }

      // compute proposed next position
      const moveVec = s.dir.clone().multiplyScalar(s.speed * dt);
      const nextPos = s.mesh.position.clone().add(moveVec);

      // check if out of bounds first (outside the map grid)
      const nextGridX = Math.floor(nextPos.x / TILE + GW / 2);
      const nextGridY = Math.floor(nextPos.z / TILE + GH / 2);
      const outOfBounds = nextGridX < 0 || nextGridX >= GW || nextGridY < 0 || nextGridY >= GH;

      // build a small collision box for the splash at its next position
      const splashRadius = 0.35;
      const splashBox = new THREE.Box3(
        new THREE.Vector3(nextPos.x - splashRadius, 0.0, nextPos.z - splashRadius),
        new THREE.Vector3(nextPos.x + splashRadius, wallHeight, nextPos.z + splashRadius)
      );

      let hitWall = outOfBounds;

      // collide with static wall colliders
      if (!hitWall) {
        for (const cb of colliderBoxes) {
          if (cb.intersectsBox(splashBox)) {
            hitWall = true;
            break;
          }
        }
      }

      // also collide with any closed doors (those with an active bounding box)
      if (!hitWall) {
        for (const d of doorStates) {
          if (!d.box) continue;
          if (d.box.intersectsBox(splashBox)) {
            hitWall = true;
            break;
          }
        }
      }

      // if splash would hit a wall/door or go out of bounds, remove it immediately
      if (hitWall) {
        splashGroup.remove(s.mesh);
        activeSplashes.splice(i, 1);
        // if this splash is currently pushing the enemy, stop the push
        if (enemyState.pushAttachedSplash === s) {
          enemyState.pushTime = 0;
          enemyState.pushDir = null;
          enemyState.pushAttachedSplash = null;
        }
        continue;
      }

      // otherwise move forward
      s.mesh.position.copy(nextPos);

      // push enemy smoothly if it intersects splash
      if (enemyPos) {
        const dx = enemyPos.x - s.mesh.position.x;
        const dz = enemyPos.z - s.mesh.position.z;
        const distSq = dx * dx + dz * dz;
        const pushRadius = 1.2;
        if (distSq < pushRadius * pushRadius) {
          // start a push in the splash direction and pause pathfinding
          enemyState.pushDir = s.dir.clone();
          enemyState.pushTime = 0.5; // initial non-zero to mark active
          enemyState.pushSpeed = TILE * 2.5; // push speed in world units/sec (reduced from 5.0)

          // attach this splash visually to the enemy so it looks like it's pushing
          s.attachedToEnemy = true;
          enemyState.pushAttachedSplash = s;

          // don't remove the splash here; it will persist until the enemy hits a wall
          continue;
        }
      }
    }
  }

  // movement
  const baseSpeed = 3.9;

  // Autoplay: simple AI that directs player toward nearest notebook, then exits.
  // If Balder is close, try to use any blue soda in inventory to avoid him.
  if (modAutoplay && !isGameOver && !isMainMenu) {
    // find nearest uncollected notebook
    let targetPos = null;
    let bestDist = Infinity;
    for (let i = 0; i < notebookStates.length; i++) {
      const nb = notebookStates[i];
      if (!nb || nb.collected) continue;
      const d = controls.getObject().position.distanceTo(nb.mesh.position);
      if (d < bestDist) {
        bestDist = d;
        targetPos = nb.mesh.position.clone();
      }
    }
    // if no notebooks left, target an uncollected exit
    if (!targetPos) {
      for (const es of exitStates) {
        if (!es || es.collected) continue;
        const d = controls.getObject().position.distanceTo(es.mesh.position);
        if (d < bestDist) {
          bestDist = d;
          targetPos = es.mesh.position.clone();
        }
      }
    }

    // If Balder is near (within 6 tiles), attempt to use blue soda if available
    if (enemyMesh) {
      const dBalder = controls.getObject().position.distanceTo(enemyMesh.position);
      if (dBalder < TILE * 6) {
        // find blue_soda index in inventory
        const sodaIdx = inventory.findIndex(it => it && it.type === 'blue_soda');
        if (sodaIdx !== -1) {
          selectedInvIndex = sodaIdx;
          try { useHeldItem(); } catch (e) { }
        }
      }
    }

    // If we have a target, compute a simple movement vector toward it and move the player a bit this frame
    if (targetPos) {
      // disable manual move flags while autoplay is active
      move.fwd = move.back = move.left = move.right = move.sprint = false;

      const playerPos = controls.getObject().position;
      const dirTo = new THREE.Vector3().subVectors(targetPos, playerPos);
      dirTo.y = 0;
      if (dirTo.lengthSq() > 0.0001) {
        dirTo.normalize();
        // use a conservative autoplay speed (walk)
        const autoSpeed = baseSpeed * 0.9 * (modSuperSpeed ? 2.25 : 1.0);
        const step = dirTo.multiplyScalar(autoSpeed * dt);
        const next = playerPos.clone().add(step);
        if (!collides(next)) {
          controls.getObject().position.copy(next);
        } else {
          // attempt axis sliding
          const nextX = playerPos.clone().add(new THREE.Vector3(step.x, 0, 0));
          if (!collides(nextX)) controls.getObject().position.copy(nextX);
          const nextZ = playerPos.clone().add(new THREE.Vector3(0, 0, step.z));
          if (!collides(nextZ)) controls.getObject().position.copy(nextZ);
        }
      }

      // NEW: If the autoplay target is within interaction reach, perform interactions automatically
      try {
        const distToTarget = controls.getObject().position.distanceTo(targetPos);
        if (distToTarget <= INTERACT_REACH) {
          // Attempt pickups/interactions in the same priority order as player clicks
          tryPickupItem();
          tryCollectNotebook();
          tryInteractExit();
          // Also try opening door if applicable
          tryOpenDoor();
        }
      } catch (e) {
        // ignore any errors during automated interaction attempts
      }
    }
  }

  // NEW: Stamina Logic
  // Reduce stamina drain based on notebooks collected (approx 6% less drain per notebook)
  const settings = diffSettings[currentDifficulty];
  const drainReduction = Math.min(0.75, notebooksCollected * settings.staminaNotebookFactor);
  const staminaDrainRate = 12.5 * (1.0 - drainReduction);
  const staminaRegenRate = 18.0; // slightly faster regen when standing still
  const isMoving = move.fwd || move.back || move.left || move.right;
  const isSpeedBoostActive = now < speedBoostUntil;

  // Infinite stamina during purple chocolate boost or modInfStamina
  if (isSpeedBoostActive || modInfStamina) {
    currentStamina = maxStamina;
  } else {
    // Drain if sprinting and moving
    if (move.sprint && isMoving && currentStamina > 0) {
      currentStamina -= staminaDrainRate * dt;
      if (currentStamina < 0) currentStamina = 0;
    }
    // Regen while walking (moving without sprint) at 50% of standing-still rate
    else if (isMoving && !move.sprint && currentStamina < maxStamina) {
      currentStamina += (staminaRegenRate * 0.5) * dt;
      if (currentStamina > maxStamina) currentStamina = maxStamina;
    }
    // Regen fastest when standing still
    else if (!isMoving && currentStamina < maxStamina) {
      currentStamina += staminaRegenRate * dt;
      if (currentStamina > maxStamina) currentStamina = maxStamina;
    }
  }

  // Update stamina bar width
  if (staminaBarEl) {
    staminaBarEl.style.width = `${(currentStamina / maxStamina) * 100}%`;
  }

  // Disable sprint if no stamina (and not boosted)
  const canSprint = isSpeedBoostActive || currentStamina > 0;
  const effectiveSprint = move.sprint && canSprint;

  // apply modSuperSpeed multiplier if enabled
  const modSpeedMult = modSuperSpeed ? 2.25 : 1.0;
  const speed = baseSpeed * (effectiveSprint ? 2.2 : 1.0) * (isSpeedBoostActive ? 1.5 : 1.0) * modSpeedMult;
  // Adjusted boost multiplier slightly to not be uncontrollable if sprinting + boosted

  const dirVec = new THREE.Vector3();
  if (move.fwd) dirVec.z -= 1;
  if (move.back) dirVec.z += 1;
  if (move.left) dirVec.x -= 1;
  if (move.right) dirVec.x += 1;
  if (dirVec.lengthSq() > 0) {
    dirVec.normalize().applyQuaternion(camera.quaternion);
    dirVec.y = 0;
    const next = controls.getObject().position.clone().addScaledVector(dirVec, speed * dt);
    if (!collides(next)) {
      controls.getObject().position.copy(next);
    } else {
      // try axis-separated sliding
      const nextX = controls.getObject().position.clone().addScaledVector(new THREE.Vector3(dirVec.x, 0, 0), speed * dt);
      if (!collides(nextX)) controls.getObject().position.copy(nextX);
      const nextZ = controls.getObject().position.clone().addScaledVector(new THREE.Vector3(0, 0, dirVec.z), speed * dt);
      if (!collides(nextZ)) controls.getObject().position.copy(nextZ);
    }
  }

  // NEW: Touch-based exit collection — if player is close enough to any active exit, collect it automatically.
  if (darkModeApplied && Array.isArray(exitStates) && exitStates.length) {
    const playerPos = controls.getObject().position;
    for (const es of exitStates) {
      if (es.collected) continue;
      // distance check in world units; use INTERACT_REACH as defined for ray interactions
      const d = es.mesh.position.distanceTo(playerPos);
      if (d <= INTERACT_REACH) {
        es.collected = true;
        es.mesh.material = exitUsedMat;
        exitsCollected++;
        updateNotebookCounter();
        // check win
        if (exitsCollected >= exitsNeeded) {
          triggerWin();
          break;
        }
      }
    }
  }

  drawMinimap();

  // NEW: Apply look behind rotation temporarily for rendering
  let originalRotation = null;
  if (isLookingBehind) {
    // Save current rotation so movement/input still use the real view
    originalRotation = camera.rotation.clone();
    // Zero out pitch (x) and roll (z), and flip yaw (y) by π from the stored base yaw
    camera.rotation.set(0, lookBehindBaseRotation.y + Math.PI, 0);
  }

  renderer.render(scene, camera);

  // Restore camera rotation immediately after render so movement directions remain correct
  if (isLookingBehind && originalRotation) {
    camera.rotation.copy(originalRotation);
  }

  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// FPS display: update every 1 second (delayed 1s) to reduce jitter
(function setupFpsDisplay() {
  const fpsEl = document.getElementById('fpsDisplay');
  if (!fpsEl) return;
  let frames = 0;
  let lastReport = performance.now();

  // count frames continuously
  (function countFrame() {
    frames++;
    requestAnimationFrame(countFrame);
  })();

  // report every 1000ms
  setInterval(() => {
    const now = performance.now();
    const dt = (now - lastReport) / 1000;
    lastReport = now;
    const fps = Math.round(frames / Math.max(0.0001, dt));
    frames = 0;
    fpsEl.textContent = `fps: ${fps}`;
    fpsEl.style.display = 'block';
  }, 1000);
})();

// helper to modulate chase music volume by distance (in world units)
function updateChaseMusic(playerPos, enemyPos) {
  if (!enemyMesh) {
    if (!chaseMusic.paused) {
      chaseMusic.pause();
      chaseMusic.currentTime = 0;
    }
    return;
  }

  const dx = enemyPos.x - playerPos.x;
  const dz = enemyPos.z - playerPos.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // 8-9 cells in world units
  const maxCells = 9;
  const maxDist = TILE * maxCells;

  if (dist > maxDist) {
    if (!chaseMusic.paused) {
      chaseMusic.pause();
      chaseMusic.currentTime = 0;
    }
    return;
  }

  // nearer -> louder, fade from 0 at maxDist to 1 at distance 0
  const t = 1 - Math.min(1, dist / maxDist);
  const volume = 0.2 + 0.8 * t; // keep a floor so it's audible when close
  chaseMusic.volume = volume;

  if (chaseMusic.paused) {
    try {
      chaseMusic.play();
    } catch { }
  }
}

function startPostJumpscareSequence() {
  // show blackout overlay and play the post-jumpscare sound,
  // then reload after the sound duration (3 seconds)
  blackoutOverlay.style.display = 'block';

  if (isLoudnessEnabled) {
    try {
      postJumpscareSound.currentTime = 0;
      postJumpscareSound.play();
    } catch (e) {
      // ignore playback errors
    }
  }

  setTimeout(() => {
    window.location.reload();
  }, 3000);
}

function applyEnvironmentShake() {
  // ramp intensity: every 250ms ms jumpscare, increase shake a bit
  const now = clock.getElapsedTime();
  const elapsed = Math.max(0, now - jumpShakeStartTime);
  const steps = Math.floor(elapsed / 0.25); // 0.25s per step
  const base = 0.15;
  const stepAmount = 0.05;
  const maxIntensity = 0.8;
  const intensity = Math.min(maxIntensity, base + steps * stepAmount);

  // keep jumpscare sound at normal pitch (no playback rate modulation)
  catchBuzzerSound.playbackRate = 1.0;

  [floorGroup, roofGroup, wallGroup, doorGroup].forEach(group => {
    for (const mesh of group.children) {
      if (mesh.userData.baseRotation) {
        mesh.rotation.x = mesh.userData.baseRotation.x + (Math.random() - 0.5) * intensity;
        mesh.rotation.y = mesh.userData.baseRotation.y + (Math.random() - 0.5) * intensity;
        mesh.rotation.z = mesh.userData.baseRotation.z + (Math.random() - 0.5) * intensity;
      }
    }
  });
}

// NEW: stop all game sounds (called on win)
function stopAllSounds() {
  const sounds = [
    humSound,
    schoolhouseSound, // ensure this is stopped on win/menu
    catchBuzzerSound,
    chaseMusic,
    windHowlSound,
    notebookPickupSound,
    walkieTalkieBeepSound,
    purpleChocolateSound,
    postJumpscareSound,
    doorOpenSound,
    doorCloseSound,
    sodaOpenSound,
    spraySound,
    sweepSound // added
  ];
  for (const s of sounds) {
    if (!s) continue;
    try {
      s.pause();
      s.currentTime = 0;
    } catch (e) {
      // ignore audio errors
    }
  }

  // also stop RUN.. specifically if present (defensive)
  try {
    if (typeof runSound !== 'undefined') {
      runSound.pause();
      runSound.currentTime = 0;
    }
  } catch (e) { }
}

// --- NEW: Save / Load level generation settings (JSON) ---
function collectLevelSettings() {
  try {
    const aEl = document.getElementById('levelAttemptsInput');
    const rEl = document.getElementById('levelRoomsInput');
    const sxEl = document.getElementById('roomSizeXInput');
    const szEl = document.getElementById('roomSizeZInput');
    const maxExEl = document.getElementById('levelMaxExitsInput');
    const maxFloorsEl = document.getElementById('levelMaxFloorsInput');
    const corruptEl = document.getElementById('levelCorruptMazeChk');
    const startFloorEl = document.getElementById('levelStartFloorSelect');

    return {
      attempts: aEl ? parseInt(aEl.value, 10) : 600,
      targetRooms: rEl ? parseInt(rEl.value, 10) : 12,
      roomSizeX: sxEl ? parseInt(sxEl.value, 10) : null,
      roomSizeZ: szEl ? parseInt(szEl.value, 10) : null,
      maxExits: maxExEl ? parseInt(maxExEl.value, 10) : 4,
      maxFloors: maxFloorsEl ? parseInt(maxFloorsEl.value, 10) : 5,
      corruptMaze: corruptEl ? !!corruptEl.checked : false,
      startFloor: startFloorEl ? parseInt(startFloorEl.value, 10) : 1
    };
  } catch (e) { return null; }
}

function applyLevelSettings(settings) {
  if (!settings) return;
  try {
    const aEl = document.getElementById('levelAttemptsInput');
    const rEl = document.getElementById('levelRoomsInput');
    const sxEl = document.getElementById('roomSizeXInput');
    const szEl = document.getElementById('roomSizeZInput');
    const maxExEl = document.getElementById('levelMaxExitsInput');
    const maxFloorsEl = document.getElementById('levelMaxFloorsInput');
    const corruptEl = document.getElementById('levelCorruptMazeChk');
    const startFloorEl = document.getElementById('levelStartFloorSelect');

    if (aEl && Number.isFinite(settings.attempts)) aEl.value = settings.attempts;
    if (rEl && Number.isFinite(settings.targetRooms)) rEl.value = settings.targetRooms;
    if (sxEl && Number.isFinite(settings.roomSizeX)) sxEl.value = settings.roomSizeX;
    if (szEl && Number.isFinite(settings.roomSizeZ)) szEl.value = settings.roomSizeZ;
    if (maxExEl && Number.isFinite(settings.maxExits)) maxExEl.value = settings.maxExits;
    if (maxFloorsEl && Number.isFinite(settings.maxFloors)) maxFloorsEl.value = settings.maxFloors;
    if (corruptEl) corruptEl.checked = !!settings.corruptMaze;
    if (startFloorEl && Number.isFinite(settings.startFloor)) startFloorEl.value = settings.startFloor;
  } catch (e) { console.warn('applyLevelSettings failed:', e); }
}

function setupLevelSettingsSaveLoad() {
  const saveBtn = document.getElementById('saveLevelSettingsBtn');
  const loadBtn = document.getElementById('loadLevelSettingsBtn');
  const fileInput = document.getElementById('levelSettingsFileInput');

  if (saveBtn) {
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const settings = collectLevelSettings();
      if (!settings) return;
      const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const fname = `rooms_maze_settings_${Date.now()}.json`;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  }

  if (loadBtn && fileInput) {
    loadBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.value = '';
      fileInput.click();
    });

    fileInput.addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          applyLevelSettings(parsed);
        } catch (err) {
          console.warn('Failed to parse settings JSON:', err);
        }
      };
      reader.readAsText(f);
    });
  }
}

// initialize save/load bindings once DOM is ready
try {
  setupLevelSettingsSaveLoad();
} catch { }