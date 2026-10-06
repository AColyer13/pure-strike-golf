// Impact effects: one pooled point sprite system for turf, sand, water and dust
// bursts, and a pool of decal planes for divots, pitch marks and splash rings.
// Everything lives in a single group added to the scene (not the per-hole
// group), so it survives hole rebuilds; clear() wipes it when a hole loads.
import * as THREE from 'three';

export const MAX_PARTICLES = 512;
export const MAX_DECALS = 32;
const GRAVITY = -9.8;
const DRAG = 0.9; // per-second velocity retention for airborne chunks

// shared soft round sprite, drawn once
function spriteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 15);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// decal textures are drawn to small canvases: an irregular dark divot scar, a
// crescent pitch mark and a soft ring for the splash
function divotTexture(seed = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 32);
  g.fillStyle = 'rgba(0,0,0,0.9)';
  g.beginPath();
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 26 * (0.72 + 0.28 * Math.abs(Math.sin(a * 3 + seed))) * (1 + 0.1 * Math.sin(a * 7 + seed * 2));
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.55;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
  g.fill();
  // lighter lip at the far (target) side where the turf tore
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath(); g.ellipse(6, 0, 16, 8, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function pitchTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  g.translate(16, 16);
  g.fillStyle = 'rgba(0,0,0,0.85)';
  g.beginPath(); g.ellipse(0, 0, 9, 6, 0, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath(); g.ellipse(3, -2, 6, 3.5, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function ringTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 10, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0)');
  grad.addColorStop(0.8, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'fx';
    this.hole = null;
    this.rnd = Math.random;
    this.initParticles();
    this.initDecals();
  }

  // ------------------------------------------------------------ particles
  initParticles() {
    const n = MAX_PARTICLES;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n); // seconds remaining, 0 = free
    this.maxLife = new Float32Array(n);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.grav = new Float32Array(n); // gravity scale: chunks 1, dust and mist ~0.1
    this.bounce = new Uint8Array(n); // 1 = settles on the ground instead of passing through
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setDrawRange(0, 0);
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: spriteTexture() }, uScale: { value: 860 } },
      vertexShader: `
        attribute float aSize; attribute float aAlpha;
        varying vec3 vColor; varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = color; vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, gl_PointCoord);
          gl_FragColor = vec4(vColor, t.a * vAlpha);
          if (gl_FragColor.a < 0.02) discard;
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    this.group.add(this.points);
    this.active = 0; // highest live index + 1, for the draw range
    this.cursor = 0;
  }

  // sprite size in world metres: pixel size = size * (bufferHeight / (2 tan(fov/2))) / depth
  setViewport(hPx, fovDeg = 50) { if (hPx > 0) this.points.material.uniforms.uScale.value = hPx / (2 * Math.tan((fovDeg * Math.PI) / 360)); }

  spawn(p, v, life, color, size, grav = 1, bounce = 0) {
    const n = MAX_PARTICLES;
    let i = this.cursor;
    for (let k = 0; k < n; k++) { if (this.life[i] <= 0) break; i = (i + 1) % n; }
    this.cursor = (i + 1) % n;
    this.pos.set(p, i * 3);
    this.vel.set(v, i * 3);
    this.life[i] = this.maxLife[i] = life;
    this.col[i * 3] = color.r; this.col[i * 3 + 1] = color.g; this.col[i * 3 + 2] = color.b;
    this.size[i] = size;
    this.alpha[i] = 1;
    this.grav[i] = grav;
    this.bounce[i] = bounce;
    if (i + 1 > this.active) this.active = i + 1;
  }

  // a cone of particles: dir is the mean direction (normalised), spread in radians
  burst(p, dir, { count, speed, spread, life, color, jitter = 0.3, size = 0.08, grav = 1, bounce = 0, tint = 0.15, up = 0 }) {
    const c = new THREE.Color(color);
    const t = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(t);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0); else side.normalize();
    const up3 = new THREE.Vector3().crossVectors(t, side).normalize();
    const col = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const a = this.rnd() * Math.PI * 2;
      const r = Math.tan(spread * Math.sqrt(this.rnd()));
      const d = t.clone().addScaledVector(side, Math.cos(a) * r).addScaledVector(up3, Math.sin(a) * r).normalize();
      d.y += up;
      const s = speed * (1 - jitter + this.rnd() * jitter * 2);
      const shade = 1 - tint + this.rnd() * tint * 2;
      col.copy(c).multiplyScalar(shade);
      this.spawn(
        [p[0] + (this.rnd() - 0.5) * 0.05, p[1] + 0.02, p[2] + (this.rnd() - 0.5) * 0.05],
        [d.x * s, d.y * s, d.z * s],
        life * (0.7 + this.rnd() * 0.6), col, size * (0.6 + this.rnd() * 0.8), grav, bounce,
      );
    }
  }

  // ------------------------------------------------------------ decals
  initDecals() {
    this.tex = { divot: [divotTexture(1), divotTexture(2.3), divotTexture(4.1)], pitch: pitchTexture(), ring: ringTexture() };
    this.decals = [];
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_DECALS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: this.tex.divot[0], transparent: true, depthWrite: false, opacity: 1,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.renderOrder = 1;
      m.userData.fade = 0; // seconds of fade-in left, 0 when settled; ring decals fade out instead
      this.group.add(m);
      this.decals.push(m);
    }
    this.decalCursor = 0;
  }

  // place a decal on the terrain under p (or at p's own height when onGround is false),
  // lying on the local normal and turned to yaw (radians about Y)
  decal(kind, p, { yaw = 0, size = 0.3, color = 0x000000, opacity = 0.8, life = 0, lift = 0.01, onGround = true } = {}) {
    const m = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % MAX_DECALS;
    const h = this.hole;
    const y = onGround ? this.heightAt(p[0], p[2]) : p[1];
    const n = h ? h.normal(p[0], p[2]) : [0, 1, 0];
    m.position.set(p[0], y + lift, p[2]);
    const normal = new THREE.Vector3(n[0], n[1], n[2]);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    m.rotateY(yaw);
    m.scale.set(size, 1, size);
    const mat = m.material;
    mat.map = kind === 'divot' ? this.tex.divot[Math.floor(this.rnd() * 3)] : kind === 'pitch' ? this.tex.pitch : this.tex.ring;
    mat.color.set(color);
    mat.opacity = opacity;
    mat.needsUpdate = true;
    m.visible = true;
    m.userData.life = life; // > 0: fades out over this many seconds
    m.userData.maxLife = life;
    m.userData.baseOpacity = opacity;
    m.userData.baseSize = size;
    return m;
  }

  // ------------------------------------------------------------ gameplay hooks
  // Full swing from grass: the divot scar plus a fan of turf chunks flying forward and up.
  divot(p, fwd, { strength = 1, surface = 'fairway', dirt = '#6e5a3c', grass = '#3f8a2c' } = {}) {
    const yaw = Math.atan2(fwd[0], fwd[2]);
    const deep = surface === 'rough' || surface === 'deep';
    const len = 0.22 + 0.2 * strength;
    this.decal('divot', [p[0] + fwd[0] * len * 0.35, p[1], p[2] + fwd[2] * len * 0.35], { yaw: yaw + Math.PI / 2, size: len, color: dirt, opacity: deep ? 0.55 : 0.85 });
    const dir = [fwd[0] * 0.6, 0.75, fwd[2] * 0.6];
    const n = Math.round(14 + 22 * strength);
    this.burst(p, dir, { count: n, speed: 3 + 4 * strength, spread: 0.35, life: 0.9, color: dirt, size: 0.05, bounce: 1, tint: 0.2 });
    this.burst(p, dir, { count: Math.round(n * (deep ? 1.4 : 0.8)), speed: 2.5 + 3.5 * strength, spread: 0.45, life: 1.1, color: grass, size: 0.045, bounce: 1, tint: 0.25 });
  }

  // Bunker: a wide plume of sand that hangs for a moment, plus a shallow scoop mark.
  sand(p, fwd, { strength = 1, color = '#f6f4ee' } = {}) {
    const yaw = Math.atan2(fwd[0], fwd[2]);
    this.decal('divot', [p[0] + fwd[0] * 0.2, p[1], p[2] + fwd[2] * 0.2], { yaw: yaw + Math.PI / 2, size: 0.45, color: 0x8a7d62, opacity: 0.35 });
    const dir = [fwd[0] * 0.5, 0.85, fwd[2] * 0.5];
    const n = Math.round(60 + 80 * strength);
    // the grains in shadow read darker than the bunker; the hanging mist stays bright
    const dark = new THREE.Color(color).multiplyScalar(0.72);
    this.burst(p, dir, { count: n, speed: 2.2 + 3 * strength, spread: 0.6, life: 1.4, color: dark, size: 0.09, grav: 0.55, bounce: 1, tint: 0.15 });
    this.burst(p, dir, { count: Math.round(n * 0.5), speed: 1.2 + 1.5 * strength, spread: 0.9, life: 1.8, color, size: 0.16, grav: 0.12, tint: 0.05 });
  }

  // Ball landing on a green: a crescent pitch mark that stays for the hole.
  pitchMark(p, speed = 20) {
    const s = Math.min(1, speed / 35);
    // oversized against a real 3 cm mark so it still reads from the next address camera
    this.decal('pitch', p, { yaw: this.rnd() * Math.PI * 2, size: 0.14 + 0.1 * s, color: 0x26351a, opacity: 0.55 + 0.35 * s, lift: 0.006 });
  }

  // Water: an expanding ring on the surface plus a column of droplets.
  splash(p, { particles = true } = {}) {
    const surf = [p[0], p[1], p[2]];
    this.decal('ring', surf, { size: 0.5, color: 0xeaf6ff, opacity: 0.9, life: 1.6, lift: 0.03, onGround: false });
    if (!particles) return;
    this.burst(surf, [0, 1, 0], { count: 70, speed: 4.5, spread: 0.3, life: 1.0, color: 0xdff2ff, size: 0.07, grav: 1, tint: 0.1 });
    this.burst(surf, [0, 1, 0], { count: 40, speed: 1.6, spread: 1.1, life: 1.3, color: 0xffffff, size: 0.18, grav: 0.1, tint: 0.05 });
  }

  // Cart path: a puff of pale dust that drifts off.
  dust(p, speed = 10) {
    const s = Math.min(1, speed / 30);
    this.burst(p, [0, 1, 0], { count: Math.round(12 + 18 * s), speed: 0.8 + 1.2 * s, spread: 1.0, life: 1.2, color: 0xc9c2b4, size: 0.2, grav: 0.05, tint: 0.1 });
  }

  // ------------------------------------------------------------ per frame
  update(dt) {
    if (dt <= 0) return;
    const h = this.hole;
    const keep = Math.pow(DRAG, dt);
    let active = 0;
    for (let i = 0; i < this.active; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      const i3 = i * 3;
      this.vel[i3 + 1] += GRAVITY * this.grav[i] * dt;
      this.vel[i3] *= keep; this.vel[i3 + 1] *= keep; this.vel[i3 + 2] *= keep;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.bounce[i] && h) {
        const g = this.heightAt(this.pos[i3], this.pos[i3 + 2]) + 0.01;
        if (this.pos[i3 + 1] < g) {
          this.pos[i3 + 1] = g;
          this.vel[i3 + 1] = 0; this.vel[i3] *= 0.3; this.vel[i3 + 2] *= 0.3;
          this.life[i] = Math.min(this.life[i], 0.35);
        }
      }
      const f = this.life[i] / this.maxLife[i];
      this.alpha[i] = f < 0.3 ? f / 0.3 : 1;
      active = i + 1;
    }
    this.active = active;
    this.geo.setDrawRange(0, active);
    if (active) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
    }
    for (const m of this.decals) {
      if (!m.visible || !(m.userData.life > 0)) continue;
      m.userData.life -= dt;
      const u = m.userData;
      if (u.life <= 0) { m.visible = false; continue; }
      const t = 1 - u.life / u.maxLife;
      const s = u.baseSize * (1 + t * 5);
      m.scale.set(s, 1, s);
      m.material.opacity = u.baseOpacity * (1 - t) * (1 - t);
    }
  }

  // rendered ground height: the mesh sampler when the world provides one, else the analytic height
  heightAt(x, z) { return this.heightFn ? this.heightFn(x, z) : this.hole ? this.hole.height(x, z) : 0; }

  // new hole: drop everything
  clear(hole, heightFn = null) {
    this.hole = hole || null;
    this.heightFn = heightFn;
    this.life.fill(0);
    this.alpha.fill(0);
    this.active = 0;
    this.geo.setDrawRange(0, 0);
    this.geo.attributes.aAlpha.needsUpdate = true;
    for (const m of this.decals) m.visible = false;
  }

  dispose() {
    this.geo.dispose();
    this.points.material.uniforms.map.value.dispose();
    this.points.material.dispose();
    this.decals[0].geometry.dispose();
    for (const m of this.decals) m.material.dispose();
    for (const t of this.tex.divot) t.dispose();
    this.tex.pitch.dispose(); this.tex.ring.dispose();
  }
}
