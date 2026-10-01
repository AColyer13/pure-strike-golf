// A simple articulated golfer with a keyframed full swing and putting stroke.
// Right-handed: stands on the left of the ball (looking down the target line),
// facing the ball, left shoulder toward the target.
import * as THREE from 'three';

const ease = (t) => t * t * (3 - 2 * t);

function limb(len, r0, r1, mat) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 10), mat);
  m.position.y = -len / 2;
  m.castShadow = true;
  g.add(m);
  return g;
}

// joint ball that hides the seam where two limb cylinders meet
function joint(r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
  m.castShadow = true;
  return m;
}

// hot-seat players each get their own outfit so it's obvious whose turn it is
export const OUTFITS = [
  { shirt: '#d8403a', pants: '#e9e4d4', cap: '#1d2a44', skin: '#d9a27c', hair: '#3b2a1e' },
  { shirt: '#2f6fd0', pants: '#2b2f3a', cap: '#f2f2f2', skin: '#a8714f', hair: '#1a1410' },
  { shirt: '#f2c230', pants: '#3d4a33', cap: '#2a2a2a', skin: '#e8bf9c', hair: '#b88a4a' },
  { shirt: '#f4f4f4', pants: '#6b7f99', cap: '#c22a52', skin: '#7a4b32', hair: '#111' },
];

export class Golfer {
  constructor(opts = OUTFITS[0]) {
    const shirt = new THREE.MeshStandardMaterial({ color: opts.shirt, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: opts.pants, roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ color: opts.skin, roughness: 0.7 });
    const hair = new THREE.MeshStandardMaterial({ color: opts.hair, roughness: 0.9 });
    const shoe = new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.5 });
    const sole = new THREE.MeshStandardMaterial({ color: '#2a2a2a', roughness: 0.9 });
    const belt = new THREE.MeshStandardMaterial({ color: '#1c1c1c', roughness: 0.5, metalness: 0.2 });
    const cap = new THREE.MeshStandardMaterial({ color: opts.cap, roughness: 0.7 });
    this.mats = { shirt, pants, skin, hair, cap };
    this.outfit = 0;
    const glove = new THREE.MeshStandardMaterial({ color: '#fafafa', roughness: 0.6 });
    this.shaftMat = new THREE.MeshStandardMaterial({ color: '#c8ccd2', metalness: 0.9, roughness: 0.25 });
    this.headMat = new THREE.MeshStandardMaterial({ color: '#50555e', metalness: 0.8, roughness: 0.3 });

    this.root = new THREE.Group();        // at the ball, rotated so -z is the target line
    this.body = new THREE.Group();        // golfer origin (between feet)
    this.root.add(this.body);

    // legs
    this.hips = new THREE.Group();
    this.hips.position.y = 0.92;
    this.body.add(this.hips);
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.22), pants);
    pelvis.castShadow = true;
    this.hips.add(pelvis);
    const beltM = new THREE.Mesh(new THREE.BoxGeometry(0.352, 0.04, 0.232), belt);
    beltM.position.y = 0.07;
    this.hips.add(beltM);
    this.legs = [];
    for (const s of [-1, 1]) {
      const thigh = limb(0.46, 0.085, 0.07, pants);
      thigh.position.set(0.1 * s, -0.04, 0);
      const shin = limb(0.44, 0.065, 0.05, pants);
      shin.position.y = -0.46;
      thigh.add(shin);
      const hipJ = joint(0.085, pants);
      thigh.add(hipJ);
      const knee = joint(0.066, pants);
      knee.position.y = -0.46;
      thigh.add(knee);
      // shoe: rounded toe on an upper, with a dark sole
      const foot = new THREE.Group();
      foot.position.set(0, -0.46, 0.05);
      shin.add(foot);
      const upperShoe = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 0.2), shoe);
      upperShoe.position.set(0, 0.005, -0.03);
      const toe = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.2, 1.3), shoe);
      toe.position.set(0, -0.025, 0.07);
      const soleM = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.018, 0.29), sole);
      soleM.position.set(0, -0.032, 0.005);
      for (const m of [upperShoe, toe, soleM]) { m.castShadow = true; foot.add(m); }
      this.body.add(thigh);
      thigh.position.y = 0.9;
      this.legs.push({ thigh, shin, s });
    }

    // torso (pivot at the base of the spine)
    this.spine = new THREE.Group();
    this.spine.position.y = 0.95;
    this.body.add(this.spine);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.15, 0.58, 12), shirt);
    torso.position.y = 0.29;
    torso.scale.z = 0.7;
    torso.castShadow = true;
    this.spine.add(torso);
    this.chest = new THREE.Group();
    this.chest.position.y = 0.52;
    this.spine.add(this.chest);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.018, 6, 14), shirt);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.035;
    this.chest.add(collar);
    const yoke = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.26, 4, 10).rotateZ(Math.PI / 2), shirt);
    yoke.scale.z = 0.85;
    yoke.castShadow = true;
    this.chest.add(yoke);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8), skin);
    neck.position.y = 0.07;
    this.chest.add(neck);
    this.head = new THREE.Group();
    this.head.position.y = 0.2;
    this.chest.add(this.head);
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.105, 16, 12), skin);
    headM.castShadow = true;
    this.head.add(headM);
    const hairM = new THREE.Mesh(new THREE.SphereGeometry(0.108, 14, 8, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.3, Math.PI * 0.35), hair);
    hairM.rotation.y = Math.PI; // back and sides of the head, below the cap
    this.head.add(hairM);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6).scale(0.5, 1, 0.8), skin);
      ear.position.set(0.102 * s, -0.01, 0);
      this.head.add(ear);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.04, 6).rotateX(Math.PI / 2), skin);
    nose.position.set(0, -0.015, 0.105);
    this.head.add(nose);
    const capM = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), cap);
    capM.position.y = 0.02;
    this.head.add(capM);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.012, 16, 1, false, -Math.PI / 2, Math.PI), cap);
    brim.position.set(0, 0.03, 0.08);
    brim.scale.z = 0.9;
    this.head.add(brim);

    // arms: each arm pivots at the shoulder; the hands meet at the grip
    this.arms = [];
    for (const s of [-1, 1]) {
      const sh = new THREE.Group();
      sh.position.set(0.2 * s, 0, 0);
      this.chest.add(sh);
      const upper = limb(0.3, 0.055, 0.045, shirt);
      sh.add(upper);
      const fore = limb(0.28, 0.042, 0.035, skin);
      fore.position.y = -0.3;
      upper.add(fore);
      sh.add(joint(0.06, shirt));
      const elbow = joint(0.044, skin);
      elbow.position.y = -0.3;
      upper.add(elbow);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), s < 0 ? glove : skin);
      hand.position.y = -0.3;
      fore.add(hand);
      this.arms.push({ sh, upper, fore, s });
    }
    // club: attached to a "hands" pivot driven directly (arms aim at it)
    this.hands = new THREE.Group();
    this.chest.add(this.hands);
    this.club = new THREE.Group();
    this.hands.add(this.club);
    this.setClub({ loft: 30 });

    this.pose = 0;
    this.phase = 'idle';
    this.t = 0;
    this.onImpact = null;
    this.putting = false;
  }

  setOutfit(i) {
    const o = OUTFITS[i % OUTFITS.length];
    if (this.outfit === i) return;
    this.outfit = i;
    for (const k of Object.keys(this.mats)) this.mats[k].color.set(o[k]);
  }

  setClub(club) {
    while (this.club.children.length) this.club.remove(this.club.children[0]);
    const putter = !!club.putter;
    const wood = club.loft && club.loft <= 20 && !putter;
    const len = putter ? 0.86 : wood ? 1.1 : 0.95 - (club.loft - 20) * 0.003;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.011, len, 6), this.shaftMat);
    shaft.position.y = -len / 2;
    shaft.castShadow = true;
    this.club.add(shaft);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.013, 0.26, 8), new THREE.MeshStandardMaterial({ color: '#222' }));
    grip.position.y = -0.1;
    this.club.add(grip);
    let head;
    if (putter) head = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.03, 0.03), this.headMat);
    else if (wood) head = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10).scale(1.1, 0.6, 1), new THREE.MeshStandardMaterial({ color: '#1e1f22', metalness: 0.6, roughness: 0.3 }));
    else head = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.012), this.headMat);
    head.position.set(putter ? 0.04 : 0.03, -len, 0);
    head.castShadow = true;
    this.club.add(head);
    this.clubHead = head;
    this.clubLen = len;
    this.putting = putter;
  }

  // Place at the ball, facing the target direction (unit x,z)
  place(ball, dir, y) {
    this.root.position.set(ball.x, y, ball.z);
    this.root.rotation.y = Math.atan2(-dir.x, -dir.z); // local -z -> dir
    // body stands to the left of the ball, facing +x (local) toward the ball
    const stance = this.putting ? 0.62 : 0.55 + this.clubLen * 0.35;
    this.body.position.set(-stance, 0, 0);
    this.body.rotation.y = Math.PI / 2; // body's +z (face) points to local +x (the ball)
    this.apply(0);
    // shuffle the feet so the clubhead soles right behind the ball
    this.root.updateMatrixWorld(true);
    const hp = this.clubHead.getWorldPosition(new THREE.Vector3());
    this.root.worldToLocal(hp);
    this.body.position.x -= hp.x;
    this.body.position.z -= hp.z - 0.03;
    this.headDrop = hp.y; // < 0: clubhead below the ground at address
  }

  // Swing timeline: 'back' (0..1 of backswing at given power) -> 'down' -> 'through'
  startSwing(power, onImpact) {
    this.phase = 'back';
    this.t = 0;
    this.power = Math.max(0.25, Math.min(1.1, power));
    this.onImpact = onImpact;
  }
  // Pose parameter: 0 = address, -1 = top of backswing, +1 = finish.
  apply(p) {
    const put = this.putting;
    const bw = Math.max(0, -p), fw = Math.max(0, p);
    const amp = put ? 0.18 : 1;
    // spine tilt (bend over the ball) and rotation
    const bend = put ? 0.62 : 0.5;
    this.spine.rotation.set(bend * (1 - fw * 0.9), 0, 0);
    const turn = put ? 0 : (-bw * 1.45 + fw * 1.6);
    this.spine.rotation.y = turn * 0.95;
    this.chest.rotation.y = turn * 0.25;
    this.chest.rotation.z = put ? 0 : (-bw * 0.12 + fw * 0.15);
    this.hips.rotation.y = put ? 0 : (-bw * 0.6 + fw * 1.4);
    this.head.rotation.x = -0.35 * (1 - fw) + 0.1;
    this.head.rotation.y = -turn * 0.7 * (1 - fw * 0.5);
    for (const L of this.legs) {
      L.thigh.rotation.x = -0.25;
      L.shin.rotation.x = 0.35;
      if (!put && L.s > 0) { L.thigh.rotation.y = fw * 0.5; L.shin.rotation.x = 0.35 + fw * 0.35; }
    }
    // hands: arc in the chest's local frame; angle 0 = down at the ball
    const swingA = put ? (bw ? -bw * amp : fw * amp) : (bw ? -bw * 2.6 : fw * 3.4);
    const armLen = 0.58;
    const hx = Math.sin(swingA) * armLen * 0.95;
    const hy = -Math.cos(swingA) * armLen - 0.02;
    const hz = 0.1 + (put ? 0.04 : 0) - Math.abs(Math.sin(swingA)) * 0.08;
    // the arms hang from the shoulders under gravity, so undo the spine's forward bend
    const b = this.spine.rotation.x;
    const cb = Math.cos(b), sb = Math.sin(b);
    this.hands.position.set(hx, hy * cb + hz * sb, -hy * sb + hz * cb);
    // wrist hinge: club cocks up on the backswing and releases through
    const hinge = put ? 0 : (bw * 1.35 * Math.min(1, bw * 1.6) - fw * 0.6 * Math.min(1, fw * 2));
    this.hands.rotation.set(0, 0, 0);
    this.hands.rotation.z = swingA - hinge;
    const shaftLean = put ? 0.3 : 0.62 + (this.clubLen - 0.95) * 0.9; // shaft angle from vertical at address
    this.hands.rotation.x = -(shaftLean + b) * (1 - Math.abs(Math.sin(swingA)) * 0.45);
    // arms point at the hands
    const tmp = new THREE.Vector3();
    for (const A of this.arms) {
      tmp.copy(this.hands.position).sub(A.sh.position);
      const dist = tmp.length();
      A.sh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), tmp.clone().normalize());
      const bendElbow = Math.acos(Math.min(1, dist / 0.6)) * 2;
      A.upper.rotation.set(0, 0, 0);
      A.upper.rotation.x = -bendElbow * 0.5;
      A.fore.rotation.x = bendElbow;
    }
  }

  update(dt) {
    if (this.phase === 'idle') { this.apply(Math.sin(performance.now() / 700) * 0.004); return; }
    const put = this.putting;
    const backDur = put ? 0.55 + this.power * 0.25 : 0.95;
    const downDur = put ? 0.35 : 0.28;
    const thruDur = put ? 0.6 : 0.9;
    this.t += dt;
    if (this.phase === 'back') {
      const k = Math.min(1, this.t / backDur);
      this.apply(-ease(k) * this.power);
      if (k >= 1) { this.phase = 'down'; this.t = 0; }
    } else if (this.phase === 'down') {
      const k = Math.min(1, this.t / downDur);
      this.apply(-this.power * (1 - k * k));
      if (k >= 1) {
        this.phase = 'through'; this.t = 0;
        const cb = this.onImpact; this.onImpact = null;
        if (cb) cb();
      }
    } else if (this.phase === 'through') {
      const k = Math.min(1, this.t / thruDur);
      const fin = put ? this.power * 0.9 : Math.min(1, 0.55 + this.power * 0.5);
      this.apply(fin * (1 - (1 - k) ** 3));
      if (k >= 1) this.phase = 'hold';
    }
  }
}
