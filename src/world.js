// Builds the Three.js scene for one hole: sculpted terrain with a painted
// surface texture, surrounding landscape, water, trees, bunkers, flag and props.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { Effects } from './fx.js';
import { Foliage, crownGeometry } from './foliage.js';
import { Hole, fbm, vnoise, mulberry32, YD } from './hole.js';

import { clamp, smooth } from './util.js';
// palette colours are sRGB hex; the painted canvas is tagged SRGBColorSpace, so keep them in sRGB 0-255
const hex = (h) => { const c = new THREE.Color(h); const s = c.clone().convertLinearToSRGB(); return [s.r * 255, s.g * 255, s.b * 255]; };
// cheap integer hash -> [0, 1) for per-texel grain
const hash2 = (i, j) => { let h = Math.imul(i, 374761393) + Math.imul(j, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ---------------------------------------------------------------- shared textures
let detailTex = null;
function getDetailTexture() {
  if (detailTex) return detailTex;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const rnd = mulberry32(99);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = 0.55 * (vnoise(x / 6, y / 6, 3) * 0.5 + 0.5) + 0.25 * (vnoise(x / 2, y / 2, 4) * 0.5 + 0.5) + 0.2 * rnd();
    const v = Math.floor(clamp(n, 0, 1) * 255);
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  detailTex = new THREE.CanvasTexture(c);
  detailTex.wrapS = detailTex.wrapT = THREE.RepeatWrapping;
  detailTex.colorSpace = THREE.NoColorSpace;
  return detailTex;
}

let waterNormal = null;
function getWaterNormal() {
  if (waterNormal) return waterNormal;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const h = (x, y) => fbm(x / 22, y / 22, 11, 3) + 0.4 * fbm(x / 7, y / 7, 12, 2);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // tileable-ish by sampling on a torus
    const dx = h(x + 1, y) - h(x - 1, y), dy = h(x, y + 1) - h(x, y - 1);
    const i = (y * S + x) * 4;
    img.data[i] = 128 + dx * 300; img.data[i + 1] = 128 + dy * 300; img.data[i + 2] = 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  waterNormal = new THREE.CanvasTexture(c);
  waterNormal.wrapS = waterNormal.wrapT = THREE.MirroredRepeatWrapping;
  waterNormal.colorSpace = THREE.NoColorSpace;
  return waterNormal;
}

// Terrain material: painted map + world-space detail noise + rocky slopes,
// plus two things that only make sense in the shader: a view-dependent sheen on
// the mowing stripes (blades bent away from you are light, toward you dark, so
// the stripes flip from the reverse angle like they do on television) and a
// micro normal from the detail noise so the grass catches a low sun.
function terrainMaterial(map, rockColor, stripeMap, stripeDir) {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.88, metalness: 0 });
  mat.userData.uSheen = { value: 0.14 }; // stripe sheen strength
  mat.userData.uMicro = { value: 1.8 };  // micro normal strength
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: getDetailTexture() };
    sh.uniforms.rockColor = { value: new THREE.Color(rockColor) };
    sh.uniforms.stripeMap = { value: stripeMap };
    sh.uniforms.stripeDir = { value: stripeDir };
    sh.uniforms.uSheen = mat.userData.uSheen;
    sh.uniforms.uMicro = mat.userData.uMicro;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed,1.0)).xyz;\nvWNorm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNorm;\nuniform sampler2D detailMap;\nuniform vec3 rockColor;\nuniform sampler2D stripeMap;\nuniform vec2 stripeDir;\nuniform float uSheen;\nuniform float uMicro;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float d1 = texture2D(detailMap, vWPos.xz * 0.45).r;
        float d2 = texture2D(detailMap, vWPos.xz * 0.045).r;
        diffuseColor.rgb *= 0.86 + 0.2 * d1 + 0.12 * (d2 - 0.5);
        float slope = 1.0 - vWNorm.y;
        float rock = smoothstep(0.42, 0.62, slope);
        diffuseColor.rgb = mix(diffuseColor.rgb, rockColor * (0.8 + 0.4 * d1), rock);
        // stripe sheen: phase is -1..1 on the fairway, 0 elsewhere
        float ph = texture2D(stripeMap, vMapUv).r * 2.0 - 1.0;
        vec2 toFrag = normalize(vWPos.xz - cameraPosition.xz);
        diffuseColor.rgb *= 1.0 + uSheen * ph * dot(toFrag, stripeDir);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // micro normal: finite difference of the detail noise at ~9 m tiles, world space -> view space
          vec2 duv = vWPos.xz * 0.11;
          float e = 1.0 / 256.0;
          float gx = texture2D(detailMap, duv + vec2(e, 0.0)).r - texture2D(detailMap, duv - vec2(e, 0.0)).r;
          float gz = texture2D(detailMap, duv + vec2(0.0, e)).r - texture2D(detailMap, duv - vec2(0.0, e)).r;
          float micro = 1.0 - smoothstep(0.42, 0.62, 1.0 - vWNorm.y);
          normal = normalize(normal + mat3(viewMatrix) * vec3(-gx, 0.0, -gz) * (uMicro * micro));
        }`);
  };
  return mat;
}

// Props use Standard rather than Lambert: only Standard materials receive the
// scene environment, and without it the faces turned away from the sun (the
// Road hole hotel seen from the tee) went nearly black.
function propMaterial(color) { return new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 }); }

// mowing stripe phase (0..1, soft-edged) at a distance s along the hole
function stripePhase(s) { return smooth(0.3, 0.7, 0.5 + 0.5 * Math.sin((s / 9.5) * Math.PI)); }

// ---------------------------------------------------------------- tree geometry
function colorGeo(geo, color, jitter = 0.08, seed = 1) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color(color);
  const rnd = mulberry32(seed);
  for (let i = 0; i < n; i += 3) {
    const j = 1 + (rnd() - 0.5) * jitter * 2;
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r * j; col[(i + k) * 3 + 1] = c.g * j; col[(i + k) * 3 + 2] = c.b * j; }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}
function merge(geos) {
  let n = 0;
  for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return m;
}
function blobGeo(r, detail, seed, squash = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  const rnd = mulberry32(seed);
  const offs = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!offs.has(key)) offs.set(key, 0.82 + rnd() * 0.36);
    const s = offs.get(key);
    p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * squash, p.getZ(i) * s);
  }
  return g;
}
// Each builder returns the wood geometry (trunk, vertex-coloured, may be null),
// the leaf card geometry (see foliage.js) with its texture kind, and the
// collision metrics physics uses. Clump positions are shared by both so the
// crowns the ball hits are the crowns you see.
const TREE_BUILDERS = {
  // Loblolly pine: tall bare trunk with a high, clumpy crown (Augusta)
  pine: () => {
    const clumps = [[0, 19, 0, 3.4], [1.8, 16.5, 0.6, 2.6], [-1.6, 17.2, -0.9, 2.7], [0.4, 22, 0.4, 2.5], [-0.8, 14.6, 1.2, 2.2], [1.1, 20.2, -1.5, 2.3]];
    const wood = colorGeo(new THREE.CylinderGeometry(0.22, 0.42, 20, 7).translate(0, 10, 0), '#5a4330', 0.1, 1);
    return { wood, leaf: crownGeometry({ kind: 'pine', clumps, treeH: 24.5, seed: 3 }), leafKind: 'pine',
      h: 24.5, crownY: 12.5, crownR: 3.6, trunkR: 0.4, trunkH: 13, shape: 'ellipsoid', density: 0.22 };
  },
  oak: () => {
    const clumps = [[0, 8, 0, 4.6], [3, 7, 1, 3.4], [-3, 7.4, -1, 3.5], [1, 9.6, -2.4, 3.2], [-1.4, 9.2, 2.6, 3.2]];
    const wood = colorGeo(new THREE.CylinderGeometry(0.35, 0.6, 6, 7).translate(0, 3, 0), '#4d3a28', 0.1, 2);
    return { wood, leaf: crownGeometry({ kind: 'oak', clumps, treeH: 13, seed: 11 }), leafKind: 'oak',
      h: 13, crownY: 4.5, crownR: 6.5, trunkR: 0.55, trunkH: 5, shape: 'ellipsoid', density: 0.35 };
  },
  dogwood: () => {
    const clumps = [[0, 3.8, 0, 2.2], [1.3, 3.3, 0.4, 1.6], [-1.2, 3.5, -0.4, 1.7]];
    const wood = colorGeo(new THREE.CylinderGeometry(0.12, 0.2, 2.6, 6).translate(0, 1.3, 0), '#5a4535', 0.1, 3);
    return { wood, leaf: crownGeometry({ kind: 'dogwood', clumps, treeH: 5.5, seed: 21 }), leafKind: 'dogwood',
      h: 5.5, crownY: 2.2, crownR: 2.8, trunkR: 0.2, trunkH: 2.4, shape: 'ellipsoid', density: 0.4 };
  },
  cypress: () => {
    const clumps = [[0.8, 7.5, 0, 5.2], [-1.5, 8.5, 1, 4], [2.5, 9, -1, 3.6], [0.5, 10, 0.5, 3.4]];
    const wood = colorGeo(new THREE.CylinderGeometry(0.3, 0.6, 7, 6).rotateZ(0.12).translate(0.4, 3.5, 0), '#5b4a3a', 0.1, 4);
    // wind-flattened Monterey cypress: wide, low cards
    const leaf = crownGeometry({ kind: 'cypress', clumps, treeH: 11, seed: 31 });
    leaf.scale(1, 0.55, 1); leaf.translate(0, 3.6, 0);
    return { wood, leaf, leafKind: 'cypress', h: 11, crownY: 6, crownR: 5.5, trunkR: 0.5, trunkH: 6.5, shape: 'ellipsoid', density: 0.35 };
  },
  palm: () => {
    const wood = merge([
      colorGeo(new THREE.CylinderGeometry(0.22, 0.3, 10, 6).translate(0, 5, 0), '#7a6a52', 0.15, 5),
      colorGeo(blobGeo(0.6, 0, 50).translate(0, 10, 0), '#556b33', 0.1, 51),
    ]);
    const leaf = crownGeometry({ kind: 'frond', fronds: { y: 10.1, count: 9, tilt: 0.5, len: 3.8, width: 1.6 }, treeH: 11.5, seed: 41 });
    return { wood, leaf, leafKind: 'frond', h: 11.5, crownY: 9, crownR: 3.4, trunkR: 0.3, trunkH: 10, shape: 'palm', density: 0.25 };
  },
  gorse: () => {
    const clumps = [[0, 0.7, 0, 1.2], [0.9, 0.55, 0.3, 0.9], [-0.8, 0.6, -0.3, 0.95]];
    return { wood: null, leaf: crownGeometry({ kind: 'gorse', clumps, treeH: 1.6, seed: 61 }), leafKind: 'gorse',
      h: 1.6, crownY: 0, crownR: 1.6, trunkR: 0, trunkH: 0, shape: 'ellipsoid', density: 1.2 };
  },
  azalea: () => {
    const clumps = [[0, 0.8, 0, 1.2], [1.1, 0.6, 0.3, 0.9], [-1, 0.65, -0.3, 1]];
    return { wood: null, leaf: crownGeometry({ kind: 'azalea', clumps, treeH: 1.8, seed: 101 }), leafKind: 'azalea',
      h: 1.8, crownY: 0, crownR: 1.6, trunkR: 0, trunkH: 0, shape: 'ellipsoid', density: 1.2 };
  },
};
const treeProtos = {};
function proto(type) {
  if (!treeProtos[type]) treeProtos[type] = TREE_BUILDERS[type]();
  return treeProtos[type];
}

// ---------------------------------------------------------------- the world
export class World {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.group = null;
    this.clock = 0;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.initSkyAndLights();
    // impact effects live outside the per-hole group so they survive rebuilds
    this.fx = new Effects();
    this.scene.add(this.fx.group);
    // leaf materials are shared across holes (textures are painted once)
    this.foliage = new Foliage();
  }

  initSkyAndLights() {
    const scene = this.scene;
    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    scene.add(this.sky);
    this.hemi = new THREE.HemisphereLight(0xe4f1ff, 0x55683f, 0.9);
    scene.add(this.hemi);
    // late-afternoon sun: warm, with a tight shadow box around the action for crisp ball and tree shadows
    this.sun = new THREE.DirectionalLight(0xffe6c2, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -50; sc.right = 50; sc.top = 50; sc.bottom = -50; sc.near = 1; sc.far = 600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.fog = new THREE.Fog(0xcfe0ea, 400, 2600);
  }

  setCourse(course) {
    this.course = course;
    const s = course.sky;
    const sunDir = new THREE.Vector3(...s.sun).normalize();
    this.sunDir = sunDir;
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4; u.rayleigh.value = 1.2; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(sunDir).multiplyScalar(1000);
    this.scene.fog.color.set(s.fog);
    // environment map from sky for reflections (water, ball)
    const skyScene = new THREE.Scene();
    const sky2 = new Sky(); sky2.scale.setScalar(1000);
    Object.assign(sky2.material.uniforms.sunPosition.value, u.sunPosition.value);
    sky2.material.uniforms.turbidity.value = 4; sky2.material.uniforms.rayleigh.value = 1.2;
    skyScene.add(sky2);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(skyScene);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.5;
  }

  // Build a hole. Returns the Hole (physics/geometry) object.
  buildHole(course, index, opts = {}) {
    const t0 = performance.now();
    if (this.group) { this.disposeGroup(this.group); this.scene.remove(this.group); }
    if (this.stripeTex) { this.stripeTex.dispose(); this.stripeTex = null; }
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.gridGroup = null;
    this.flow = null;
    const hole = new Hole(course.holes[index], course, index, opts);
    this.hole = hole;
    this.fx.clear(hole, (x, z) => this.meshHeight(x, z));
    this.rnd = mulberry32(hole.seed + 1000);
    this.placeTrees(hole);
    this.buildTerrain(hole);
    this.buildSkirt(hole);
    this.buildWater(hole);
    this.buildTreeMeshes(hole);
    this.buildFlag(hole);
    this.buildTeeMarkers(hole);
    this.buildProps(hole);
    this.buildMarkers();
    this.buildTime = performance.now() - t0;
    return hole;
  }

  disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        if (o.userData.shared) return; // material and map are owned by the World (foliage)
        for (const m of ms) { if (m.map && m.map !== detailTex) m.map.dispose(); m.dispose(); }
      }
    });
  }

  // ------------------------------------------------------------ trees
  placeTrees(hole) {
    const st = hole.style;
    const rnd = this.rnd;
    const trees = [];
    const types = st.trees.types;
    const B = hole.bounds;
    const add = (type, x, z, scale = 1, straw = true) => {
      const p = proto(type);
      const y = hole.height(x, z);
      trees.push({ type, x, z, y, scale, h: p.h * scale, crownY: p.crownY * scale, crownR: p.crownR * scale,
        trunkR: p.trunkR * scale, trunkH: p.trunkH * scale, shape: p.shape, density: p.density, rot: rnd() * 6.28, straw: straw && type !== 'gorse' && type !== 'azalea' });
    };
    const clear = (x, z, pad) => {
      if (hole.greenSdf(x, z) < 14 + pad) return false;
      if (hole.bunkerSdf(x, z).d < 3 + pad) return false;
      if (hole.waterSdf(x, z).d < 3 + pad) return false;
      if (hole.teeSdf(x, z) < 8 + pad) return false;
      if (hole.roadSdf(x, z) < 2) return false;
      return true;
    };
    const corridor = (x, z) => {
      const pr = hole.project(x, z);
      const fsd = hole.fairwaySdf(x, z, pr);
      const lat = Math.abs(pr.o) - (hole.par === 3 ? 26 : 20);
      return Math.min(fsd, lat);
    };
    if (st.trees.density > 0) {
      const gap = (st.trees.gap || 18) * YD;
      const step = 7.5;
      for (let x = B.minX - 60; x < B.maxX + 60; x += step) {
        for (let z = B.minZ - 60; z < B.maxZ + 60; z += step) {
          const px = x + (rnd() - 0.5) * step * 0.9, pz = z + (rnd() - 0.5) * step * 0.9;
          const inside = px > B.minX && px < B.maxX && pz > B.minZ && pz < B.maxZ;
          const cd = corridor(px, pz);
          if (cd < gap * 0.7) continue;
          const clump = fbm(px * 0.02, pz * 0.02, hole.seed + 5, 2) * 0.5 + 0.5;
          let p = st.trees.density * smooth(gap * 0.7, gap + 30, cd) * (0.25 + clump) * 0.75;
          if (!inside) p = st.trees.density * 0.65 * (0.3 + clump);
          if (rnd() > p) continue;
          if (!clear(px, pz, 0)) continue;
          if (hole.waterSdf(px, pz).d < 6) continue;
          const type = types[Math.floor(rnd() * types.length)];
          add(type, px, pz, 0.8 + rnd() * 0.45, inside);
        }
      }
    }
    // gorse (links)
    if (st.gorse) {
      for (let i = 0; i < 1400; i++) {
        const px = B.minX - 40 + rnd() * (B.maxX - B.minX + 80);
        const pz = B.minZ - 40 + rnd() * (B.maxZ - B.minZ + 80);
        const cd = corridor(px, pz);
        if (cd < 14) continue;
        const cl = fbm(px * 0.03, pz * 0.03, hole.seed + 8, 2);
        if (cl < 0.05) continue;
        if (!clear(px, pz, 0)) continue;
        add('gorse', px, pz, 0.8 + rnd() * 0.8, false);
      }
    }
    // azaleas / flowers
    const fl = hole.def.flowers || [];
    for (const [dx, dy, count] of fl) {
      const c = hole.gToW(dx, dy);
      for (let i = 0; i < count; i++) {
        const a = rnd() * 6.28, r = Math.sqrt(rnd()) * 14;
        const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
        if (clear(x, z, -10) && hole.waterSdf(x, z).d > 2 && hole.greenSdf(x, z) > 6) add('azalea', x, z, 0.8 + rnd() * 0.6, false);
      }
    }
    if (st.flowers) {
      // scattered azaleas and dogwoods along the tree lines
      for (let i = 0; i < 60; i++) {
        const t = trees[Math.floor(rnd() * trees.length)];
        if (!t || t.type === 'azalea') continue;
        const x = t.x + (rnd() - 0.5) * 10, z = t.z + (rnd() - 0.5) * 10;
        if (corridor(x, z) > 10 && clear(x, z, 0)) add('azalea', x, z, 0.7 + rnd() * 0.5, false);
      }
    }
    for (const [s, o, type, sc] of hole.def.trees || []) {
      const w = hole.soToW(s * YD, o * YD);
      add(type, w.x, w.z, sc || 1, true);
    }
    hole.setTrees(trees.filter((t) => t.x > B.minX - 5 && t.x < B.maxX + 5 && t.z > B.minZ - 5 && t.z < B.maxZ + 5));
    this.allTrees = trees;
  }

  // two instanced meshes per type: wood (trunks) and leaf cards; both share the
  // instance transforms, so a tree's crown always sits on its own trunk
  buildTreeMeshes() {
    const byType = {};
    for (const t of this.allTrees) (byType[t.type] ||= []).push(t);
    // Standard (not Lambert) so the sky environment fills the shadow side of a trunk
    const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    for (const [type, list] of Object.entries(byType)) {
      const pr = proto(type);
      const { mat, depth } = this.foliage.material(pr.leafKind);
      const meshes = [];
      if (pr.wood) meshes.push(new THREE.InstancedMesh(pr.wood, woodMat, list.length));
      const leaf = new THREE.InstancedMesh(pr.leaf, mat, list.length);
      leaf.customDepthMaterial = depth; // leaf-shaped shadows
      leaf.userData.shared = true;
      leaf.userData.noAO = true; // see post.js: cards must stay out of the AO pre-pass
      meshes.push(leaf);
      list.forEach((t, i) => {
        q.setFromAxisAngle(up, t.rot);
        s.setScalar(t.scale);
        p.set(t.x, t.y - 0.2, t.z);
        m4.compose(p, q, s);
        const v = 0.85 + ((t.rot * 1000) % 1) * 0.3;
        col.setRGB(v, v, v);
        for (const m of meshes) { m.setMatrixAt(i, m4); m.setColorAt(i, col); }
      });
      for (const m of meshes) {
        m.castShadow = type !== 'gorse' && type !== 'azalea';
        m.receiveShadow = true;
        this.group.add(m);
      }
    }
  }

  // ------------------------------------------------------------ terrain
  buildTerrain(hole) {
    const B = hole.bounds;
    const W = B.maxX - B.minX, D = B.maxZ - B.minZ;
    const sp = Math.max(0.9, Math.sqrt((W * D) / 230000));
    const nx = Math.ceil(W / sp) + 1, nz = Math.ceil(D / sp) + 1;
    const pos = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) {
      const z = B.minZ + (j / (nz - 1)) * D;
      for (let i = 0; i < nx; i++) {
        const x = B.minX + (i / (nx - 1)) * W;
        const k = j * nx + i;
        pos[k * 3] = x; pos[k * 3 + 1] = hole.height(x, z); pos[k * 3 + 2] = z;
        uv[k * 2] = i / (nx - 1); uv[k * 2 + 1] = j / (nz - 1);
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let o = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    this.terrainGrid = { nx, nz, pos, minX: B.minX, minZ: B.minZ, sx: W / (nx - 1), sz: D / (nz - 1) };

    const tex = this.paintTexture(hole);
    const dir = new THREE.Vector2(hole.cup.x - hole.tee.x, hole.cup.z - hole.tee.z).normalize();
    const mat = terrainMaterial(tex, hole.style.palette.dirt, this.stripeTex, dir);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.group.add(mesh);
    this.terrain = mesh;
  }

  // height of the rendered terrain mesh (triangle-interpolated), so decals sit exactly on it
  meshHeight(x, z) {
    const G = this.terrainGrid;
    if (!G) return this.hole ? this.hole.height(x, z) : 0;
    const fx = Math.min(Math.max((x - G.minX) / G.sx, 0), G.nx - 1.0001), fz = Math.min(Math.max((z - G.minZ) / G.sz, 0), G.nz - 1.0001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const H = (ii, jj) => G.pos[(jj * G.nx + ii) * 3 + 1];
    const ha = H(i, j), hb = H(i + 1, j), hc = H(i, j + 1), hd = H(i + 1, j + 1);
    // same split as the index buffer: (a, c, b) below the diagonal, (b, c, d) above
    return u + v <= 1 ? ha + (hb - ha) * u + (hc - ha) * v : hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
  }

  paintTexture(hole) {
    const B = hole.bounds;
    const W = B.maxX - B.minX, D = B.maxZ - B.minZ;
    const texel = Math.max(0.3, Math.sqrt((W * D) / 1_150_000));
    const tw = Math.min(4096, Math.ceil(W / texel)), th = Math.min(4096, Math.ceil(D / texel));
    const c = document.createElement('canvas');
    c.width = tw; c.height = th;
    const g = c.getContext('2d');
    const img = g.createImageData(tw, th);
    const P = hole.style.palette;
    const col = {
      fw: [hex(P.fairway[0]), hex(P.fairway[1])], cut: hex(P.cut), second: hex(P.second || P.rough), rough: hex(P.rough), deep: hex(P.deep),
      green: [hex(P.green[0]), hex(P.green[1])], fringe: hex(P.fringe), bunker: hex(P.bunker), waste: hex(P.waste), straw: hex(P.straw),
      tee: [hex(P.tee[0]), hex(P.tee[1])], dirt: hex(P.dirt),
      // stripes: push the palette pair apart so the mow pattern reads from the address camera
      fwDark: mix3(hex(P.fairway[0]), [0, 0, 0], 0.07), fwLight: mix3(hex(P.fairway[1]), [255, 255, 255], 0.07), path: hex(P.path), strawDark: mix3(hex(P.straw), [40, 25, 12], 0.35), strawLight: mix3(hex(P.straw), [220, 180, 120], 0.3), water: hex(P.water), mud: [70, 80, 60], rock: [120, 112, 98], sand: hex(hole.style.sand || '#e8dcb8'),
    };
    const st = hole.style;
    const roughKind = st.roughType || 'rough';
    const farKind = st.farType || 'deep';
    const roughW = st.roughWidth ?? 20, cutW = st.cutWidth ?? 2.2, gCut = st.greenCut ?? 5;
    const gf = hole.gf;
    const strawOn = !!st.straw;
    const data = img.data;
    const hz = g.createImageData(tw, th), hzd = hz.data; // minimap hazard hatching
    const hatch = Math.max(3, Math.round(4 / texel));
    for (let j = 0; j < th; j++) {
      const z = B.minZ + ((j + 0.5) / th) * D;
      for (let i = 0; i < tw; i++) {
        const x = B.minX + ((i + 0.5) / tw) * W;
        const pr = hole.project(x, z);
        const fsd = hole.fairwaySdf(x, z, pr);
        const gsd = hole.greenSdf(x, z);
        const n = fbm(x * 0.05, z * 0.05, 3, 2);
        // base: rough bands
        let c3 = col[farKind === 'straw' ? 'second' : farKind] || col.deep;
        if (farKind === 'straw') c3 = mix3(col.second, col.deep, 0.5);
        c3 = mix3(c3, col[roughKind] || col.rough, 1 - smooth(roughW - 2, roughW + 2, fsd));
        c3 = mix3(c3, col.cut, 1 - smooth(cutW - 0.4, cutW + 0.4, Math.min(fsd, gsd - gCut + cutW)));
        // fairway with mowing stripes
        if (fsd < 0.6) {
          // soft-edged stripes: the mower's light/dark passes blend over ~1 m
          const sv = stripePhase(pr.s);
          let fc = mix3(col.fwDark, col.fwLight, sv);
          if (st.crossMow) fc = mix3(fc, mix3(col.fw[0], col.fw[1], smooth(0.3, 0.7, 0.5 + 0.5 * Math.sin(((pr.o + 200) / 14) * Math.PI))), 0.3);
          c3 = mix3(c3, fc, 1 - smooth(-0.3, 0.3, fsd));
        }
        // pine straw under trees
        if (strawOn && fsd > 4) {
          let best = 99;
          for (const t of hole.treesAround(x, z)) {
            if (!t.straw) continue;
            const d = Math.hypot(t.x - x, t.z - z) / (t.crownR * 1.4 + 2);
            if (d < best) best = d;
          }
          if (best < 1.3) {
            // needles: per-texel speckle between dark and sun-bleached straw
            const h = hash2(i, j), needle = h < 0.33 ? col.strawDark : h > 0.85 ? col.strawLight : col.straw;
            c3 = mix3(c3, needle, (1 - smooth(0.7, 1.3, best)) * (0.85 + n * 0.3));
          }
        }
        // tree shade (ambient occlusion)
        // tee
        const tsd = hole.teeSdf(x, z);
        if (tsd < 0.5) {
          const along = (x - hole.tee.x) * hole.teeDir.x + (z - hole.tee.z) * hole.teeDir.z;
          c3 = mix3(c3, col.tee[Math.floor((along + 100) / 3) % 2], 1 - smooth(-0.25, 0.25, tsd));
        }
        // road / path
        const rsd = hole.roads.length ? hole.roadSdf(x, z) : 99;
        if (rsd < 0.4) c3 = mix3(c3, col.path, 1 - smooth(-0.2, 0.2, rsd));
        // green + fringe
        if (gsd < 2) {
          const dx = (x - gf.x) * gf.rx + (z - gf.z) * gf.rz, dy = (x - gf.x) * gf.fx + (z - gf.z) * gf.fz;
          const sa = Math.floor((dx + dy + 200) / 4.2) % 2, sb = Math.floor((dx - dy + 200) / 4.2) % 2;
          const gc = mix3(col.green[sa], col.green[sb], 0.5);
          c3 = mix3(c3, col.fringe, 1 - smooth(1.1, 1.5, gsd));
          c3 = mix3(c3, gc, 1 - smooth(-0.15, 0.15, gsd));
        }
        // bunkers
        const { d: bd, b } = hole.bunkerSdf(x, z);
        if (bd < 1.2) {
          const sand = b.kind === 'waste' ? col.waste : col.bunker;
          const edge = b.kind === 'pot' ? col.dirt : mix3(c3, [c3[0] * 0.8, c3[1] * 0.8, c3[2] * 0.8], 0.6);
          c3 = mix3(c3, edge, 1 - smooth(0.4, 1.2, bd));
          const rake = 0.96 + 0.04 * Math.sin((x * 0.7 + z * 0.4) * 6);
          c3 = mix3(c3, [sand[0] * rake, sand[1] * rake, sand[2] * rake], 1 - smooth(-0.2, 0.15, bd));
        }
        // water beds & banks
        const { d: wd, w } = hole.waterSdf(x, z);
        if (wd < 1.5) {
          if (w.kind === 'ocean') c3 = mix3(c3, col.sand, 1 - smooth(-0.5, 1.5, wd));
          else c3 = mix3(c3, col.mud, 1 - smooth(-0.3, 1.5, wd));
          c3 = mix3(c3, col.water, 1 - smooth(-5, -1.2, wd)); // deeper bed reads as water (also on the minimap)
          if (wd < 0 && (i + j) % hatch === 0) { const q = (j * tw + i) * 4; hzd[q] = 255; hzd[q + 1] = 90; hzd[q + 2] = 80; hzd[q + 3] = 200; }
        }
        // colour noise: broad patches plus a fine grass grain
        const k = 1 + n * 0.07 + (hash2(i, j) - 0.5) * 0.035;
        // canvas row 0 = top = minZ
        const id2 = (j * tw + i) * 4;
        data[id2] = clamp(c3[0] * k, 0, 255);
        data[id2 + 1] = clamp(c3[1] * k, 0, 255);
        data[id2 + 2] = clamp(c3[2] * k, 0, 255);
        data[id2 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // tree shadows (soft AO blobs)
    g.globalCompositeOperation = 'multiply';
    for (const t of hole.trees) {
      if (t.type === 'gorse' || t.type === 'azalea') continue;
      const px = ((t.x - B.minX) / W) * tw, py = ((t.z - B.minZ) / D) * th;
      const r = (t.crownR * 1.1 / W) * tw;
      const grd = g.createRadialGradient(px, py, 0, px, py, r);
      grd.addColorStop(0, 'rgba(120,130,110,0.9)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    this.textureCanvas = c;
    // stripe phase at ~1 m, for the view-dependent sheen in terrainMaterial (128 = no stripe)
    const sw = Math.min(1024, Math.ceil(W)), sh = Math.min(1024, Math.ceil(D));
    const sdata = new Uint8Array(sw * sh).fill(128);
    for (let j = 0; j < sh; j++) {
      const z = B.minZ + ((j + 0.5) / sh) * D;
      for (let i = 0; i < sw; i++) {
        const x = B.minX + ((i + 0.5) / sw) * W;
        const pr = hole.project(x, z);
        const fsd = hole.fairwaySdf(x, z, pr);
        if (fsd < 0.6) sdata[j * sw + i] = Math.round(128 + (stripePhase(pr.s) - 0.5) * 254 * (1 - smooth(-0.3, 0.3, fsd)));
      }
    }
    const stripeTex = new THREE.DataTexture(sdata, sw, sh, THREE.RedFormat, THREE.UnsignedByteType);
    stripeTex.minFilter = stripeTex.magFilter = THREE.LinearFilter;
    stripeTex.needsUpdate = true;
    this.stripeTex = stripeTex;
    const hc = document.createElement('canvas');
    hc.width = tw; hc.height = th;
    hc.getContext('2d').putImageData(hz, 0, 0);
    this.hazardCanvas = hc;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    tex.flipY = false;
    return tex;
  }

  // Low resolution landscape that surrounds the playable area
  buildSkirt(hole) {
    const B = hole.bounds;
    const cx = (B.minX + B.maxX) / 2, cz = (B.minZ + B.maxZ) / 2;
    const size = 2600, n = 180;
    const geo = new THREE.PlaneGeometry(size, size, n, n).rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const P = hole.style.palette;
    const far = new THREE.Color(hole.style.forest === 'none' ? P.rough : P.deep);
    const sand = new THREE.Color(hole.style.sand || '#e8dcb8');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + cx, z = p.getZ(i) + cz;
      const inside = x > B.minX + 2 && x < B.maxX - 2 && z > B.minZ + 2 && z < B.maxZ - 2;
      const dOut = Math.max(B.minX - x, x - B.maxX, B.minZ - z, z - B.maxZ, 0);
      let h;
      if (inside) h = hole.height(x, z) - 1.5;
      else {
        h = hole.height(x, z);
        if (hole.style.dunes) h += Math.max(0, fbm(x * 0.012, z * 0.012, 4, 3)) * 14 * smooth(20, 140, dOut);
        else h += fbm(x * 0.004, z * 0.004, 6, 2) * 12 * smooth(30, 300, dOut);
      }
      p.setXYZ(i, x, h - 0.08, z);
      const nn = 0.9 + 0.2 * fbm(x * 0.02, z * 0.02, 2, 2);
      let c = far.clone().multiplyScalar(nn);
      if (hole.waters.some((w) => w.kind === 'ocean') && h < hole.seaLevel + 3) c = sand.clone();
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // ------------------------------------------------------------ water
  waterMaterial(color) {
    const nm = getWaterNormal();
    const mat = new THREE.MeshStandardMaterial({
      color, roughness: 0.08, metalness: 0.15, transparent: true, opacity: 0.88,
      normalMap: nm, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 1.4,
    });
    return mat;
  }

  buildWater(hole) {
    this.waterMats = [];
    const stakes = [];
    const col = hole.style.palette.water;
    for (const w of hole.waters) {
      if (w.kind === 'pond') {
        // outline at sdf = +1.5m
        const shape = new THREE.Shape();
        const N = 72;
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2;
          // march outward along the ray until sdf > 1.5
          let r = 0.2;
          const dx = Math.cos(a), dz = Math.sin(a);
          for (let k = 0; k < 400; k++) {
            const x = w.cx + dx * r, z = w.cz + dz * r;
            const d = w.island ? (Math.hypot(x - w.cx, z - w.cz) < Math.max(w.rx, w.ry) * 1.3 ? -1 : 2) : this.pondSdf(w, x, z);
            if (d > 1.8) break;
            r += 0.5;
          }
          const x = dx * r, z = dz * r;
          if (i === 0) shape.moveTo(x, -z); else shape.lineTo(x, -z);
        }
        const rays = this.shoreRays(hole, w);
        if (w.island && rays.every((r) => r.hits[0])) {
          // cut the island out so the water plane can't show through low spots (bunkers) on it
          const isle = new THREE.Path();
          rays.forEach((r, i) => { const rr = r.hits[0].r - 0.6, x = r.dx * rr, z = r.dz * rr; if (i === 0) isle.moveTo(x, -z); else isle.lineTo(x, -z); });
          shape.holes.push(isle);
        }
        const geo = new THREE.ShapeGeometry(shape, 1).rotateX(-Math.PI / 2);
        const mat = this.waterMaterial(col);
        const m = new THREE.Mesh(geo, mat);
        m.position.set(w.cx, w.level, w.cz);
        m.receiveShadow = true;
        this.group.add(m);
        this.waterMats.push(mat);
        this.buildShore(hole, w, rays, stakes);
      } else if (w.kind === 'creek') {
        // ribbon along the polyline
        const pts = w.pts;
        const pos = [], idx = [];
        const segs = [];
        for (let i = 0; i < pts.length - 1; i++) for (let t = 0; t < 1; t += 0.1) segs.push([i, t]);
        segs.push([pts.length - 2, 1]);
        segs.forEach(([i, t], k) => {
          const a = pts[i], b = pts[i + 1];
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
          const lv = w.levels[i] + (w.levels[i + 1] - w.levels[i]) * t;
          const hw = w.hw + 2.5;
          pos.push(x + nx * hw, lv, z + nz * hw, x - nx * hw, lv, z - nz * hw);
          if (k > 0) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
        });
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const uvs = []; for (let i = 0; i < pos.length / 3; i++) uvs.push(pos[i * 3] * 0.05, pos[i * 3 + 2] * 0.05);
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mat = this.waterMaterial(col);
        mat.side = THREE.DoubleSide;
        const m = new THREE.Mesh(geo, mat);
        this.group.add(m);
        this.waterMats.push(mat);
        // red stakes along both banks
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
          const nx = -(b.z - a.z) / l, nz = (b.x - a.x) / l;
          for (let t = 0; t < l; t += 14) {
            const x = a.x + ((b.x - a.x) * t) / l, z = a.z + ((b.z - a.z) * t) / l;
            for (const sd of [1, -1]) stakes.push([x + nx * sd * (w.hw + 1.6), z + nz * sd * (w.hw + 1.6)]);
          }
        }
      }
    }
    this.buildStakes(hole, stakes);
    if (hole.waters.some((w) => w.kind === 'ocean') || hole.style.ocean) {
      const geo = new THREE.PlaneGeometry(6000, 6000, 1, 1).rotateX(-Math.PI / 2);
      const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 120, uv.getY(i) * 120);
      const mat = this.waterMaterial('#1b5876');
      mat.opacity = 0.95;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(hole.gf.x, hole.seaLevel, hole.gf.z);
      this.group.add(m);
      this.waterMats.push(mat);
      // surf line
    }
  }
  // Wet-edge foam where the pond meets the bank, and penalty stakes around it.
  // The shoreline is found by marching rays from the pond centre and noting
  // where the terrain crosses the water level (an island pond has two shores).
  shoreRays(hole, w) {
    const N = 96, step = 0.3, rMax = Math.max(w.rx, w.ry) * 1.6 + 12;
    // wet = below the water level and inside the penalty area (not a bunker dipping low)
    const wetAt = (x, z) => hole.height(x, z) < w.level && hole.waterSdf(x, z).d < 2;
    const rays = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
      const hits = [];
      let wet = wetAt(w.cx, w.cz);
      for (let r = step; r < rMax; r += step) {
        const now = wetAt(w.cx + dx * r, w.cz + dz * r);
        if (now !== wet) { hits.push({ r, waterInside: !now }); wet = now; }
        if (hits.length >= 2) break;
      }
      rays.push({ dx, dz, hits });
    }
    return rays;
  }
  buildShore(hole, w, rays, stakes) {
    const N = rays.length;
    const pos = [], colr = [], idx = [];
    for (let k = 0; k < 2; k++) {
      if (!rays.every((r) => r.hits[k])) continue;
      const base = pos.length / 3;
      rays.forEach((ray, i) => {
        const h = ray.hits[k], sgn = h.waterInside ? -1 : 1; // foam extends into the water side
        const r0 = h.r - 0.15 * sgn, r1 = h.r + 0.9 * sgn;
        pos.push(w.cx + ray.dx * r0, w.level + 0.025, w.cz + ray.dz * r0, w.cx + ray.dx * r1, w.level + 0.02, w.cz + ray.dz * r1);
        colr.push(0.95, 0.98, 1, 0.38, 0.95, 0.98, 1, 0);
        const j = (i + 1) % N, a = base + i * 2, b = base + j * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
        // a stake every ~12 m along the shore, just up the bank
        const arc = (2 * Math.PI * h.r) / N;
        if (i % Math.max(1, Math.round(12 / arc)) === 0) { const rs = h.r - 1.4 * sgn; stakes.push([w.cx + ray.dx * rs, w.cz + ray.dz * rs]); }
      });
    }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 4));
    geo.setIndex(idx);
    const foam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    foam.renderOrder = 2;
    this.group.add(foam);
  }

  // Red penalty-area stakes (instanced), skipping any that would sit on the green or tee
  buildStakes(hole, stakes) {
    const keep = stakes.filter(([x, z]) => hole.inBounds(x, z) && hole.greenSdf(x, z) > 3 && hole.teeSdf(x, z) > 1 && hole.waterSdf(x, z).d > 0.3);
    if (!keep.length) return;
    const geo = new THREE.CylinderGeometry(0.025, 0.03, 0.9, 6).translate(0, 0.45, 0);
    const mat = new THREE.MeshLambertMaterial({ color: '#d42a1f' });
    const inst = new THREE.InstancedMesh(geo, mat, keep.length);
    const m4 = new THREE.Matrix4();
    keep.forEach(([x, z], i) => { m4.makeTranslation(x, hole.height(x, z) - 0.05, z); inst.setMatrixAt(i, m4); });
    inst.castShadow = true;
    this.group.add(inst);
  }

  pondSdf(w, x, z) { return this.hole.waterSdf(x, z).w === w ? this.hole.waterSdf(x, z).d : 5; }

  // ------------------------------------------------------------ flag, cup, tees
  buildFlag(hole) {
    const c = hole.cup;
    const y = hole.height(c.x, c.z);
    const g = new THREE.Group();
    g.position.set(c.x, y, c.z);
    const n = hole.normal(c.x, c.z);
    // cup: dark disc + white liner ring, tilted with the green
    const cup = new THREE.Mesh(new THREE.CircleGeometry(0.054, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b0f0b, polygonOffset: true, polygonOffsetFactor: -4 }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.048, 0.056, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xeeeeee, polygonOffset: true, polygonOffsetFactor: -5 }));
    const tilt = new THREE.Group();
    tilt.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...n));
    tilt.add(cup); tilt.add(ring);
    cup.position.y = 0.012; ring.position.y = 0.013;
    g.add(tilt);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0125, 0.0125, 2.3, 8), new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 }));
    pole.position.y = 1.15;
    pole.castShadow = true;
    g.add(pole);
    // flag cloth (animated in update)
    const fg = new THREE.PlaneGeometry(0.75, 0.5, 12, 6);
    fg.translate(0.375, 0, 0);
    const flagCol = this.course.flag || '#f2d22e';
    const cloth = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({ color: flagCol, side: THREE.DoubleSide, roughness: 0.8 }));
    cloth.position.y = 2.02;
    cloth.castShadow = true;
    g.add(cloth);
    this.flagCloth = cloth;
    this.flagBase = fg.attributes.position.array.slice();
    this.flag = g;
    this.group.add(g);
    // pin light marker for far views
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    beacon.position.y = 2.3;
    g.add(beacon);
  }

  buildTeeMarkers(hole) {
    const f = hole.teeDir;
    const r = { x: -f.z, z: f.x };
    const mat = new THREE.MeshStandardMaterial({ color: this.course.teeColor || '#2a5fbf', roughness: 0.5 });
    for (const s of [-1, 1]) {
      const x = hole.tee.x + r.x * 3.2 * s + f.x * 1.2, z = hole.tee.z + r.z * 3.2 * s + f.z * 1.2; // ball is teed up to 2 club-lengths behind the markers
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), mat);
      m.position.set(x, hole.height(x, z) + 0.05, z);
      m.castShadow = true;
      this.group.add(m);
    }
  }

  // ------------------------------------------------------------ props
  buildProps(hole) {
    const add = (obj, x, z, rotY = 0, lift = 0) => {
      obj.position.set(x, hole.height(x, z) + lift, z);
      obj.rotation.y = rotY;
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(obj);
    };
    const faceAng = Math.atan2(hole.teeDir.x, hole.teeDir.z);
    for (const p of hole.def.props || []) {
      const w = p.g ? hole.gToW(p.g[0], p.g[1]) : hole.soToW((p.s || 0) * YD, (p.o || 0) * YD);
      if (p.type === 'clubhouse') add(this.building(28, 12, 16, '#b9aa92', '#4a4a52'), w.x, w.z, faceAng);
      else if (p.type === 'hotel') add(this.building(70, 18, 16, '#9e8f7c', '#3f4148'), w.x, w.z, faceAng + 0.1);
      else if (p.type === 'town') {
        for (let i = 0; i < 9; i++) {
          const b = this.building(12 + (i % 3) * 3, 9 + (i % 4) * 2, 10, ['#a9967b', '#bca98c', '#8f8272'][i % 3], '#3b3b44');
          const q = hole.soToW(((p.s || 0) - 120 + i * 30) * YD, (p.o || 0) * YD);
          add(b, q.x, q.z, faceAng);
        }
      } else if (p.type === 'wall') {
        const m = new THREE.Mesh(new THREE.BoxGeometry(p.len || 40, 1.4, 0.6), propMaterial('#8a8378'));
        const g = new THREE.Group(); g.add(m); m.position.y = 0.7;
        add(g, w.x, w.z, Math.atan2(hole.gf.fx, hole.gf.fz) + Math.PI / 2 - 0.4);
      } else if (p.type === 'bridge') {
        const g = new THREE.Group();
        const mat = propMaterial('#9d9588');
        const arch = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.9, 6, 16, Math.PI), mat);
        arch.scale.set(1, 0.55, 1.8);
        g.add(arch);
        add(g, w.x, w.z, faceAng + Math.PI / 2, -0.4);
      }
    }
    // Augusta-style white clubhouse near the 1st tee / 18th green is represented generically
  }
  building(w, h, d, wall, roof) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), propMaterial(wall));
    body.position.y = h / 2;
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.01, d * 0.72, h * 0.35, 4, 1).rotateY(Math.PI / 4).scale(w / d, 1, 1), propMaterial(roof));
    r.position.y = h + h * 0.175;
    g.add(body, r);
    // windows
    const wm = new THREE.MeshBasicMaterial({ color: '#2d3440' });
    for (let i = 0; i < Math.floor(w / 4); i++) for (let k = 0; k < Math.floor(h / 4); k++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.6), wm);
      win.position.set(-w / 2 + 2 + i * 4, 2.5 + k * 4, d / 2 + 0.02);
      g.add(win);
    }
    return g;
  }

  // ------------------------------------------------------------ gameplay markers
  buildMarkers() {
    // landing reticle
    const rg = new THREE.RingGeometry(0.85, 1.0, 48).rotateX(-Math.PI / 2);
    this.reticle = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    const inner = new THREE.Mesh(new THREE.CircleGeometry(0.18, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.9, depthWrite: false }));
    this.reticle.add(inner);
    this.reticle.renderOrder = 5;
    this.group.add(this.reticle);
    // aim arc
    this.arcGeo = new THREE.BufferGeometry();
    this.arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 200), 3));
    this.arc = new THREE.Line(this.arcGeo, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.2, gapSize: 0.8, transparent: true, opacity: 0.75 }));
    this.arc.frustumCulled = false;
    this.group.add(this.arc);
    // tracer
    this.tracerGeo = new THREE.BufferGeometry();
    this.tracerGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 4000), 3));
    this.tracer = new THREE.Line(this.tracerGeo, new THREE.LineBasicMaterial({ color: 0xff4d3a, transparent: true, opacity: 0.95 }));
    this.tracer.frustumCulled = false;
    this.group.add(this.tracer);
    // putt line
    this.puttGeo = new THREE.BufferGeometry();
    this.puttGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 600), 3));
    this.puttLine = new THREE.Line(this.puttGeo, new THREE.LineDashedMaterial({ color: 0x9ff5ff, dashSize: 0.15, gapSize: 0.12, transparent: true, opacity: 0.9 }));
    this.puttLine.frustumCulled = false;
    this.puttLine.visible = false;
    this.group.add(this.puttLine);
  }

  setArc(points) {
    const a = this.arcGeo.attributes.position;
    const n = Math.min(points.length, 200);
    for (let i = 0; i < n; i++) a.setXYZ(i, points[i][0], points[i][1], points[i][2]);
    this.arcGeo.setDrawRange(0, n);
    a.needsUpdate = true;
    this.arcGeo.computeBoundingSphere();
    this.arc.computeLineDistances();
  }
  setTracer(points) {
    const a = this.tracerGeo.attributes.position;
    const n = Math.min(points.length, 4000);
    for (let i = 0; i < n; i++) a.setXYZ(i, points[i][0], points[i][1], points[i][2]);
    this.tracerGeo.setDrawRange(0, n);
    a.needsUpdate = true;
  }
  setPuttLine(points) {
    const a = this.puttGeo.attributes.position;
    const n = Math.min(points.length, 600);
    for (let i = 0; i < n; i++) a.setXYZ(i, points[i][0], points[i][1] + 0.02, points[i][2]);
    this.puttGeo.setDrawRange(0, n);
    a.needsUpdate = true;
    this.puttLine.computeLineDistances();
    this.puttLine.visible = n > 1;
  }

  // Green-reading grid (Mario Golf style) with flowing slope dots
  showGreenGrid(show) {
    if (!show) { if (this.gridGroup) this.gridGroup.visible = false; return; }
    if (!this.gridGroup) this.buildGreenGrid();
    this.gridGroup.visible = true;
  }
  buildGreenGrid() {
    const hole = this.hole;
    const gg = new THREE.Group();
    const gf = hole.gf;
    const R = 26;
    const step = 1.0;
    const pos = [], cols = [];
    const c = new THREE.Color();
    const slopeCol = (x, z) => {
      const n = hole.normal(x, z);
      const s = Math.hypot(n[0], n[2]) / n[1] * 100; // % slope
      c.setHSL(clamp(0.55 - s * 0.045, 0, 0.6), 0.9, 0.55);
      return [c.r, c.g, c.b];
    };
    const inside = (x, z) => hole.greenSdf(x, z) < 3;
    for (let a = -R; a <= R; a += step) {
      for (let b = -R; b < R; b += 0.5) {
        for (const dir of [0, 1]) {
          const u1 = dir ? a : b, v1 = dir ? b : a, u2 = dir ? a : b + 0.5, v2 = dir ? b + 0.5 : a;
          if (Math.round(a / step) % 2 !== 0) continue;
          const x1 = gf.x + gf.rx * u1 + gf.fx * v1, z1 = gf.z + gf.rz * u1 + gf.fz * v1;
          const x2 = gf.x + gf.rx * u2 + gf.fx * v2, z2 = gf.z + gf.rz * u2 + gf.fz * v2;
          if (!inside(x1, z1) || !inside(x2, z2)) continue;
          pos.push(x1, hole.height(x1, z1) + 0.015, z1, x2, hole.height(x2, z2) + 0.015, z2);
          const k = slopeCol(x1, z1); cols.push(...k, ...k);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    gg.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false })));
    // flow dots
    const N = 700;
    const dp = new Float32Array(N * 3);
    this.flow = { n: N, pts: [], geo: new THREE.BufferGeometry() };
    const rnd = mulberry32(5);
    for (let i = 0; i < N; i++) this.flow.pts.push(this.spawnFlow(rnd), rnd() * 3);
    this.flow.pts = this.flow.pts.filter((p) => typeof p === 'object');
    this.flow.geo.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    const dc = document.createElement('canvas'); dc.width = dc.height = 32;
    const dx = dc.getContext('2d'), gr = dx.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    dx.fillStyle = gr; dx.fillRect(0, 0, 32, 32);
    const dots = new THREE.Points(this.flow.geo, new THREE.PointsMaterial({ color: 0xeafcff, size: 0.075, map: new THREE.CanvasTexture(dc), transparent: true, opacity: 0.9, depthWrite: false }));
    dots.frustumCulled = false;
    gg.add(dots);
    this.flow.rnd = rnd;
    this.gridGroup = gg;
    this.group.add(gg);
  }
  spawnFlow(rnd) {
    const hole = this.hole, gf = hole.gf;
    for (let k = 0; k < 30; k++) {
      const u = (rnd() - 0.5) * 52, v = (rnd() - 0.5) * 52;
      const x = gf.x + gf.rx * u + gf.fx * v, z = gf.z + gf.rz * u + gf.fz * v;
      if (hole.greenSdf(x, z) < 0) return { x, z, life: rnd() * 3 };
    }
    return { x: gf.x, z: gf.z, life: 0 };
  }

  // ------------------------------------------------------------ per-frame
  update(dt, wind, focus) {
    this.clock += dt;
    this.fx.update(dt);
    this.foliage.update(dt, wind);
    // water ripple
    for (const m of this.waterMats || []) {
      if (m.normalMap) { m.normalMap.offset.x = this.clock * 0.01; m.normalMap.offset.y = this.clock * 0.006; }
    }
    // flag waving in the wind
    if (this.flagCloth) {
      const ws = Math.hypot(wind[0], wind[2]);
      const ang = Math.atan2(-wind[2], wind[0]);
      this.flagCloth.rotation.y = ang + Math.sin(this.clock * 1.3) * 0.08 * (1 - Math.min(ws / 10, 1));
      const a = this.flagCloth.geometry.attributes.position;
      const base = this.flagBase;
      const droop = 1 - Math.min(ws / 9, 1);
      for (let i = 0; i < a.count; i++) {
        const x = base[i * 3], y = base[i * 3 + 1];
        const wave = Math.sin(x * 9 - this.clock * (4 + ws)) * 0.05 * (x / 0.75) * (0.4 + Math.min(ws / 6, 1));
        a.setXYZ(i, x * (1 - droop * 0.55), y - droop * x * 0.9, wave);
      }
      a.needsUpdate = true;
      this.flagCloth.geometry.computeVertexNormals();
    }
    // green flow dots
    if (this.gridGroup && this.gridGroup.visible && this.flow) {
      const hole = this.hole;
      const a = this.flow.geo.attributes.position;
      this.flow.pts.forEach((p, i) => {
        const n = hole.normal(p.x, p.z);
        const sp = Math.hypot(n[0], n[2]);
        p.x += n[0] * 18 * dt; p.z += n[2] * 18 * dt;
        p.life -= dt;
        if (p.life < 0 || hole.greenSdf(p.x, p.z) > 0.5 || sp < 0.002) Object.assign(p, this.spawnFlow(this.flow.rnd), { life: 1.5 + this.flow.rnd() * 2 });
        a.setXYZ(i, p.x, hole.height(p.x, p.z) + 0.03, p.z);
      });
      a.needsUpdate = true;
    }
    // shadow camera follows the action
    if (focus) {
      const s = this.sunDir;
      this.sun.position.set(focus.x + s.x * 250, focus.y + s.y * 250, focus.z + s.z * 250);
      this.sun.target.position.copy(focus);
      this.sun.target.updateMatrixWorld();
    }
  }
}
