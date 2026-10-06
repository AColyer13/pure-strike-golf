// Gameplay tuning tables shared by the game, caddie and UI.

// meterTime: seconds for a full meter sweep; zone: half-width of the sweet spot (fraction)
// wind/roll: whether the landing preview includes wind / bounce-and-roll
// putt: fraction of the putt line drawn; marker: show the suggested-power marker
export const DIFFICULTY = {
  beginner: { name: 'Beginner', meterTime: 1.35, zone: 0.055, wind: true, roll: true, putt: 1.0, marker: true },
  standard: { name: 'Standard', meterTime: 1.05, zone: 0.036, wind: false, roll: false, putt: 0.35, marker: true },
  pro: { name: 'Pro', meterTime: 0.85, zone: 0.024, wind: false, roll: false, putt: 0, marker: false },
};

// Intended shot shapes: club path and face relative to the target (degrees, + = right)
export const SHAPES = {
  draw: { name: 'Draw', path: 4.5, face: 1.5 },
  straight: { name: 'Straight', path: 0, face: 0 },
  fade: { name: 'Fade', path: -4.5, face: -1.5 },
};

export const TRAJ = { '-1': 'Low', '0': 'Standard', '1': 'High' };

export const MAX_STROKES = 12; // pick up after this many strokes on a hole

// A full swing can't be slower than this fraction of the club's speed: a power
// click far too early is a chunk (heavy strike, ball barely moves), not a
// 4 mph swing. Putts are exempt.
export const MIN_SWING = 0.22;

// Default key bindings (KeyboardEvent.key, single characters lower-cased). The
// player can rebind them in Settings; overrides are stored in settings.keys.
export const DEFAULT_KEYS = {
  swing: [' '],
  clubUp: ['ArrowUp', 'w'],
  clubDown: ['ArrowDown', 's'],
  aimLeft: ['ArrowLeft', 'a'],
  aimRight: ['ArrowRight', 'd'],
  aimFine: ['Shift'],
  shapeLeft: ['q'],
  shapeRight: ['e'],
  trajUp: ['r'],
  trajDown: ['f'],
  targetView: ['v'],
  grid: ['g'],
  caddie: ['c'],
  aimPin: ['p'],
  fastForward: [' ', 'f'],
  skip: ['Enter'],
  replay: ['x'],
  mute: ['m'],
  scorecard: ['Tab'],
  hudDetail: ['h'],
  pause: ['Escape'],
};

export const ACTION_LABELS = {
  swing: 'Swing / continue', clubUp: 'Longer club', clubDown: 'Shorter club', aimLeft: 'Aim left', aimRight: 'Aim right',
  aimFine: 'Fine aim (hold)', shapeLeft: 'Draw', shapeRight: 'Fade', trajUp: 'Higher flight', trajDown: 'Lower flight',
  targetView: 'Target view', grid: 'Green grid', caddie: 'Caddie advice', aimPin: 'Aim at pin', fastForward: 'Fast-forward (hold)',
  skip: 'Skip to result', replay: 'Replay last shot', mute: 'Sound on/off', scorecard: 'Scorecard (hold)', hudDetail: 'Essential / full HUD', pause: 'Pause',
};
