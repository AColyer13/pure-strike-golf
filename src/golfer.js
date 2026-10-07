// A simple articulated golfer with a keyframed full swing and putting stroke.
// Right-handed: stands on the left of the ball (looking down the target line),
// facing the ball, left shoulder toward the target.
import * as THREE from 'three';

const ease = (t) => t * t * (3 - 2 * t);
const smooth = (a, b, x) => ease(Math.min(1, Math.max(0, (x - a) / (b - a))));

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
  { shirt: '#d8403a', trim: '#f6f1e6', pants: '#e9e4d4', cap: '#1d2a44', skin: '#d9a27c', hair: '#3b2a1e' },
  { shirt: '#2f6fd0', trim: '#f2f2f2', pants: '#2b2f3a', cap: '#f2f2f2', skin: '#a8714f', hair: '#1a1410' },
  { shirt: '#f2c230', trim: '#2a2a2a', pants: '#3d4a33', cap: '#2a2a2a', skin: '#e8bf9c', hair: '#b88a4a' },
  { shirt: '#f4f4f4', trim: '#c22a52', pants: '#6b7f99', cap: '#c22a52', skin: '#7a4b32', hair: '#111' },
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
    const trim = new THREE.MeshStandardMaterial({ color: opts.trim, roughness: 0.8 });
    const eyeWhite = new THREE.MeshStandardMaterial({ color: '#f4f0ea', roughness: 0.4 });
    const pupil = new THREE.MeshStandardMaterial({ color: '#1a1512', roughness: 0.3 });
    const seam = new THREE.MeshStandardMaterial({ color: '#8d8d8d', roughness: 0.7 });
    this.mats = { shirt, pants, skin, hair, cap, trim };
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
      this.legs.push({ thigh, shin, foot, s });
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
    const placket = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.15, 0.014), trim);
    placket.position.set(0, 0.42, 0.122);
    this.spine.add(placket);
    for (const k of [0, 1]) {
      const button = new THREE.Mesh(new THREE.SphereGeometry(0.007, 6, 4), pupil);
      button.position.set(0, 0.47 - k * 0.05, 0.13);
      this.spine.add(button);
    }
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.018, 6, 14), trim);
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
    // eyes under the brim, brows just below it
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.015, 10, 8).scale(1, 0.85, 0.6), eyeWhite);
      eye.position.set(0.04 * s, -0.006, 0.094);
      this.head.add(eye);
      const pu = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), pupil);
      pu.position.set(0.04 * s, -0.006, 0.105);
      this.head.add(pu);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.007, 0.008), hair);
      brow.position.set(0.041 * s, 0.021, 0.095);
      brow.rotation.z = -0.18 * s;
      this.head.add(brow);
    }
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
      // short sleeve in the trim colour over a bare upper arm: the shirt reads as two-tone
      const upper = limb(0.3, 0.05, 0.042, skin);
      sh.add(upper);
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.06, 0.14, 10), trim);
      sleeve.position.y = -0.07;
      sleeve.castShadow = true;
      upper.add(sleeve);
      const fore = limb(0.28, 0.042, 0.035, skin);
      fore.position.y = -0.3;
      upper.add(fore);
      sh.add(joint(0.062, trim));
      const elbow = joint(0.044, skin);
      elbow.position.y = -0.3;
      upper.add(elbow);
      // a right-hander gloves the lead (left) hand, which is the one nearer the target
      const lead = s > 0;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), lead ? glove : skin);
      hand.position.y = -0.3;
      fore.add(hand);
      if (lead) {
        const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.005, 6, 14), seam);
        cuff.rotation.x = Math.PI / 2;
        cuff.position.y = -0.272;
        fore.add(cuff);
        const tab = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.01), seam);
        tab.position.set(0, -0.285, -0.042);
        fore.add(tab);
      }
      this.arms.push({ sh, upper, fore, s });
    }
    // club: the "hands" pivot sits at the butt of the grip, in the body frame; the arms
    // reach for it with two-bone IK each frame
    this.hands = new THREE.Group();
    this.body.add(this.hands);
    this.club = new THREE.Group();
    this.hands.add(this.club);
    this.groundY = 0;  // ground under the ball, relative to the feet (body frame)
    this.bendAdj = 0;  // extra bend over a ball below the feet
    this.bendX = 0;    // extra bend so the hands reach a short club
    this.tiltX = 0;    // extra shoulder tilt so the trail hand reaches
    this.setClub({ loft: 30 });

    this.pose = 0;
    this.phase = 'idle';
    this.t = 0;
    this.idleT = 0;
    this.onImpact = null;
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
    // club local frame: +y runs up the shaft to the butt (the origin) and the head is at
    // -len, in its own group whose sole lies flat at the group's y = 0
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.011, len, 6), this.shaftMat);
    shaft.position.y = -len / 2;
    shaft.castShadow = true;
    this.club.add(shaft);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.013, 0.26, 8), new THREE.MeshStandardMaterial({ color: '#222' }));
    grip.position.y = -0.13;
    this.club.add(grip);
    const headG = new THREE.Group();
    headG.position.y = -len;
    this.club.add(headG);
    let head, sweet, depth;
    if (putter) {
      head = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.026, 0.03), this.headMat);
      head.position.set(0.045, 0.013, 0); sweet = 0.045; depth = 0.03;
    } else if (wood) {
      head = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10).scale(1.1, 0.6, 1), new THREE.MeshStandardMaterial({ color: '#1e1f22', metalness: 0.6, roughness: 0.3 }));
      head.position.set(0.05, 0.033, 0.01); sweet = 0.05; depth = 0.1;
    } else {
      head = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.012), this.headMat);
      head.position.set(0.035, 0.025, 0); sweet = 0.035; depth = 0.012;
    }
    head.castShadow = true;
    headG.add(head);
    this.clubHead = head;
    this.headG = headG;
    this.sweet = new THREE.Vector3(sweet, 0, 0); // middle of the sole, in the head group
    this.headDepth = depth;
    this.clubLen = len;
    this.putting = putter;
    // address geometry: lie (shaft angle from the ground, degrees), spine bend, how far
    // the hands sit ahead of the head
    this.lie = putter ? 71 : wood ? 50 : 58 + Math.min(40, Math.max(0, club.loft - 20)) * 0.12;
    this.bend = putter ? 0.8 : wood ? 0.62 : 0.72;
    this.handsAhead = putter ? 0.02 : wood ? 0.0 : 0.06;
    this.calibrate();
  }

  // Place at the ball, facing the target direction (unit x,z). `y` is the ground under
  // the ball; heightAt(x, z), when given, stands the feet on the slope too.
  place(ball, dir, y, heightAt = null) {
    this.root.position.set(ball.x, y, ball.z);
    this.root.rotation.y = Math.atan2(-dir.x, -dir.z); // local -z -> dir
    // body stands to the left of the ball, facing +x (local) toward the ball
    const stance = this.putting ? 0.62 : 0.55 + this.clubLen * 0.35;
    this.body.position.set(-stance, 0, 0);
    this.body.rotation.y = Math.PI / 2; // body's +z (face) points to local +x (the ball)
    const tmp = new THREE.Vector3();
    const phase = this.phase;
    this.phase = 'idle'; // the address pose, whatever the last swing left behind
    for (let it = 0; it < 3; it++) {
      // feet on their own ground; the address re-solves so the sole still rests at the ball
      let dy = 0;
      if (heightAt) {
        this.root.updateMatrixWorld(true);
        const f = this.body.getWorldPosition(tmp);
        dy = Math.max(-0.18, Math.min(0.18, heightAt(f.x, f.z) - y));
      }
      this.body.position.y = dy;
      this.groundY = -dy;
      this.bendAdj = Math.max(-0.12, Math.min(0.22, dy * 1.4));
      this.calibrate();
      this.apply(0);
      // shuffle so the middle of the sole rests just behind the ball
      this.root.updateMatrixWorld(true);
      const hp = this.headG.localToWorld(this.sweet.clone());
      this.root.worldToLocal(hp);
      this.body.position.x -= hp.x;
      this.body.position.z -= hp.z - (0.0214 + this.headDepth / 2 + 0.004);
    }
    this.phase = phase;
    this.root.updateMatrixWorld(true);
  }

  // Swing timeline: 'back' (0..1 of backswing at given power) -> 'down' -> 'through'
  startSwing(power, onImpact) {
    this.phase = 'back';
    this.t = 0;
    this.power = Math.max(0.25, Math.min(1.1, power));
    this.onImpact = onImpact;
  }
  // Slide the pelvis and torso sideways (body +x is the target side) while the
  // feet stay planted: the legs lean to follow and the shoes stay flat.
  setShift(dx) {
    this.hips.position.x = dx;
    this.spine.position.x = dx;
    const lean = -Math.asin(Math.max(-0.4, Math.min(0.4, dx / 0.9)));
    for (const L of this.legs) {
      L.thigh.position.x = 0.1 * L.s + dx;
      L.thigh.rotation.z = lean;
      L.foot.rotation.z = -lean;
    }
  }

  // Torso, legs and head for pose p (0 address, -1 top, +1 finish). `f` is how far
  // through the downswing we are (null outside it): the hips lead the way down.
  poseBody(p, f = null) {
    const put = this.putting;
    const bw = Math.max(0, -p), fw = Math.max(0, p);
    const swinging = f !== null || this.phase === 'through' || this.phase === 'hold';
    let shift = -bw * 0.03 + fw * 0.1;
    if (f !== null) shift = -bw * 0.03 + 0.07 * smooth(0, 0.7, f);
    else if (swinging) shift = 0.07 + fw * 0.03;
    this.setShift(put ? 0 : shift);
    // spine bent over the ball; posture only rises once the arms are well past it
    const bend = this.bend + this.bendAdj + this.bendX;
    const upright = put ? 0 : smooth(0.15, 0.95, fw);
    this.spine.rotation.set(bend * (1 - upright * 0.8), 0, 0);
    // shoulders turn ~90° going back and face the target at the finish
    const turn = put ? 0 : (-bw * 1.5 + fw * 1.65);
    this.spine.rotation.y = turn * 0.95;
    // the trail shoulder sits lower at address (the trail hand is lower on the grip): the
    // shoulder line tilts about the line from the chest to the ball
    const tilt = this.tiltX + (put ? 0.04 : 0.12 - bw * 0.1 + fw * 0.05);
    const qs = this.spine.quaternion;
    _q.setFromAxisAngle(_z, tilt);
    this.chest.quaternion.copy(qs).invert().multiply(_q).multiply(qs).multiply(_q2.setFromAxisAngle(_y, turn * 0.05));
    // hips: a half turn going back; in the downswing they unwind first and are open at impact
    let hip = -bw * 0.75 + fw * 1.5;
    if (f !== null) hip = -bw * 0.75 * (1 - smooth(0, 0.5, f)) + 0.45 * smooth(0.15, 1, f);
    else if (swinging) hip = 0.45 + fw * 1.05;
    this.hips.rotation.y = put ? 0 : hip;
    // head: stays down on the ball through impact and comes up late
    const lift = put ? 0 : smooth(0.4, 0.9, fw);
    this.head.rotation.x = -0.35 * (1 - lift) + 0.1 * lift;
    this.head.rotation.y = -turn * 0.75 * (1 - lift * 0.5);
    this.head.rotation.z = put ? 0 : (bw * 0.08 + fw * 0.12 * (1 - lift));
    for (const L of this.legs) {
      const lead = L.s > 0;
      L.thigh.rotation.x = -0.28;
      L.thigh.rotation.y = 0;
      L.shin.rotation.x = 0.4;
      L.foot.rotation.x = 0;
      if (put) continue;
      if (lead) {
        // the lead knee flexes in going back, then posts up straight at the finish
        L.thigh.rotation.y = -bw * 0.25;
        L.thigh.rotation.x = -0.28 + fw * 0.24;
        L.shin.rotation.x = 0.4 + bw * 0.1 - fw * 0.35;
      } else {
        // trail knee kicks in toward the target and the heel comes up onto the toe
        L.thigh.rotation.x = -0.28 - fw * 0.15 + bw * 0.04;
        L.thigh.rotation.y = fw * 0.6;
        L.shin.rotation.x = 0.4 + fw * 0.6;
        L.foot.rotation.x = fw * 0.95;
      }
    }
  }

  // Body-frame shoulder positions (trail, lead) for the torso as currently posed.
  shoulders() {
    this.spine.updateMatrix();
    this.chest.updateMatrix();
    return this.arms.map((A) => { A.sh.updateMatrix(); return A.sh.position.clone().applyMatrix4(this.chest.matrix).applyMatrix4(this.spine.matrix); });
  }

  // Address: the lead arm hangs almost straight from the shoulder and the shaft runs
  // from the hands down to the ground at the club's lie, so the sole rests on the turf.
  calibrate() {
    // bend over further (short clubs) until the lead hand reaches the grip low enough,
    // and drop the trail shoulder until the trail hand reaches its spot below it
    this.bendX = 0;
    this.tiltX = 0;
    const phase = this.phase;
    this.phase = 'idle';
    const l = this.clubLen - GRIP_LEAD; // lead hand to the sole
    const lie = this.lie * Math.PI / 180, lean = this.handsAhead;
    const reach = this.putting ? 0.575 : 0.59; // lead arm nearly straight in a full swing
    let S;
    for (let it = 0; it < 24; it++) {
      this.poseBody(0);
      S = this.shoulders();
      const lead = S[LEAD], trail = S[TRAIL];
      const H = new THREE.Vector3(lean, this.groundY + l * Math.sin(lie), 0);
      const dx = H.x - lead.x, dy = H.y - lead.y;
      if (dx * dx + dy * dy > reach * reach - 0.012 && this.bendX < 0.45) { this.bendX += 0.025; continue; }
      H.z = lead.z + Math.sqrt(Math.max(0.0025, reach * reach - dx * dx - dy * dy));
      const drop = H.y - this.groundY;
      const horiz = Math.sqrt(Math.max(0.01, l * l - lean * lean - drop * drop));
      const C = new THREE.Vector3(-lean, -drop, horiz).normalize();
      this.H0 = H;
      this.C0 = C;
      // sole flat at address: tilt the head by the shaft's actual lie
      this.headG.rotation.z = -(Math.PI / 2 - Math.atan2(drop, Math.hypot(horiz, lean)));
      const T = H.clone().addScaledVector(C, GRIP_TRAIL - GRIP_LEAD);
      if (T.distanceTo(trail) > REACH && this.tiltX < 0.3) { this.tiltX += 0.02; continue; }
      break;
    }
    this.hub = S[0].clone().add(S[1]).multiplyScalar(0.5);
    this.phase = phase;
  }

  // Club pose for p: lead-hand grip point H and shaft direction C (hands → head) in the
  // body frame, plus a reference for the face. The full swing follows keyframes; the
  // downswing holds the wrist cock ("lag") until late and releases it into the ball.
  clubPose(p, f) {
    const H = new THREE.Vector3(), C = new THREE.Vector3(), F = new THREE.Vector3();
    if (this.putting) {
      // pendulum: the arms-and-club triangle rocks about the point between the shoulders
      const arm = this.H0.clone().sub(this.hub);
      const axis = new THREE.Vector3(1, 0, 0).cross(arm).normalize();
      const q = new THREE.Quaternion().setFromAxisAngle(axis, -p * PUTT_ARC);
      H.copy(arm).applyQuaternion(q).add(this.hub);
      C.copy(this.C0).applyQuaternion(q);
      F.set(1, 0, 0).applyQuaternion(q);
      return { H, C, F };
    }
    spline(H_KEYS, p, H).add(this.H0);
    C_KEYS[4] = this.C0;
    spline(C_KEYS, p, C).normalize();
    spline(F_KEYS, p, F);
    if (f !== null && p < 0) {
      // lag: keep the angle between the arms and the shaft from the top until ~half way
      // down, then fire it out so the shaft is back in line at impact
      const top = Math.max(-1, -this.power);
      const armTop = spline(H_KEYS, top, new THREE.Vector3()).add(this.H0).sub(this.hub);
      const angTop = armTop.angleTo(spline(C_KEYS, top, new THREE.Vector3()));
      const arm = H.clone().sub(this.hub);
      const extra = Math.max(0, angTop - arm.angleTo(C)) * (1 - smooth(0.5, 0.97, f));
      if (extra > 1e-4) {
        const k = arm.cross(C).normalize();
        C.applyAxisAngle(k, extra);
        F.applyAxisAngle(k, extra);
      }
    }
    return { H, C, F };
  }

  apply(p, f = null) {
    this.poseBody(p, f);
    const { H, C, F } = this.clubPose(p, f);
    if (this.putting) this.rock(p);
    // the hands travel with the weight shift while the head keeps to its arc, which
    // leans the shaft toward the target through impact
    const L = this.clubLen - GRIP_LEAD;
    const headP = H.clone().addScaledVector(C, L);
    H.x += this.hips.position.x;
    C.copy(headP).sub(H).normalize();
    // the arms are only so long: pull the club in toward any shoulder it has run away from
    const S = this.shoulders();
    for (let it = 0; it < 3; it++) {
      for (let i = 0; i < 2; i++) {
        const T = H.clone().addScaledVector(C, i === LEAD ? 0 : GRIP_TRAIL - GRIP_LEAD);
        const d = T.distanceTo(S[i]);
        if (d > REACH) H.addScaledVector(S[i].clone().sub(T), (d - REACH) / d);
      }
    }
    // the club: butt just above the lead hand, shaft along C, face toward F
    const y = C.clone().negate();
    const x = new THREE.Vector3().crossVectors(F, y);
    if (x.lengthSq() < 1e-6) x.set(0, 0, 1);
    x.normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    this.hands.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    this.hands.position.copy(H).addScaledVector(C, -GRIP_LEAD);
    // arms: two-bone IK from each shoulder to its hand on the grip
    const qChest = this.spine.quaternion.clone().multiply(this.chest.quaternion);
    for (let i = 0; i < 2; i++) {
      const T = H.clone().addScaledVector(C, i === LEAD ? 0 : GRIP_TRAIL - GRIP_LEAD);
      ik(this.arms[i], S[i], T, qChest);
    }
  }

  // Putting: the shoulders rock with the pendulum so the arms-and-club triangle stays
  // fixed, while the head stays still over the ball.
  rock(p) {
    const arm = this.H0.clone().sub(this.hub);
    const axis = new THREE.Vector3(1, 0, 0).cross(arm).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, -p * PUTT_ARC);
    const qs = this.spine.quaternion;
    const chestB = qs.clone().multiply(this.chest.quaternion);  // chest in the body frame
    const headB = chestB.clone().multiply(this.head.quaternion);
    this.chest.quaternion.copy(qs).invert().multiply(q).multiply(chestB);
    this.head.quaternion.copy(q.multiply(chestB)).invert().multiply(headB);
  }

  update(dt) {
    if (this.phase === 'idle') {
      // breathing, plus a two-stroke waggle every few seconds while settling over the ball
      this.idleT += dt;
      const c = this.idleT % 3.8;
      const env = smooth(0, 0.15, c) * (1 - smooth(0.8, 0.95, c));
      const wag = this.putting ? 0 : Math.sin(c * Math.PI * 2 * 2.3) * 0.04 * env;
      this.apply(wag + Math.sin(this.idleT * 1.3) * 0.004);
      return;
    }
    const put = this.putting;
    const backDur = put ? 0.55 + this.power * 0.25 : 0.95;
    const downDur = put ? 0.35 : 0.3;
    const thruDur = put ? 0.6 : 0.9;
    this.t += dt;
    if (this.phase === 'back') {
      const k = Math.min(1, this.t / backDur);
      this.apply(-ease(k) * this.power);
      if (k >= 1) { this.phase = 'down'; this.t = 0; }
    } else if (this.phase === 'down') {
      const k = Math.min(1, this.t / downDur);
      this.apply(-this.power * (1 - k * k), put ? null : k);
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

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _y = new THREE.Vector3(0, 1, 0), _z = new THREE.Vector3(0, 0, 1);
// grip: lead hand 5 cm below the butt, trail hand just below it
const GRIP_LEAD = 0.05, GRIP_TRAIL = 0.14;
const UPPER = 0.3, FORE = 0.3, REACH = 0.595;
const TRAIL = 0, LEAD = 1; // this.arms order (built for s = -1, then +1)
const PUTT_ARC = 0.42; // shoulder rock (rad) for a full-power putt
const POLE = new THREE.Vector3(0, -1, -0.35).normalize(); // elbows point down and back at the hips

// Two-bone arm IK in the body frame: shoulder S to hand target T, the elbow bending
// toward the pole. Sets the shoulder and forearm rotations (the upper arm stays identity).
function ik(A, S, T, qChest) {
  const d = T.clone().sub(S);
  const dist = Math.min(Math.max(d.length(), 0.08), UPPER + FORE - 1e-4);
  const u = d.normalize();
  const a1 = (dist * dist + UPPER * UPPER - FORE * FORE) / (2 * dist);
  const h = Math.sqrt(Math.max(0, UPPER * UPPER - a1 * a1));
  const side = POLE.clone().addScaledVector(u, -POLE.dot(u));
  if (side.lengthSq() < 1e-6) side.set(0, 0, -1).addScaledVector(u, -u.z);
  side.normalize();
  const E = S.clone().addScaledVector(u, a1).addScaledVector(side, h);
  const W = S.clone().addScaledVector(u, dist);
  const n = new THREE.Vector3().crossVectors(u, side).normalize(); // elbow hinge axis
  const basis = (from, to) => {
    const y = from.clone().sub(to).normalize(); // limbs hang along their local -y
    const x = n.clone().addScaledVector(y, -n.dot(y)).normalize();
    const z = new THREE.Vector3().crossVectors(x, y);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  };
  const qU = basis(S, E), qF = basis(E, W);
  A.sh.quaternion.copy(qChest).invert().multiply(qU);
  A.upper.quaternion.identity();
  A.fore.quaternion.copy(qU).invert().multiply(qF);
}

// Uniform Catmull-Rom through the 9 keys at p = -1, -0.75, ..., 1.
function spline(keys, p, out) {
  const u = (Math.max(-1, Math.min(1, p)) + 1) / 0.25;
  const i = Math.min(keys.length - 2, Math.floor(u)), t = u - i;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(keys.length - 1, i + 2)];
  const t2 = t * t, t3 = t2 * t;
  const w0 = -0.5 * t3 + t2 - 0.5 * t, w1 = 1.5 * t3 - 2.5 * t2 + 1, w2 = -1.5 * t3 + 2 * t2 + 0.5 * t, w3 = 0.5 * t3 - 0.5 * t2;
  return out.set(0, 0, 0).addScaledVector(k0, w0).addScaledVector(k1, w1).addScaledVector(k2, w2).addScaledVector(k3, w3);
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);
// Full-swing keys at p = -1 (top), -0.75, -0.5, -0.25, 0 (address / impact), 0.25, 0.5,
// 0.75, 1 (finish), in the body frame (+x target, +y up, +z toward the ball): the lead
// hand's offset from address, the shaft direction (hands → head) and a face reference.
// The address shaft (index 4) comes from the club's lie.
const H_KEYS = [
  V(-0.3, 0.92, -0.36), V(-0.42, 0.74, -0.24), V(-0.5, 0.42, -0.1), V(-0.34, 0.08, -0.02), V(0, 0, 0),
  V(0.34, 0.1, -0.04), V(0.48, 0.45, -0.16), V(0.36, 0.82, -0.34), V(0.18, 0.92, -0.46),
];
const C_KEYS = [
  V(1, 0.05, -0.2), V(0.55, 0.75, -0.15), V(0.05, 1, 0.05), V(-1, 0.12, 0.25), V(0, -1, 0),
  V(1, -0.2, 0.35), V(0.05, 1, 0.1), V(-0.7, 0.6, -0.3), V(-0.6, -0.35, -0.7),
];
const F_KEYS = [
  V(0, 0.7, 0.7), V(0, 0.3, 1), V(0, 0, 1), V(-0.1, 0.4, 1), V(1, 0, 0),
  V(0.1, 0.4, -1), V(0, 0, -1), V(0, 0.3, -1), V(0, 0.6, -0.8),
];
