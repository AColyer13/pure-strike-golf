// The caddie's voice: the browser's speech synthesis, spoken at the player's volume.
// Does nothing where speech isn't available (older WebViews, headless test runs).
let pick;

const synth = () => (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined' ? speechSynthesis : null);

// a calm English voice if the device has one (the default voice can be another language)
function voice(s) {
  if (pick === undefined || (pick === null && s.getVoices().length)) {
    const vs = s.getVoices().filter((v) => /^en/i.test(v.lang));
    pick = vs.find((v) => /natural|google uk english male|daniel|aaron|guy/i.test(v.name)) || vs.find((v) => v.default) || vs[0] || null;
  }
  return pick;
}

export function say(text, volume = 1) {
  const s = synth();
  if (!s || !text || volume <= 0) return;
  s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = voice(s);
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = 0.98; u.pitch = 0.9; u.volume = Math.min(1, volume);
  s.speak(u);
}

export function hush() {
  const s = synth();
  if (s && (s.speaking || s.pending)) s.cancel();
}
