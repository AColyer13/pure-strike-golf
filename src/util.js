// Small shared math helpers (no DOM / Three.js, so Node tests can import them).
export const DEG = Math.PI / 180;
export const MPH = 0.44704; // metres per second in one mph
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// Heading angle (radians, 0 = toward -z / the green) <-> horizontal unit vector
export const dirOf = (a) => ({ x: Math.sin(a), z: -Math.cos(a) });
export const angOf = (dx, dz) => Math.atan2(dx, -dz);
