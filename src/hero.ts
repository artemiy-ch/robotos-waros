import { Matrix, Quaternion, TransformNode, Vector3 } from "@babylonjs/core";
import type { Mech } from "./models";

/** What the body is doing this frame; the rig turns it into a pose. */
export interface HeroState {
  facing: number;
  /** Velocity along / across the facing direction. */
  forward: number;
  side: number;
  grounded: boolean;
  thrusting: boolean;
  /** Where the guns point, relative to the body: positive pitch is down. */
  aimPitch: number;
  aimYaw: number;
  /** Seconds since death, or -1 while alive. */
  dead: number;
}

interface Joint {
  node: TransformNode;
  rest: Quaternion;
}

const JOINTS = [
  "spine.002", "spine.003", "head", "wing.L", "wing.R",
  "upper_arm.L", "forearm.L", "upper_arm.R", "forearm.R",
  "thigh.L", "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R",
] as const;
type JointName = (typeof JOINTS)[number];

/** How much thicker the legs are than the model's own (their length stays the same). */
const LEG_GIRTH = 1.4;

/** Stride length in world units: one full step cycle covers two of them. */
const STRIDE = 2.6;

/**
 * Procedural animation for the hero model ("Rigged robot" by joney_lol, CC BY 3.0),
 * which comes with a skeleton but no clips: walking legs, arms holding the cannons
 * towards the target, a head that follows the aim, and wings that open in flight.
 */
export class HeroRig {
  private joints: Record<JointName, Joint>;
  private phase = 0;
  private wings = 0;
  private time = 0;
  /** Vertical body bob for the owner to add to the root position. */
  bob = 0;

  constructor(private mech: Mech) {
    this.joints = Object.fromEntries(
      JOINTS.map((name) => {
        const node = mech.node(name);
        return [name, { node, rest: (node.rotationQuaternion ?? Quaternion.Identity()).clone() }];
      }),
    ) as Record<JointName, Joint>;
    for (const s of ["L", "R"]) this.thicken(`thigh.${s}`, `shin.${s}`, LEG_GIRTH);
  }

  /**
   * Makes a limb thicker without making it longer: scales the bone (and so everything below it)
   * across, but not along the axis that points to the next bone down.
   */
  private thicken(bone: string, child: string, k: number) {
    const along = this.mech.node(child).position;
    const a = [Math.abs(along.x), Math.abs(along.y), Math.abs(along.z)];
    const axis = a.indexOf(Math.max(...a));
    this.mech.node(bone).scaling = new Vector3(axis === 0 ? 1 : k, axis === 1 ? 1 : k, axis === 2 ? 1 : k);
  }

  /** Poses the body; returns true on the frame a foot comes down. */
  update(dt: number, s: HeroState) {
    this.time += dt;
    const before = Math.sin(this.phase);
    const right = new Vector3(Math.cos(s.facing), 0, -Math.sin(s.facing));
    const ahead = new Vector3(Math.sin(s.facing), 0, Math.cos(s.facing));
    const up = Vector3.Up();

    // Legs: a walk cycle driven by distance travelled, so the feet keep up with the ground.
    const speed = Math.hypot(s.forward, s.side);
    const walking = s.grounded && speed > 0.5 && s.dead < 0;
    const dir = s.forward < -0.5 ? -1 : 1;
    if (walking) this.phase += (dt * speed * Math.PI) / STRIDE;
    const amp = walking ? Math.min(1, speed / 9) : 0;
    const swing = Math.sin(this.phase) * 0.55 * amp * dir;
    const kneeL = -0.9 * amp * Math.max(0, Math.sin(this.phase + 1.2 * dir));
    const kneeR = -0.9 * amp * Math.max(0, Math.sin(this.phase + Math.PI + 1.2 * dir));
    this.bob = -Math.abs(Math.sin(this.phase)) * 0.18 * amp;

    // In the air the legs hang a little bent; dying folds the knees.
    const dying = s.dead >= 0 ? Math.min(1, s.dead / 0.6) : 0;
    const air = !s.grounded && s.dead < 0 ? 1 : 0;
    const thighL = swing + air * 0.35 + dying * 0.5, thighR = -swing + air * 0.15 + dying * 0.3;
    const shinL = kneeL - air * 0.6 - dying * 1.2, shinR = kneeR - air * 0.4 - dying * 1.0;

    // Wings fold back on the ground and open out while the jets fire.
    const wingsTarget = s.thrusting ? 0.55 : air ? 0.25 : -0.3;
    this.wings += (wingsTarget - this.wings) * Math.min(1, dt * 6);
    const flap = s.thrusting ? Math.sin(this.time * 18) * 0.06 : 0;

    // Arms hold the cannons out towards the target.
    const armRaise = 1.15 - s.aimPitch * 0.8 - dying * 1.1;
    const lean = 0.06 * amp * dir + dying * 0.5;

    this.rotate("spine.002", [[ahead, -swing * 0.12], [right, lean]]);
    this.rotate("spine.003", [[up, s.aimYaw * 0.35]]);
    this.rotate("head", [[up, s.aimYaw * 0.4], [right, s.aimPitch * 0.5]]);
    this.rotate("wing.L", [[ahead, -(this.wings + flap)]]);
    this.rotate("wing.R", [[ahead, this.wings + flap]]);
    this.rotate("upper_arm.L", [[right, armRaise], [up, s.aimYaw * 0.4]]);
    this.rotate("forearm.L", [[right, 0.25]]);
    this.rotate("upper_arm.R", [[right, armRaise], [up, s.aimYaw * 0.4]]);
    this.rotate("forearm.R", [[right, 0.25]]);
    this.rotate("thigh.L", [[right, thighL]]);
    this.rotate("shin.L", [[right, shinL]]);
    this.rotate("foot.L", [[right, -(thighL + shinL) * 0.8]]);
    this.rotate("thigh.R", [[right, thighR]]);
    this.rotate("shin.R", [[right, shinR]]);
    this.rotate("foot.R", [[right, -(thighR + shinR) * 0.8]]);
    // A foot lands each time the swing passes through the middle.
    return walking && Math.sign(Math.sin(this.phase)) !== Math.sign(before);
  }

  /**
   * Sets a joint to its rest pose turned about world-space axes. The axes are taken into
   * the parent's frame, which works whatever the bone's own axes happen to be.
   * Joints are posed parents first, so each parent's world matrix is already current.
   */
  private rotate(name: JointName, turns: [Vector3, number][]) {
    const { node, rest } = this.joints[name];
    const parent = node.parent as TransformNode;
    if (name === "spine.002") this.mech.bonePosition(parent.name); // brings the chain above the rig up to date
    const toParent = parent.getWorldMatrix().clone().invert();
    let m = Matrix.Identity();
    rest.toRotationMatrix(m);
    for (const [axis, angle] of turns) {
      if (Math.abs(angle) < 1e-4) continue;
      m = m.multiply(Matrix.RotationAxis(Vector3.TransformNormal(axis, toParent).normalize(), angle));
    }
    Quaternion.FromRotationMatrixToRef(m, node.rotationQuaternion!);
    node.computeWorldMatrix(true);
  }
}
