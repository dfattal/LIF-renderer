# Architecture Recommendation: Camera-Attached Raycast Canvas

## Executive Summary

**Recommended Approach**: Single shared raycast canvas as a child of the camera, with projector poses transformed to camera-local coordinates using full rotation matrices.

This recommendation prioritizes zero-lag rendering, clean THREE.js integration, and efficient multi-projector support.

---

## Detailed Analysis

### 1. Canvas Architecture: Single Shared vs. Per-Projector

**RECOMMENDATION: Single Shared Canvas**

**Rationale**:
- **Performance**: One draw call vs. N draw calls for N projectors. Fragment shader can handle multiple projectors efficiently via uniforms/texture arrays
- **Simplicity**: Single billboard management, single coordinate transform per frame
- **Flexibility**: Easier to implement cross-projector effects (blending, occlusion) in future
- **Scalability**: Current shaders already support multi-layer/multi-view (see `rayCastStereoLDI.glsl` with arrays for 4 layers)

**Implementation**:
```
Scene
├── Camera
│   └── RaycastCanvas (single, shared, billboard)
└── Projector1 (Object3D, world-space transform)
└── Projector2 (Object3D, world-space transform)
└── ... other THREE.js objects
```

**Trade-off**: All projectors toggle mesh/raycast mode together (not independently). This is acceptable because:
- Raycast mode is primarily for high-quality multi-layer LDI rendering
- Mesh mode is for preview/debug
- Mixed modes would create visual inconsistency

---

### 2. Coordinate System Management

**RECOMMENDATION: Transform-on-Render with Full Rotation Matrices**

**Rationale**:
- **Zero Lag**: Canvas as camera child → automatic billboard behavior via scene graph
- **Clean API**: Projectors remain standard THREE.Object3D with position/rotation/scale
- **Correctness**: Camera's `matrixWorldInverse` handles world→camera transform efficiently

**Pose Representation**:
- **Upgrade from (slant, roll) to Rotation Matrix**: Required for general 3D orientations
- **Storage**: Projectors store world-space transforms (position: Vector3, quaternion: Quaternion)
- **Conversion**: Per-frame transform to camera-local via `camera.matrixWorldInverse * projector.matrixWorld`

**Current Code Analysis**:
Looking at `RaycastPlane.ts:449-483`, the shader already receives:
- `uFaceRotation` (camera rotation matrix) ✓
- `uViewPosition` (projector position) - currently world-space

**Required Changes**:
1. Add projector rotation matrix uniform (currently missing!)
2. Transform projector position/rotation to camera-local space before passing to shader
3. Remove legacy `sk1/sl1/roll1` uniforms (replaced by rotation matrix)

---

### 3. Transformation Hierarchy & API Consistency

**RECOMMENDATION: Projector as Transparent Transform Container**

**Design Pattern**:
```typescript
class HoloProjector extends THREE.Object3D {
  // Public API (same for both modes)
  position: Vector3  // Works via Object3D
  rotation: Euler    // Works via Object3D
  quaternion: Quaternion  // Works via Object3D
  scale: Vector3     // Works via Object3D

  // Mode-specific rendering
  renderMode: 'mesh' | 'raycast'

  // Data (intrinsics, textures, layers)
  lifLayers: LayerData[]
  intrinsics: CameraIntrinsics
}
```

**Mesh Mode**:
- HoloProjector contains HoloRenderer mesh as child
- Transforms automatically inherit via scene graph
- ✓ Already working

**Raycast Mode**:
- HoloProjector has no visual children (data container only)
- HoloRenderer creates shared RaycastCanvas as camera child
- onBeforeRender: Transform projector pose to camera-local and pass to shader

**API Consistency**:
```javascript
// User code (identical for both modes)
projector.position.set(1, 2, 3);
projector.rotation.y = Math.PI / 4;
projector.scale.set(2, 2, 2);
```

Internal handling differs:
- **Mesh**: Scene graph propagates transforms automatically
- **Raycast**: `onBeforeRender` calculates `projectorPoseInCameraSpace = camera.matrixWorldInverse * projector.matrixWorld`

---

## Implementation Plan

### Phase 1: Rotation Matrix Support (Foundation)

**Files to Modify**:
1. `RaycastPlane.ts`
   - Add `uViewRotation: Matrix3` uniform (projector rotation in camera space)
   - Remove legacy `sk1/sl1/roll1` uniforms
   - Add `updateProjectorPose(projector, camera)` method

2. `rayCastMonoLDI.glsl` / `rayCastStereoLDI.glsl`
   - Replace rotation encoding with matrix: `uniform mat3 uViewRotation;`
   - Update raycast logic to use rotation matrix instead of (slant, roll)

**Coordinate Transform Logic**:
```typescript
updateProjectorPose(projector: HoloProjector, camera: THREE.Camera) {
  // Calculate camera-local transform
  const cameraMatrixInv = camera.matrixWorldInverse;
  const projectorMatrixWorld = projector.matrixWorld;

  // Position: world → camera space
  const posInCameraSpace = projector.position.clone()
    .applyMatrix4(cameraMatrixInv);
  this.uniforms.uViewPosition.value.copy(posInCameraSpace);

  // Rotation: world → camera space
  const rotationInCameraSpace = new THREE.Matrix3()
    .setFromMatrix4(cameraMatrixInv)
    .multiply(new THREE.Matrix3().setFromMatrix4(projectorMatrixWorld));
  this.uniforms.uViewRotation.value.copy(rotationInCameraSpace);
}
```

**Important Note**: Apply Z-flip transform as documented in CLAUDE.md:
```glsl
mat3 flipZ = mat3(1.0, 0.0, 0.0,
                  0.0, 1.0, 0.0,
                  0.0, 0.0, -1.0);
mat3 shaderRotation = flipZ * transpose(uViewRotation) * flipZ;
```

### Phase 2: Camera-Attached Canvas (Zero-Lag Solution)

**Files to Modify**:
1. `HoloRenderer.ts:249-284` (renderRaycastLayerStereo)
   - Change: `scene.add(this.raycastPlane)` → `camera.add(this.raycastPlane)`
   - Remove: `updatePlaneTransform(camera)` call (no longer needed - billboard is automatic)
   - Update: Position canvas at fixed local Z distance (e.g., `this.raycastPlane.position.z = -planeDistance`)

2. `RaycastPlane.ts:498-511` (updatePlaneTransform)
   - **DELETE METHOD** - no longer needed when canvas is camera child
   - Billboard behavior is now automatic via scene graph

**Before/After**:
```typescript
// BEFORE (World.ts pattern - causes lag)
scene.add(raycastPlane);
raycastPlane.updatePlaneTransform(camera); // Manual update → lag

// AFTER (camera child - zero lag)
camera.add(raycastPlane);
raycastPlane.position.set(0, 0, -planeDistance); // Local to camera
raycastPlane.quaternion.identity(); // Face camera (local Z)
```

### Phase 3: Multi-Projector Support

**Files to Modify**:
1. `RaycastPlane.ts`
   - Expand uniforms to support multiple projectors (currently supports 1 mono or 2 stereo)
   - Add array uniforms: `uViewPositions[]`, `uViewRotations[]`
   - Update shader to iterate over all projectors

2. `HoloRenderer.ts:onBeforeRender`
   - Collect all projectors in raycast mode
   - Call `raycastPlane.updateProjectorPose(projector, camera)` for each
   - Pass all projectors to shader

**Shader Multi-Pass Strategy**:
```glsl
// For each pixel on canvas
for (int projIdx = 0; projIdx < uNumProjectors; projIdx++) {
  vec3 projPos = uViewPositions[projIdx];
  mat3 projRot = uViewRotations[projIdx];

  // Raycast from camera through pixel into projector's depth layers
  vec4 color = rayCastProjector(projIdx, pixelPos, ...);

  // Composite with depth-based blending
  finalColor = compositeDepth(finalColor, color);
}
```

### Phase 4: Mode Toggle & Cleanup

**Files to Modify**:
1. `HoloProjector.ts`
   - Add `setRenderMode(mode: 'mesh' | 'raycast')` method
   - Propagate to associated HoloRenderer

2. `HoloRenderer.ts`
   - When switching to raycast: Create/show canvas, hide mesh
   - When switching to mesh: Hide canvas, show mesh
   - Ensure proper disposal of unused resources

---

## Code Organization

### Responsibility Matrix

| Component | Mesh Mode | Raycast Mode |
|-----------|-----------|--------------|
| **HoloProjector** | Parent of HoloRenderer mesh | Data container (no visual children) |
| **HoloRenderer** | Renders instanced mesh | Manages shared RaycastCanvas |
| **RaycastCanvas** | N/A | Child of camera, receives all projector uniforms |
| **Scene Graph** | `Scene → Projector → Mesh` | `Scene → Projector (data)` + `Camera → Canvas` |

### File Structure
```
src/
├── HoloProjector.ts       # Data + Transform (Object3D wrapper)
├── HoloRenderer.ts        # Mesh rendering + Canvas management
├── RaycastPlane.ts        # Canvas billboard + shader uniforms
└── shaders/
    ├── rayCastMonoLDI.glsl   # Single projector raycast
    └── rayCastStereoLDI.glsl # Stereo pair raycast (expandable to N)
```

---

## Answers to Open Questions

### Q1: Should each projector have its own canvas, or share one global canvas?
**A**: Single shared canvas. More efficient, simpler coordination, already supported by shader architecture.

### Q2: How to manage coordinate transformations efficiently (world → camera space)?
**A**: Per-frame matrix multiplication using THREE.js built-in `matrixWorldInverse`. Negligible cost for <100 projectors.

### Q3: Where should pose conversion logic live (Projector class? Renderer? Both)?
**A**:
- **HoloProjector**: Stores world-space pose (standard Object3D API)
- **RaycastPlane**: Performs camera-space conversion (has access to both projector and camera)
- **HoloRenderer**: Orchestrates the conversion by calling `raycastPlane.updateProjectorPose(projector, camera)`

### Q4: How to handle camera changes (user switching between multiple cameras)?
**A**: When active camera changes:
1. Remove canvas from old camera: `oldCamera.remove(raycastPlane)`
2. Add to new camera: `newCamera.add(raycastPlane)`
3. Re-initialize plane distance/size based on new camera FOV

### Q5: Should we maintain backward compatibility with current slant/roll representation?
**A**: No. Migration path:
- Phase 1: Add rotation matrix support (new code path)
- Phase 2: Deprecate slant/roll (console warning)
- Phase 3: Remove slant/roll (breaking change, major version bump)

---

## Migration Path for Existing Code

### Step 1: Add rotation matrix support (non-breaking)
- New uniform `uViewRotation` added alongside legacy `sk1/sl1/roll1`
- Shader checks if rotation matrix is identity; if not, uses it; else falls back to legacy

### Step 2: Update demo/examples
- Show rotation matrix usage
- Deprecation warnings in console

### Step 3: Remove legacy (v2.0.0)
- Delete `sk1/sl1/roll1` uniforms
- Update all shaders to use rotation matrix only

---

## Performance Characteristics

### Mesh Mode
- **Geometry**: N vertices (width × height grid)
- **Draw Calls**: 1 per projector
- **Transform**: GPU vertex shader (automatic)

### Raycast Mode
- **Geometry**: 2 triangles (quad)
- **Draw Calls**: 1 total (all projectors)
- **Transform**: CPU per-frame (M projectors × 1 matrix multiply)
- **Fragment Shader**: Complex (raycast + multi-layer compositing)

**Recommendation**:
- Use **mesh mode** for <5 projectors, single-layer, low-quality preview
- Use **raycast mode** for multi-layer LDI, view-dependent effects, high quality

---

## Risks & Mitigations

### Risk 1: Shader Complexity
**Issue**: Multi-projector fragment shader may hit performance limits
**Mitigation**:
- Start with max 4 projectors (matching current LDI layer limit)
- Profile and optimize hot paths
- Consider compute shaders for >10 projectors (future work)

### Risk 2: Camera Switch Lag
**Issue**: Removing/adding canvas to different cameras may cause frame drop
**Mitigation**:
- Implement camera switch detection in `onBeforeRender`
- Use object pooling (keep canvas alive, just reparent)

### Risk 3: Matrix Precision
**Issue**: World→camera transform may accumulate floating-point error
**Mitigation**:
- Use double-precision for camera matrix calculations (THREE.js uses Float64 for matrices)
- Normalize rotation matrices every N frames

---

## Next Steps

1. **Prototype Phase 1** (rotation matrix support) in isolated branch
2. **Validate** with existing demo scenes (SFMoMA restaurant)
3. **Benchmark** performance with 1, 2, 4, 8 projectors
4. **Iterate** on shader optimization
5. **Document** new API and migration guide
6. **Release** as v2.0.0 with breaking changes

---

## Conclusion

The recommended architecture solves all core problems:
- ✅ **Zero lag**: Camera-child canvas inherits transforms automatically
- ✅ **Unified API**: Projectors use standard Object3D interface in both modes
- ✅ **Efficient multi-projector**: Single canvas, single draw call
- ✅ **Clean integration**: Leverages THREE.js scene graph naturally
- ✅ **Extensible**: Foundation for future features (occlusion, blending, compute shaders)

The key insight is to **separate concerns**:
- **Scene graph** manages transforms (world space)
- **Rendering** consumes transforms (camera space)
- **Canvas** is a rendering surface (camera-attached billboard)

This architecture aligns with THREE.js patterns and scales well to complex scenes.
