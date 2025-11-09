# Rotation Matrix API Reference

## Quick Migration Guide

### Old Way (Slant/Roll) - DEPRECATED
```typescript
// Limited to specific rotation patterns
const projector = new HoloProjector({
  // ... texture options
});

// Rotation encoded as slant/roll (limited expressiveness)
// Stored in uniforms: sk1, sl1, roll1
```

### New Way (Rotation Matrix) - RECOMMENDED
```typescript
// Full 3D rotation support via THREE.js Quaternion/Euler
const projector = new HoloProjector({
  // ... texture options
});

// Standard THREE.js rotation API
projector.rotation.set(0, Math.PI/4, 0); // Euler angles (X, Y, Z)

// OR use quaternion directly
projector.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI/4);

// OR from LIF data (automatic conversion)
const projector = await HoloProjector.fromLifView(lifView);
// Internally calls: lifRotationToQuaternion(view.rotation)
```

---

## How It Works Under the Hood

### 1. Projector Stores World-Space Transform
```typescript
class HoloProjector extends THREE.Object3D {
  position: THREE.Vector3;    // World space
  quaternion: THREE.Quaternion; // World space
  rotation: THREE.Euler;      // World space (linked to quaternion)
}
```

### 2. Per-Frame Conversion to Camera-Local Space
In `HoloRenderer.renderRaycastLayerStereo()`:
```typescript
// Called every frame
raycastPlane.updateProjectorPose(projector, camera);
```

Inside `RaycastPlane.updateProjectorPose()`:
```typescript
// Transform position
const posInCameraSpace = projector.position.clone()
  .applyMatrix4(camera.matrixWorldInverse);

// Transform rotation
const projectorRotationWorld = new THREE.Matrix3()
  .setFromMatrix4(projector.matrixWorld);
const cameraRotationInv = new THREE.Matrix3()
  .setFromMatrix4(camera.matrixWorldInverse);
const rotationInCameraSpace = new THREE.Matrix3()
  .multiplyMatrices(cameraRotationInv, projectorRotationWorld);

// Upload to shader
this.uniforms.uViewPosition.value.copy(posInCameraSpace);
this.uniforms.uViewRotation.value.copy(rotationInCameraSpace);
```

### 3. Shader Applies Z-Flip Transform
In `rayCastMonoLDI.glsl`:
```glsl
uniform mat3 uViewRotation; // Camera-local rotation matrix

void main() {
  // Apply Z-flip similarity transform (see CLAUDE.md)
  mat3 flipZ = mat3(1.0, 0.0, 0.0,
                    0.0, 1.0, 0.0,
                    0.0, 0.0, -1.0);

  mat3 viewRotationMatrix = flipZ * transpose_m(uViewRotation) * flipZ;

  // Use in raycasting
  mat3 SKR1 = matFromSkew(sk1) * viewRotationMatrix;
  // ... raycasting logic
}
```

---

## Examples

### Example 1: Rotate Projector Around Y Axis
```typescript
const projector = new HoloProjector({
  rgbUrl: 'image.jpg',
  depthUrl: 'depth.png',
  intrinsics: { fx: 800, fy: 800, cx: 640, cy: 400 },
  invDepthRange: { min: 0.1, max: 0.01 },
  width: 1280,
  height: 800,
});

scene.add(projector);

// Rotate 45 degrees around Y axis (world space)
projector.rotation.y = Math.PI / 4;

// Automatically converted to camera-local space during rendering!
```

### Example 2: Animate Rotation
```typescript
function animate() {
  requestAnimationFrame(animate);

  // Rotate projector continuously
  projector.rotation.y += 0.01;

  renderer.render(scene, camera);
}
```

### Example 3: From Axis-Angle
```typescript
// Rotate 90 degrees around X axis
const axis = new THREE.Vector3(1, 0, 0);
const angle = Math.PI / 2;
projector.quaternion.setFromAxisAngle(axis, angle);
```

### Example 4: From Look-At Direction
```typescript
// Make projector "look at" a target point
const target = new THREE.Vector3(5, 2, -3);
const up = new THREE.Vector3(0, 1, 0);

// Create a temporary matrix for lookAt
const matrix = new THREE.Matrix4();
matrix.lookAt(projector.position, target, up);

// Extract rotation
projector.quaternion.setFromRotationMatrix(matrix);
```

---

## Coordinate System Conventions

### THREE.js (Projector in World Space)
- **Right-handed**: X=right, Y=up, Z=backward
- **Camera looks down**: -Z axis
- **Quaternion**: Standard mathematical convention

### Shader (After Transform)
- **After Z-flip**: Camera looks down +Z axis
- **Rotation matrix**: Column-major (GLSL standard)
- **Applied as**: `flipZ * transpose(R) * flipZ`

### Why the Z-Flip?
THREE.js cameras look down **-Z**, but the raycast shader expects cameras to look down **+Z**. The similarity transform `flipZ * R * flipZ` converts between these conventions.

---

## Debugging

### Check if Rotation Matrix is Being Used
Open browser console and look for:
```
Projector pose updated in camera space: {
  worldPos: [1, 2, 3],
  cameraLocalPos: [0.5, 0.2, -2.5],
  rotationMatrix: [...]  // Should be non-identity if rotation is applied
}
```

### Visualize Projector Frustum
```typescript
projector.frustumHelper.visible = true; // Show green frustum wireframe
```

The frustum will rotate with the projector, confirming rotation is being applied.

### Check Shader Uniform
In shader debugging, check:
```glsl
bool useRotationMatrix = (length(uViewRotation[0]) > 0.01);
```

If `useRotationMatrix == false`, the shader is falling back to legacy slant/roll mode.

---

## Common Pitfalls

### ❌ Don't: Modify Rotation Matrix Directly
```typescript
// BAD: Don't do this!
projector.matrixWorld.makeRotationFromEuler(new THREE.Euler(x, y, z));
```

### ✅ Do: Use Quaternion/Euler Properties
```typescript
// GOOD: Use standard THREE.js API
projector.rotation.set(x, y, z);
// OR
projector.quaternion.setFromEuler(new THREE.Euler(x, y, z));
```

### ❌ Don't: Mix World and Local Rotations
```typescript
// BAD: Confusing local vs world space
projector.rotateOnAxis(axis, angle); // Rotates in LOCAL space
```

### ✅ Do: Use World-Space Rotations
```typescript
// GOOD: Clear world-space rotation
projector.rotation.y = angle; // World space Y rotation
```

---

## Performance Notes

### Cost Per Frame (Raycast Mode)
For each projector:
1. **Matrix World Update**: `projector.updateMatrixWorld()` (~0.1ms)
2. **Coordinate Transform**: Matrix multiply (~0.01ms)
3. **Uniform Upload**: GPU transfer (~0.01ms)

**Total**: ~0.12ms per projector @ 60 FPS

### Scalability
- **1-10 projectors**: Negligible impact (<1.2ms total)
- **10-50 projectors**: Noticeable but acceptable (~6ms total)
- **50+ projectors**: Consider batching or compute shaders

---

## Backward Compatibility

### Detection Logic in Shader
```glsl
// Check if rotation matrix is identity (default value)
bool useRotationMatrix = (length(uViewRotation[0]) > 0.01);

if (useRotationMatrix) {
  // NEW: Use rotation matrix
  SKR1 = matFromSkew(sk1) * viewRotationMatrix;
} else {
  // LEGACY: Use slant/roll decomposition
  SKR1 = matFromSkew(sk1) * matFromRoll(roll1) * matFromSlant(sl1);
}
```

### When Legacy Mode Triggers
- `uViewRotation` is not set (remains identity matrix)
- Old code using `sk1/sl1/roll1` uniforms directly

### When Modern Mode Triggers
- `updateProjectorPose()` is called (sets `uViewRotation`)
- Projector has non-default rotation (quaternion not identity)

---

## Future Enhancements

### Planned for v2.0
- Remove legacy `sk1/sl1/roll1` uniforms
- Add deprecation warnings for slant/roll usage
- Support for multiple projectors per canvas

### Planned for v3.0
- Compute shader optimization for 100+ projectors
- Automatic LOD based on projector distance
- Frustum culling for off-screen projectors

---

## See Also

- **PROBLEM-STATEMENT.md** - Original architectural problem analysis
- **ARCHITECTURE-RECOMMENDATION.md** - Detailed design rationale
- **IMPLEMENTATION-SUMMARY.md** - Implementation details and changes
- **CLAUDE.md** - Z-flip transform explanation (section: Matrix Conversion)
