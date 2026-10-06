// Post-processing with a quality tier. Low renders straight to the canvas as
// before; medium adds bloom (sun on water, the white ball); high adds ground-
// truth ambient occlusion at half resolution. Tone mapping and the sRGB output
// transform move into the OutputPass, so the look is identical between tiers
// apart from the effects themselves. "auto" guesses a tier from the device and
// then watches the first real frames: if the median frame takes too long, it
// steps down a tier and tries again.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const TIERS = ['low', 'medium', 'high'];
export const QUALITY = {
  auto: { name: 'Auto', desc: 'Picks a tier for this device and steps down if frames run long.' },
  low: { name: 'Low', desc: 'No post-processing. Fastest; the look before the effects pass.' },
  medium: { name: 'Medium', desc: 'Bloom on the sun, water glints and the ball.' },
  high: { name: 'High', desc: 'Bloom plus ambient occlusion: contact shadows under the golfer, trees and bunker lips.' },
};
export const SLOW_FRAME_MS = 20; // median above this during the probe drops a tier
const PROBE_WARMUP_MS = 1200; // shader compiles and first-hole builds skew the opening frames
const PROBE_FRAMES = 90;

// first guess for "auto": phones and tablets get low, everything else high
export function guessTier() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (coarse) return 'low';
  return 'high';
}

export class PostPipeline {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.tier = 'low';
    this.quality = 'low';
    this.composer = null;
    this.probe = null;
    this.onTier = null; // callback(tier) when auto changes its mind
  }

  // quality: 'auto' | 'low' | 'medium' | 'high'
  setQuality(q) {
    this.quality = QUALITY[q] ? q : 'auto';
    if (this.quality === 'auto') { this.setTier(guessTier()); this.probe = { t: 0, samples: [] }; }
    else { this.probe = null; this.setTier(this.quality); }
  }

  setTier(tier) {
    if (!TIERS.includes(tier)) tier = 'low';
    if (tier === this.tier && (this.composer || tier === 'low')) return;
    this.dispose();
    this.tier = tier;
    if (tier === 'low') return;
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    // one multisampled HDR target so edges stay antialiased through the chain
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(r, target);
    composer.setPixelRatio(r.getPixelRatio());
    composer.addPass(new RenderPass(this.scene, this.camera));
    if (tier === 'high') {
      const gtao = new GTAOPass(this.scene, this.camera, size.x >> 1, size.y >> 1);
      // radius in metres: contact shading at the feet, trunks and bunker lips, nothing at range
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 8 });
      gtao.blendIntensity = 0.85;
      // half resolution: the composer sizes every pass to the full drawing buffer
      const full = gtao.setSize.bind(gtao);
      gtao.setSize = (w, h) => full(Math.max(1, w >> 1), Math.max(1, h >> 1));
      // the normal/depth pre-pass uses one override material, so alpha-tested
      // foliage cards would land in the AO as solid quads: leave them out
      const hidePointsAndLines = gtao.overrideVisibility.bind(gtao);
      gtao.overrideVisibility = () => { hidePointsAndLines(); this.scene.traverse((o) => { if (o.userData.noAO) o.visible = false; }); };
      composer.addPass(gtao);
      this.gtao = gtao;
    }
    // threshold 4 in linear HDR: only the sun disc and its glints on water bloom, never the sky or the grass
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.5, 4);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    const css = r.getSize(new THREE.Vector2());
    composer.setSize(css.x, css.y);
    this.composer = composer;
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize(w, h) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  // raw frame interval from requestAnimationFrame, in ms; only used while auto is probing
  sample(ms) {
    const p = this.probe;
    if (!p || !(ms > 0)) return;
    p.t += ms;
    if (p.t < PROBE_WARMUP_MS) return;
    p.samples.push(ms);
    if (p.samples.length < PROBE_FRAMES) return;
    const sorted = p.samples.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.lastMedianMs = median;
    const i = TIERS.indexOf(this.tier);
    if (median > SLOW_FRAME_MS && i > 0) {
      this.setTier(TIERS[i - 1]);
      this.probe = { t: 0, samples: [] };
      this.onTier?.(this.tier);
    } else this.probe = null;
  }

  dispose() {
    if (!this.composer) return;
    for (const p of this.composer.passes) p.dispose?.();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer = null;
    this.gtao = null; this.bloom = null;
  }
}
