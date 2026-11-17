export const IMG_CACHE = {
  characters: ["2nd_prize", "bob", "broom", "cloud", "gum_kid", "playgirl", "pomp", "principal", "teacher", "test"],
  items: ['boots', 'chocolate', 'soda', 'tracker', 'wd40', 'notebook'],
  points: ['green', 'mega', 'orange', 'pink'],
  posters: {
    prefix: 'poster',
    count: 8
  },
  effects: ['sparkle', 'spray'],
  textures: [
    { tex: 'carpet', wrap: true },
    { tex: 'wall', wrap: true },
    { tex: 'roof', wrap: true },
    'door', 'door_open', 'exit', 'exit2'
  ]
};

export const AUDIO_CACHE = {
  music: [
    { snd: 'chasing.wav', loop: true },
    { snd: 'run.wav', loop: true, vol: 0.9 },
    { snd: 'schoolhouse.wav', loop: true, vol: 0.9 },
  ],
  jumpscares: [
    { snd: 'jumpscare.wav' },
    { snd: 'jumpscare2.wav' },
  ],
  door: [
    { snd: 'door/close.mp3' },
    { snd: 'door/open.mp3' },
  ],
  sfx: [
    { snd: 'beep.mp3', vol: 0.9 },
    { snd: 'eating.mp3', vol: 0.9 },
    { snd: 'humming.mp3', vol: 0.18, loop: true },
    { snd: 'notebookpickup.mp3' },
    { snd: 'soda.mp3', vol: 0.85 },
    { snd: 'spray.mp3' },
    { snd: 'sweep.wav', loop: true },
    { snd: 'wind.mp3', loop: true }
  ]
}