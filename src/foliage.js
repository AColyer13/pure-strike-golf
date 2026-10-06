// Foliage cards: tree crowns, shrubs and palm fronds drawn as alpha-tested
// quads instead of solid blobs. Each leaf kind paints one 256² canvas of
// layered leaf-cluster splats (two tones, lit from the top right, darker toward
// the centre so the crown reads as a volume). A crown is a few crossed cards
// per clump with spherical normals so it shades like a ball of leaves, and
// every card has a back-facing twin so lighting is the same from either side.
// The shared material sways in the wind through a small vertex-shader patch,
// and the matching depth material gives shadows the leaf silhouette.
import * as THREE from 'three';
import { mulberry32 } from './hole.js';

const SIZE = 256;
export const ALPHA_TEST = 0.4;

// leaf kinds: style (broad leaves, needles or a palm frond), two tones and optional flowers
const KINDS = {
  oak: { style: 'broad', dark: '#2c5424', light: '#74a93f', n: 560, r: [7, 13] },
  pine: { style: 'needle', dark: '#24452a', light: '#5e9c45', n: 1500 },
  cypress: { style: 'needle', dark: '#1d3a21', light: '#3e7334', n: 1500 },
  dogwood: { style: 'broad', dark: '#86a356', light: '#c3d690', n: 240, r: [8, 12], flower: ['#ffffff', '#fbf0f3', '#f7dde6'], fn: 300, fr: [6, 10] },
  azalea: { style: 'broad', dark: '#2d5a26', light: '#5e983a', n: 340, r: [6, 10], flower: ['#e0457b', '#c93a8f', '#f2f2f2', '#e86a9a'], fn: 230, fr: [5, 8] },
  gorse: { style: 'needle', dark: '#2a401b', light: '#50702c', n: 1300, flower: ['#e8c62e', '#f4d84e'], fn: 260, fr: [2.5, 4] },
  frond: { style: 'frond', dark: '#2a6327', light: '#63a243' },
};

const textures = {};
export function leafTexture(kind) {
  if (!textures[kind]) textures[kind] = paint(kind);
  return textures[kind];
}

function mixHex(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return ca.lerp(cb, Math.min(1, Math.max(0, t))).getStyle();
}

function paint(kind) {
  const K = KINDS[kind];
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  const rnd = mulberry32(kind.length * 7919 + kind.charCodeAt(0));
  if (K.style === 'frond') paintFrond(g, K, rnd);
  else paintCrown(g, K, rnd);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  return t;
}

// a round, lumpy silhouette of leaf splats
function paintCrown(g, K, rnd) {
  const cx = SIZE / 2, cy = SIZE / 2 + 6, R = SIZE * 0.44;
  // four to six lobes make the outline irregular; every lobe plus its largest
  // splat stays inside the canvas so the silhouette never clips to a square
  const lobes = [];
  const nl = 4 + Math.floor(rnd() * 3);
  const margin = 20;
  for (let i = 0; i < nl; i++) {
    const a = (i / nl) * Math.PI * 2 + rnd() * 0.8;
    const d = R * (0.15 + rnd() * 0.25);
    lobes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d * 0.85, r: Math.min(R * (0.38 + rnd() * 0.16), R - d - margin) });
  }
  lobes.push({ x: cx, y: cy, r: R * 0.5 });
  const pick = () => {
    for (;;) {
      const L = lobes[Math.floor(rnd() * lobes.length)];
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * L.r;
      const x = L.x + Math.cos(a) * d, y = L.y + Math.sin(a) * d;
      if (x > margin && x < SIZE - margin && y > margin && y < SIZE - margin) return [x, y];
    }
  };
  const tone = (x, y) => {
    // lit from the top right, deeper and darker toward the middle of the crown
    const lx = (x - cx) / R, ly = (cy - y) / R;
    let t = 0.5 + 0.3 * lx + 0.45 * ly + (rnd() - 0.5) * 0.35;
    const depth = Math.hypot(lx, ly);
    t *= 0.55 + 0.45 * Math.min(1, depth / 0.9);
    return t;
  };
  if (K.style === 'broad') {
    for (let i = 0; i < K.n; i++) {
      const [x, y] = pick();
      const r = K.r[0] + rnd() * (K.r[1] - K.r[0]);
      g.fillStyle = mixHex(K.dark, K.light, tone(x, y));
      g.beginPath();
      g.ellipse(x, y, r, r * (0.55 + rnd() * 0.3), rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  } else {
    g.lineCap = 'round';
    for (let i = 0; i < K.n; i++) {
      const [x, y] = pick();
      const len = 9 + rnd() * 8, a = rnd() * Math.PI * 2;
      g.strokeStyle = mixHex(K.dark, K.light, tone(x, y));
      g.lineWidth = 1.6 + rnd() * 1.2;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
  }
  if (K.flower) {
    for (let i = 0; i < K.fn; i++) {
      const [x, y] = pick();
      if (y > cy + R * 0.5 && rnd() < 0.7) continue; // flowers sit on top and around the sides
      const r = K.fr[0] + rnd() * (K.fr[1] - K.fr[0]);
      const col = K.flower[Math.floor(rnd() * K.flower.length)];
      g.fillStyle = mixHex('#000000', col, 0.7 + 0.3 * Math.min(1, tone(x, y) + 0.3));
      g.beginPath();
      g.ellipse(x, y, r, r * 0.8, rnd() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// a palm frond lying along +u: central rib with leaflets angled toward the tip
function paintFrond(g, K, rnd) {
  const y0 = SIZE / 2;
  g.lineCap = 'round';
  for (let x = 14; x < SIZE - 8; x += 3.5) {
    const t = x / SIZE;
    const len = 20 + 100 * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.95)) * (1 - t * 0.3);
    const ang = 1.0 - t * 0.4;
    for (const s of [-1, 1]) {
      const shade = 0.35 + 0.5 * t + (rnd() - 0.5) * 0.35 + (s > 0 ? 0.12 : -0.08);
      g.strokeStyle = mixHex(K.dark, K.light, shade);
      g.lineWidth = 4.5 + rnd() * 1.5;
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x + Math.cos(ang) * len, y0 + s * Math.sin(ang) * len);
      g.stroke();
    }
  }
  g.strokeStyle = mixHex(K.dark, '#8a7a4a', 0.5);
  g.lineWidth = 4;
  g.beginPath(); g.moveTo(6, y0); g.lineTo(SIZE - 6, y0 - 4); g.stroke();
}

// ------------------------------------------------------------------ geometry
class CardBuilder {
  constructor(treeH) { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.sway = []; this.treeH = treeH; }

  // one card with a back-facing twin. c: centre, r/u: half extents, nfn(v) → normal
  quad(c, r, u, nfn, color, mirror) {
    const v = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => new THREE.Vector3(c.x + r.x * a + u.x * b, c.y + r.y * a + u.y * b, c.z + r.z * a + u.z * b));
    const uvs = [[mirror ? 1 : 0, 0], [mirror ? 0 : 1, 0], [mirror ? 0 : 1, 1], [mirror ? 1 : 0, 1]];
    const push = (i) => {
      const p = v[i], n = nfn(p);
      this.pos.push(p.x, p.y, p.z);
      this.nor.push(n.x, n.y, n.z);
      this.uv.push(uvs[i][0], uvs[i][1]);
      this.col.push(color.r, color.g, color.b);
      this.sway.push(Math.pow(Math.max(0, p.y) / this.treeH, 1.5));
    };
    for (const i of [0, 1, 2, 0, 2, 3]) push(i);
    for (const i of [0, 2, 1, 0, 3, 2]) push(i);
  }

  // a ball of leaves: three vertical cards crossed at 60° plus a flat cap
  cluster(cx, cy, cz, r, rnd, color) {
    const c = new THREE.Vector3(cx, cy, cz);
    const up = new THREE.Vector3(0, r * 0.6, 0);
    const nfn = (p) => p.clone().sub(c).add(up).normalize();
    const col = new THREE.Color();
    for (let k = 0; k < 3; k++) {
      const a = (k * Math.PI) / 3 + (rnd() - 0.5) * 0.5;
      const right = new THREE.Vector3(Math.cos(a) * r * 1.08, 0, Math.sin(a) * r * 1.08);
      const upv = new THREE.Vector3((rnd() - 0.5) * r * 0.15, r * 0.98, (rnd() - 0.5) * r * 0.15);
      const j = 0.86 + rnd() * 0.28;
      col.copy(color).multiplyScalar(j);
      this.quad(new THREE.Vector3(cx, cy + (rnd() - 0.5) * r * 0.2, cz), right, upv, nfn, col, rnd() < 0.5);
    }
    const a = rnd() * Math.PI;
    const j = 0.92 + rnd() * 0.2;
    col.copy(color).multiplyScalar(j);
    this.quad(new THREE.Vector3(cx, cy + r * 0.3, cz), new THREE.Vector3(Math.cos(a) * r * 0.85, 0, Math.sin(a) * r * 0.85), new THREE.Vector3(-Math.sin(a) * r * 0.85, 0, Math.cos(a) * r * 0.85), () => new THREE.Vector3(0, 1, 0), col, false);
  }

  // one palm frond card from the crown point, rotated yaw about Y and drooping by tilt
  frond(top, yaw, tilt, len, width, color, rnd) {
    const dir = new THREE.Vector3(Math.cos(yaw) * Math.cos(tilt), -Math.sin(tilt), Math.sin(yaw) * Math.cos(tilt));
    const side = new THREE.Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
    const c = top.clone().addScaledVector(dir, len / 2);
    const r = dir.clone().multiplyScalar(len / 2);
    const u = side.clone().multiplyScalar(width / 2);
    const n = new THREE.Vector3().crossVectors(u, r).normalize();
    if (n.y < 0) n.negate();
    const nfn = () => n.clone().lerp(new THREE.Vector3(0, 1, 0), 0.4).normalize();
    const col = color.clone().multiplyScalar(0.88 + rnd() * 0.24);
    this.quad(c, r, u, nfn, col, false);
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    return geo;
  }
}

// crown geometry for a tree type: clumps are [x, y, z, r] in metres at scale 1
export function crownGeometry({ kind, clumps = [], fronds = null, treeH, seed = 1, tint = '#ffffff' }) {
  const rnd = mulberry32(seed);
  const b = new CardBuilder(treeH);
  const color = new THREE.Color(tint);
  for (const [x, y, z, r] of clumps) b.cluster(x, y, z, r, rnd, color);
  if (fronds) {
    // two rings: an upper spray and a lower, more drooping one
    const top = new THREE.Vector3(fronds.x || 0, fronds.y, fronds.z || 0);
    for (let i = 0; i < fronds.count; i++) {
      const yaw = (i / fronds.count) * Math.PI * 2 + rnd() * 0.4;
      const tilt = fronds.tilt + (rnd() - 0.5) * 0.35;
      b.frond(top, yaw, tilt, fronds.len * (0.85 + rnd() * 0.3), fronds.width, color, rnd);
    }
    const lower = top.clone().setY(top.y - 0.35);
    for (let i = 0; i < fronds.count; i++) {
      const yaw = ((i + 0.5) / fronds.count) * Math.PI * 2 + rnd() * 0.4;
      const tilt = fronds.tilt + 0.45 + (rnd() - 0.5) * 0.3;
      b.frond(lower, yaw, tilt, fronds.len * (0.7 + rnd() * 0.3), fronds.width * 0.9, color, rnd);
    }
  }
  return b.build();
}

// ------------------------------------------------------------------ materials
// Shared per leaf kind. uTime and uWind are the same uniform objects on every
// material, so one update per frame moves every tree.
export class Foliage {
  constructor() {
    this.uTime = { value: 0 };
    this.uWind = { value: new THREE.Vector3(1, 0, 0) }; // x,z: direction; y: speed (m/s)
    this.mats = {};
  }

  // vertex sway in world space, applied after the instance transform
  patch(sh) {
    sh.uniforms.uTime = this.uTime;
    sh.uniforms.uWind = this.uWind;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform vec3 uWind;\nattribute float aSway;')
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec3 wp0 = instanceMatrix[3].xyz;
        #else
          vec3 wp0 = vec3(0.0);
        #endif
        float ph = wp0.x * 0.37 + wp0.z * 0.53;
        float sp = uWind.y;
        float gust = sin(uTime * 1.1 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.3 + sin(uTime * 5.3 + ph * 2.9 + aSway * 6.0) * 0.1 * min(sp, 6.0) / 6.0;
        float amp = aSway * (0.05 + sp * 0.035);
        mvPosition.xz += uWind.xz * (gust * amp + amp * 0.6 * min(sp / 8.0, 1.0));
        mvPosition.y -= abs(gust) * amp * 0.2;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);
  }

  material(kind) {
    if (this.mats[kind]) return this.mats[kind];
    const map = leafTexture(kind);
    const mat = new THREE.MeshLambertMaterial({ map, alphaTest: ALPHA_TEST, side: THREE.FrontSide, vertexColors: true });
    mat.onBeforeCompile = (sh) => this.patch(sh);
    mat.customProgramCacheKey = () => 'foliage-' + kind;
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map, alphaTest: ALPHA_TEST });
    depth.onBeforeCompile = (sh) => this.patch(sh);
    depth.customProgramCacheKey = () => 'foliage-depth-' + kind;
    this.mats[kind] = { mat, depth };
    return this.mats[kind];
  }

  update(dt, wind) {
    this.uTime.value += dt;
    const ws = Math.hypot(wind[0], wind[2]);
    const w = this.uWind.value;
    if (ws > 0.01) w.set(wind[0] / ws, ws, wind[2] / ws);
    else w.set(1, 0, 0);
  }
}
