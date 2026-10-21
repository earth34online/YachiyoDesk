import * as THREE from 'three';

/** A critically damped rotational spring. The target retains the authored range;
 * angular velocity survives an interruption, so a new gesture cannot snap a joint.
 * Analytic integration keeps the same response at different rendering rates. */
export class JointDynamics {
  private readonly joints = new Map<string, {rotation: THREE.Quaternion; velocity: THREE.Vector3}>();
  private readonly target = new THREE.Quaternion();
  private readonly error = new THREE.Quaternion();
  private readonly displacement = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly increment = new THREE.Quaternion();

  reset(): void { this.joints.clear(); }

  apply(pose: Record<string, {rotation?: number[];position?:number[]}>, delta: number): void {
    for (const [name, entry] of Object.entries(pose)) {
      // Support feet and pelvis remain owned by the gait/IK solver.
      const settling = /Shoulder$/.test(name) ? .12 : /UpperArm$/.test(name) ? .15
        : /LowerArm$/.test(name) ? .18 : /Hand$/.test(name) ? .21
          : /^(neck|head)$/.test(name) ? .15 : /^(spine|chest|upperChest)$/.test(name) ? .12 : 0;
      if (!settling || !entry.rotation) continue;
      this.target.fromArray(entry.rotation).normalize();
      let state = this.joints.get(name);
      if (!state) { state = { rotation: this.target.clone(), velocity: new THREE.Vector3() }; this.joints.set(name,state); }
      if (delta > 0) {
        this.error.copy(this.target).invert().multiply(state.rotation).normalize();
        if(this.error.w < 0)this.error.set(-this.error.x,-this.error.y,-this.error.z,-this.error.w);
        const sine = Math.hypot(this.error.x,this.error.y,this.error.z);
        const angle = 2*Math.atan2(sine,this.error.w);
        this.displacement.set(this.error.x,this.error.y,this.error.z).multiplyScalar(sine > 1e-10 ? angle/sine : 2);
        // 95% settling time of a critically damped second order response.
        const omega = 4.744/settling, decay = Math.exp(-omega*delta);
        this.tangent.copy(state.velocity).addScaledVector(this.displacement,omega);
        this.displacement.addScaledVector(this.tangent,delta).multiplyScalar(decay);
        state.velocity.addScaledVector(this.tangent,-omega*delta).multiplyScalar(decay);
        const magnitude = this.displacement.length();
        this.increment.setFromAxisAngle(magnitude > 1e-10 ? this.displacement.clone().divideScalar(magnitude) : new THREE.Vector3(1,0,0),magnitude);
        state.rotation.copy(this.target).multiply(this.increment).normalize();
      }
      state.rotation.toArray(entry.rotation);
    }
  }
}
