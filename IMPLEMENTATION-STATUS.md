# LIF-Renderer Raytracing Implementation Status

## Completed Tasks ✅

### Phase 1: Shader Setup
- ✅ Copied `rayCastMonoLDI.glsl` to `src/shaders/`
- ✅ Copied `rayCastStereoLDI.glsl` to `src/shaders/`
- ✅ GLSL type declarations already exist in `src/types/glsl.d.ts`

### Phase 2: Utility Creation
- ✅ Created `src/utils/textureUtils.ts` with:
  - `loadImage()` - Loads images from blob URLs
  - `createDepthMaskTexture()` - Combines depth + mask into RGBA texture
  - `createRGBTexture()` - Creates standard RGB textures
  - `calculateViewportScale()` - Viewport scaling calculation

### Phase 3: RaycastPlane Class
- ✅ Created `src/RaycastPlane.ts` with:
  - Full uniform setup for mono/stereo rendering
  - Texture loading from blob URLs
  - Plane distance calculation: `z = baseline_mm / invd`
  - Dynamic uniform updates for camera-dependent rendering
  - Proper cleanup/dispose methods

---

## Remaining Tasks 🚧

### Phase 4: Modify HoloRenderer (CRITICAL)

**File**: `src/HoloRenderer.ts`

**Changes Needed**:

1. **Remove Point Rendering Mode**
   - Delete: `pointSize` property
   - Delete: `maxStdDev` property
   - Delete: Billboard/instanced geometry code (mode 0)
   - Delete: `setMeshMode(0)` option
   - Keep ONLY connected mesh mode (current mode 1)

2. **Add Render Mode Property**
   ```typescript
   export type RenderMode = 'mesh' | 'raytracing';

   export class HoloRenderer extends THREE.Mesh {
     private renderMode: RenderMode;
     private raycastPlane: RaycastPlane | null = null;
     // ... existing properties
   }
   ```

3. **Update Constructor**
   ```typescript
   export type HoloRendererOptions = {
     renderer: THREE.WebGLRenderer;
     depthWrite?: boolean;
     renderMode?: RenderMode; // New option
   };

   constructor(optionsOrRenderMode?: HoloRendererOptions | RenderMode) {
     // Support both old API and new API
     let options: HoloRendererOptions;
     if (typeof optionsOrRenderMode === 'string') {
       options = { renderMode: optionsOrRenderMode };
     } else {
       options = optionsOrRenderMode ?? {};
     }

     // Auto-detect mode based on layer count
     this.renderMode = options.renderMode ?? 'mesh';
     // ...
   }
   ```

4. **Modify onBeforeRender**
   ```typescript
   onBeforeRender(renderer, scene, camera) {
     // Single-layer mode with assigned layer
     if (this.assignedLayer && this.assignedProjector) {
       if (this.renderMode === 'mesh') {
         this.renderMeshLayer(camera, renderer);
       } else {
         this.renderRaycastPlane(camera, renderer);
       }
       return;
     }

     // Legacy mode (scan for projectors)
     // ... existing code
   }
   ```

5. **Add Raycast Rendering Method**
   ```typescript
   private async renderRaycastPlane(camera, renderer) {
     if (!this.raycastPlane && this.assignedProjector) {
       // Create plane on first render
       this.raycastPlane = new RaycastPlane(
         this.assignedLayer.width / 100,  // Scale to reasonable size
         this.assignedLayer.height / 100
       );
       await this.raycastPlane.initializeFromProjector(this.assignedProjector);
       this.add(this.raycastPlane); // Add as child
     }

     if (this.raycastPlane) {
       this.raycastPlane.updateDynamicUniforms(camera, renderer);
       this.raycastPlane.updatePlaneTransform(camera);
     }
   }
   ```

6. **Add Mode Switching**
   ```typescript
   public setRenderMode(mode: RenderMode): void {
     if (this.renderMode === mode) return;

     this.renderMode = mode;

     // Clean up old mode
     if (mode === 'mesh' && this.raycastPlane) {
       this.raycastPlane.dispose();
       this.remove(this.raycastPlane);
       this.raycastPlane = null;
     }

     if (mode === 'raytracing' && this.connectedMeshGeometry) {
       // Hide mesh geometry
       this.geometry = new THREE.BufferGeometry();
     }
   }

   public getRenderMode(): RenderMode {
     return this.renderMode;
   }
   ```

7. **Cleanup in dispose()**
   ```typescript
   dispose(): void {
     if (this.raycastPlane) {
       this.raycastPlane.dispose();
       this.raycastPlane = null;
     }
     // ... existing cleanup
   }
   ```

---

### Phase 5: Update HoloLayerGroup

**File**: `src/HoloLayerGroup.ts`

**Changes Needed**:

1. **Add Mode Detection**
   ```typescript
   public initializeFromProjector(projector: HoloProjector): void {
     this.dispose();
     this.projector = projector;

     // Auto-detect mode: raytracing if > 1 layer, mesh otherwise
     const renderMode = projector.lifLayers.length > 1 ? 'raytracing' : 'mesh';

     for (let i = 0; i < projector.lifLayers.length; i++) {
       const renderer = new HoloRenderer(renderMode);
       // ... existing setup
     }
   }
   ```

2. **Add Mode Control Methods**
   ```typescript
   public setRenderMode(mode: RenderMode): void {
     this.layerRenderers.forEach(r => r.setRenderMode(mode));
   }

   public getRenderMode(): RenderMode {
     return this.layerRenderers[0]?.getRenderMode() ?? 'mesh';
   }
   ```

---

### Phase 6: Type Definitions

**File**: `src/types/lif.d.ts`

**Changes Needed**:

1. **Add stereo_render_data to LifView**
   ```typescript
   export interface LifView {
     // ... existing fields

     // Stereo rendering data (optional)
     stereo_render_data?: {
       invd?: number;
       inv_convergence_distance?: number;
       frustum_skew?: { x: number; y: number };
     };
   }
   ```

2. **Extend LayerData**
   ```typescript
   export interface LayerData {
     // ... existing fields

     // Raytracing-specific textures (loaded on demand)
     raycastTextures?: {
       rgbTexture: THREE.Texture;
       depthMaskTexture: THREE.Texture;
     };
   }
   ```

---

### Phase 7: Export New Classes

**File**: `src/index.ts`

**Changes Needed**:

```typescript
export { HoloProjector } from "./HoloProjector";
export { HoloRenderer } from "./HoloRenderer";
export { HoloLayerGroup } from "./HoloLayerGroup";
export { RaycastPlane } from "./RaycastPlane";  // NEW
export type { HoloProjectorOptions } from "./HoloProjector";
export type { HoloRendererOptions } from "./HoloRenderer";
export type { RenderMode } from "./HoloRenderer";  // NEW
```

---

### Phase 8: Demo Updates

**File**: `index.html`

**Changes Needed**:

1. **Add Mode Toggle UI**
   ```html
   <div id="controls">
     <button id="toggle-render-mode">Mode: Mesh</button>
   </div>
   ```

2. **Add Toggle Logic**
   ```javascript
   document.getElementById('toggle-render-mode').addEventListener('click', () => {
     const layerGroup = /* find HoloLayerGroup in scene */;
     const currentMode = layerGroup.getRenderMode();
     const newMode = currentMode === 'mesh' ? 'raytracing' : 'mesh';
     layerGroup.setRenderMode(newMode);
     event.target.textContent = `Mode: ${newMode}`;
   });
   ```

---

## Testing Checklist

- [ ] Build succeeds without errors
- [ ] Single-layer LIF defaults to mesh mode
- [ ] Multi-layer LDI defaults to raytracing mode
- [ ] Toggle between modes works correctly
- [ ] Raycast plane positions at `z = baseline_mm / invd`
- [ ] Plane faces camera correctly
- [ ] Textures load from blob URLs
- [ ] Multi-layer blending works (front-to-back)
- [ ] Masking works (alpha channel respected)
- [ ] Camera movement updates uniforms
- [ ] Cleanup/dispose prevents memory leaks

---

## Known Issues / Future Work

1. **Stereo Support**: Currently only mono (1 view) implemented
2. **Plane Sizing**: May need auto-scaling based on image aspect ratio
3. **Performance**: Raycast shader is compute-intensive (40 steps per pixel)
4. **Rotation**: Camera rotation transforms not yet implemented
5. **Convergence Distance**: Need to read from LIF `stereo_render_data`

---

## File Structure

```
src/
├── RaycastPlane.ts              ✅ NEW - Raycast plane mesh class
├── HoloRenderer.ts              🚧 MODIFY - Add raytracing mode
├── HoloLayerGroup.ts            🚧 MODIFY - Add mode switching
├── HoloProjector.ts             🔄 MINOR - Add stereo_render_data
├── index.ts                     🔄 MINOR - Export RaycastPlane
├── types/
│   ├── glsl.d.ts               ✅ EXISTS - GLSL imports
│   └── lif.d.ts                🚧 MODIFY - Extend types
├── shaders/
│   ├── rayCastMonoLDI.glsl     ✅ NEW - Mono raycast shader
│   ├── rayCastStereoLDI.glsl   ✅ NEW - Stereo raycast shader
│   ├── holoVertex.glsl         ✅ EXISTS - Mesh vertex shader
│   └── holoFragment.glsl       ✅ EXISTS - Mesh fragment shader
└── utils/
    └── textureUtils.ts          ✅ NEW - Texture utilities
```

---

## Next Steps

1. Complete HoloRenderer modifications (Phase 4)
2. Update HoloLayerGroup (Phase 5)
3. Update type definitions (Phase 6)
4. Export new classes (Phase 7)
5. Update demo with toggle (Phase 8)
6. Test and debug
