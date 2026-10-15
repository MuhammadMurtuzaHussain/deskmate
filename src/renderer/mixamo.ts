import * as THREE from 'three'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm'

/** Mixamo rig bone → VRM humanoid bone (from pixiv/three-vrm's humanoidAnimation example, MIT). */
const RIG_MAP: Record<string, VRMHumanBoneName> = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder',
  mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm',
  mixamorigLeftHand: 'leftHand',
  mixamorigLeftHandThumb1: 'leftThumbMetacarpal',
  mixamorigLeftHandThumb2: 'leftThumbProximal',
  mixamorigLeftHandThumb3: 'leftThumbDistal',
  mixamorigLeftHandIndex1: 'leftIndexProximal',
  mixamorigLeftHandIndex2: 'leftIndexIntermediate',
  mixamorigLeftHandIndex3: 'leftIndexDistal',
  mixamorigLeftHandMiddle1: 'leftMiddleProximal',
  mixamorigLeftHandMiddle2: 'leftMiddleIntermediate',
  mixamorigLeftHandMiddle3: 'leftMiddleDistal',
  mixamorigLeftHandRing1: 'leftRingProximal',
  mixamorigLeftHandRing2: 'leftRingIntermediate',
  mixamorigLeftHandRing3: 'leftRingDistal',
  mixamorigLeftHandPinky1: 'leftLittleProximal',
  mixamorigLeftHandPinky2: 'leftLittleIntermediate',
  mixamorigLeftHandPinky3: 'leftLittleDistal',
  mixamorigRightShoulder: 'rightShoulder',
  mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm',
  mixamorigRightHand: 'rightHand',
  mixamorigRightHandPinky1: 'rightLittleProximal',
  mixamorigRightHandPinky2: 'rightLittleIntermediate',
  mixamorigRightHandPinky3: 'rightLittleDistal',
  mixamorigRightHandRing1: 'rightRingProximal',
  mixamorigRightHandRing2: 'rightRingIntermediate',
  mixamorigRightHandRing3: 'rightRingDistal',
  mixamorigRightHandMiddle1: 'rightMiddleProximal',
  mixamorigRightHandMiddle2: 'rightMiddleIntermediate',
  mixamorigRightHandMiddle3: 'rightMiddleDistal',
  mixamorigRightHandIndex1: 'rightIndexProximal',
  mixamorigRightHandIndex2: 'rightIndexIntermediate',
  mixamorigRightHandIndex3: 'rightIndexDistal',
  mixamorigRightHandThumb1: 'rightThumbMetacarpal',
  mixamorigRightHandThumb2: 'rightThumbProximal',
  mixamorigRightHandThumb3: 'rightThumbDistal',
  mixamorigLeftUpLeg: 'leftUpperLeg',
  mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot',
  mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg',
  mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot',
  mixamorigRightToeBase: 'rightToes'
}

/**
 * Loads a Mixamo FBX animation and retargets it onto a VRM's normalized humanoid, returning a clip that an
 * AnimationMixer on `vrm.scene` can play. Port of pixiv/three-vrm's loadMixamoAnimation example.
 */
export async function loadMixamoAnimation(url: string, vrm: VRM): Promise<THREE.AnimationClip> {
  const asset = await new FBXLoader().loadAsync(url)
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') ?? asset.animations[0]
  if (!clip) throw new Error('no animation in FBX')
  const tracks: THREE.KeyframeTrack[] = []
  const restRotationInverse = new THREE.Quaternion()
  const parentRestWorldRotation = new THREE.Quaternion()
  const q = new THREE.Quaternion()
  const motionHips = asset.getObjectByName('mixamorigHips')
  const motionHipsHeight = motionHips?.position.y ?? 1
  const vrmHipsHeight = vrm.humanoid.normalizedRestPose.hips?.position?.[1] ?? 1
  const hipsPositionScale = vrmHipsHeight / motionHipsHeight
  const isVrm0 = vrm.meta?.metaVersion === '0'

  for (const track of clip.tracks) {
    const [mixamoRigName, propertyName] = track.name.split('.')
    const vrmBoneName = RIG_MAP[mixamoRigName]
    const vrmNodeName = vrmBoneName ? vrm.humanoid.getNormalizedBoneNode(vrmBoneName)?.name : undefined
    const mixamoRigNode = asset.getObjectByName(mixamoRigName)
    if (!vrmNodeName || !mixamoRigNode) continue
    mixamoRigNode.getWorldQuaternion(restRotationInverse).invert()
    mixamoRigNode.parent?.getWorldQuaternion(parentRestWorldRotation)
    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const values = Float32Array.from(track.values)
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i)
        q.premultiply(parentRestWorldRotation).multiply(restRotationInverse)
        q.toArray(values, i)
      }
      tracks.push(
        new THREE.QuaternionKeyframeTrack(
          `${vrmNodeName}.${propertyName}`,
          Array.from(track.times),
          Array.from(values).map((v, i) => (isVrm0 && i % 2 === 0 ? -v : v))
        )
      )
    } else if (track instanceof THREE.VectorKeyframeTrack) {
      const values = Array.from(track.values).map((v, i) => (isVrm0 && i % 3 !== 1 ? -v : v) * hipsPositionScale)
      tracks.push(new THREE.VectorKeyframeTrack(`${vrmNodeName}.${propertyName}`, Array.from(track.times), values))
    }
  }
  return new THREE.AnimationClip('mixamo', clip.duration, tracks)
}
