# Problem Statement: Dual Rendering Modes for LIF Objects in THREE.js

## Background

We are building a THREE.js library to render LIF (Leia Image Format) files as 3D reconstructions. Each LIF file contains multiple views with RGB+Depth data, camera poses, and intrinsics. These are represented as "projectors" in the scene.

## Current State

### Mesh-Based Rendering (Working)
- **Architecture**: Each projector is a THREE.Mesh with geometry deformed by vertex shader based on depth map
- **Scene Integration**: Natural - meshes are standard THREE.Object3D children that inherit transformations
- **Pros**: Clean scene graph integration, proper transformation inheritance, no lag
- **Cons**: Limited to surface reconstruction, cannot handle view-dependent effects

### Canvas-Based Raycast Rendering (In Progress)
- **Architecture**: Fragment shader raytracing on a 2D plane/canvas
- **Requirements**:
  - Ingests projector pose/intrinsics as uniforms
  - Ingests camera pose/intrinsics as uniforms
  - Renders all projectors onto a single canvas
- **Critical Constraint**: Canvas must always face the active camera (billboard behavior)

## Core Problem

**Attachment Conflict**: The raycast canvas needs to be attached to the camera (for billboard behavior), but projector transformations are defined in world space. This creates a fundamental mismatch:

1. **Camera-Attached Canvas** (current attempt in World)
   - Canvas updated to follow camera in world space
   - **Issue**: Introduces visible lag during camera movement
   - Projector poses in world coordinates work naturally

2. **Camera-Child Canvas** (proposed solution)
   - Canvas defined as child of camera object
   - No lag - inherits camera transformations automatically
   - **Issue**: Projector poses must be transformed to camera-local coordinates
   - **Issue**: Current pose representation (slant, roll) insufficient - need full rotation matrices

## Design Questions

### 1. Canvas Architecture
**Option A**: Single shared canvas for all projectors
- One canvas attached to camera
- All projectors rendered onto same canvas via multi-pass or single shader
- Toggle mesh/raycast mode globally

**Option B**: One canvas per projector
- Each projector creates its own camera-attached canvas
- Independent mesh/raycast toggle per projector
- More flexible but higher overhead

### 2. Coordinate System Management
**Current**: Projector poses in world space with (slant, roll) representation
**Needed**: Projector poses as rotation matrices, convertible to camera-local space

**Questions**:
- Should projectors store poses in world space and transform to camera space per frame?
- Or maintain dual representations (world + camera-local)?
- How to efficiently update camera-local poses when camera moves?

### 3. Transformation Hierarchy
**Mesh mode**: `Scene → Projector (Object3D) → Mesh`
- Natural transformation inheritance

**Raycast mode**: `Scene → Camera → Canvas`, with `Scene → Projector (data only)`
- Projector transformations (position, rotation, scale) must be manually applied to shader uniforms
- No automatic inheritance from scene graph

**Question**: How to maintain consistent transformation API across both modes?

## Technical Constraints

1. **Billboard Behavior**: Raycast canvas must face camera without lag
2. **Pose Representation**: Need full rotation matrices (not just slant/roll)
3. **Multiple Projectors**: Must render all LIF views efficiently
4. **Transformation Parity**: Same Object3D API (position, rotation, scale) should work in both modes
5. **Scene Graph Integration**: Should feel like native THREE.js objects

## Success Criteria

1. **Zero Lag**: Raycast canvas follows camera without visible delay
2. **Unified API**: Projector.position/rotation/scale works identically in both modes
3. **Efficient Multi-Projector**: Can render many LIF objects without performance degradation
4. **Clean Architecture**: Code organization is maintainable and extensible
5. **Mode Switching**: Can toggle mesh ↔ raycast per projector at runtime

## Open Questions

1. Should each projector have its own canvas, or share one global canvas?
2. How to manage coordinate transformations efficiently (world → camera space)?
3. Where should pose conversion logic live (Projector class? Renderer? Both)?
4. How to handle camera changes (user switching between multiple cameras)?
5. Should we maintain backward compatibility with current slant/roll representation?
