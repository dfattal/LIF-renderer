import * as THREE from "three";

import type { HoloProjector } from "./HoloProjector";
import type { LayerData } from "./types/lif";
import { RaycastPlane } from "./RaycastPlane";
import holoFragment from "./shaders/holoFragment.glsl";
import holoVertex from "./shaders/holoVertex.glsl";

export type RenderMode = 'mesh' | 'raytracing';

export type HoloRendererOptions = {
  // The THREE.WebGLRenderer instance (optional)
  renderer?: THREE.WebGLRenderer;
  // Enable depth writing for proper occlusion
  depthWrite?: boolean;
  // Render mode: mesh or raytracing
  renderMode?: RenderMode;
};

export class HoloRenderer extends THREE.Mesh {
  renderer?: THREE.WebGLRenderer;
  material: THREE.ShaderMaterial;
  uniforms: ReturnType<typeof HoloRenderer.makeUniforms>;

  // Render mode
  private renderMode: RenderMode;

  // Track active projectors
  private activeProjectors: HoloProjector[] = [];
  private currentProjector: HoloProjector | null = null;

  // Debug flag to only log renderer count once
  private hasLoggedRendererCount = false;

  // Single-layer assignment (for use with HoloLayerGroup)
  public assignedLayer: LayerData | null = null;
  public assignedProjector: HoloProjector | null = null;

  // Mesh rendering
  private connectedMeshGeometry: THREE.BufferGeometry | null = null;

  // Raytracing rendering
  public raycastPlane: RaycastPlane | null = null; // Public to allow texture updates when switching views
  private renderCameraChildren: boolean = false;

  static EMPTY_TEXTURE = new THREE.Texture();

  constructor(optionsOrRenderMode?: HoloRendererOptions | RenderMode) {
    console.log("HoloRenderer: Constructing...");

    // Support both old API (HoloRendererOptions) and new API (RenderMode string)
    let options: HoloRendererOptions;
    if (typeof optionsOrRenderMode === 'string') {
      options = { renderMode: optionsOrRenderMode };
    } else {
      options = optionsOrRenderMode ?? {};
    }

    const uniforms = HoloRenderer.makeUniforms();
    const depthWrite = options.depthWrite ?? true; // Enable by default for proper occlusion
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: holoVertex,
      fragmentShader: holoFragment,
      uniforms,
      transparent: true,
      premultipliedAlpha: true,
      depthTest: true,
      depthWrite: depthWrite,
      side: THREE.DoubleSide,
    });

    // Create empty base geometry (will be replaced)
    const geometry = new THREE.BufferGeometry();

    super(geometry, material);

    // Disable frustum culling
    this.frustumCulled = false;

    this.renderer = options.renderer;
    this.material = material;
    this.uniforms = uniforms;

    // Set render mode (default to mesh)
    this.renderMode = options.renderMode ?? 'mesh';

    console.log("HoloRenderer: Created successfully with mode:", this.renderMode);
  }

  static makeUniforms() {
    return {
      // Textures
      rgbTexture: { value: HoloRenderer.EMPTY_TEXTURE },
      depthTexture: { value: HoloRenderer.EMPTY_TEXTURE },

      // Projector transform
      projectorMatrix: { value: new THREE.Matrix4() },

      // Camera intrinsics
      fx: { value: 500.0 },
      fy: { value: 500.0 },
      cx: { value: 320.0 },
      cy: { value: 240.0 },

      // Image dimensions
      imageWidth: { value: 640.0 },
      imageHeight: { value: 480.0 },

      // Inverse depth range
      invZMin: { value: 0.1 },
      invZMax: { value: 0.01 },
      baseline: { value: 1.0 },

      // Mesh rendering parameters
      meshMode: { value: 1.0 }, // Always 1 for connected mesh
      deltaInvZThreshold: { value: 0.0 },
      showDepth: { value: 0.0 },
    };
  }

  onBeforeRender(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    // Debug: Check how many HoloRenderer instances exist (only log once)
    if (!this.hasLoggedRendererCount) {
      let rendererCount = 0;
      scene.traverse((obj) => {
        if (obj instanceof HoloRenderer) {
          rendererCount++;
        }
      });
      if (rendererCount > 1) {
        console.warn(`Found ${rendererCount} HoloRenderer instances in scene!`);
      }
      this.hasLoggedRendererCount = true;
    }

    // Single-layer mode: If this renderer has been assigned a specific layer
    if (this.assignedLayer && this.assignedProjector) {
      if (this.renderMode === 'mesh') {
        this.renderMeshLayer(this.assignedLayer, this.assignedProjector, camera, renderer);
      } else {
        this.renderRaycastLayer(this.assignedLayer, this.assignedProjector, camera, renderer);
      }
      return;
    }

    // Legacy multi-projector mode: Find all HoloProjector instances in the scene
    this.activeProjectors = [];
    scene.traverse((obj) => {
      if (
        "rgbTexture" in obj &&
        "depthTexture" in obj &&
        "intrinsics" in obj &&
        "invDepthRange" in obj
      ) {
        this.activeProjectors.push(obj as HoloProjector);
      }
    });

    if (this.activeProjectors.length === 0) {
      return; // No projectors, nothing to render
    }

    // Render projector(s)
    if (this.renderMode === 'mesh') {
      // Mesh mode: render first projector only
      const projector = this.activeProjectors[0];
      this.renderMeshProjector(projector, camera);
    } else {
      // Raytracing mode: pass all projectors for stereo support
      if (this.activeProjectors[0].lifLayers.length > 0) {
        this.renderRaycastLayerStereo(this.activeProjectors, camera, renderer, scene);
      } else {
        console.warn("Raytracing mode requires lifLayers to be populated");
      }
    }
  }

  /**
   * Render a single layer using connected mesh geometry
   */
  private renderMeshLayer(
    layer: LayerData,
    projector: HoloProjector,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
  ) {
    // Track the current projector to avoid regenerating geometry
    const projectorChanged = this.currentProjector !== projector;
    if (projectorChanged) {
      this.currentProjector = projector;
    }

    // Generate or reuse connected mesh geometry
    if (!this.connectedMeshGeometry || projectorChanged) {
      if (this.connectedMeshGeometry && projectorChanged) {
        this.connectedMeshGeometry.dispose();
        this.connectedMeshGeometry = null;
      }

      // Generate connected mesh using layer dimensions
      const tempProjector = {
        width: layer.width,
        height: layer.height,
      } as any;
      this.connectedMeshGeometry = this.generateConnectedMesh(tempProjector);
      this.geometry = this.connectedMeshGeometry;
      this.geometry.attributes.position.needsUpdate = true;
      if (this.geometry.attributes.uv) {
        this.geometry.attributes.uv.needsUpdate = true;
      }
    } else if (this.geometry !== this.connectedMeshGeometry) {
      this.geometry = this.connectedMeshGeometry;
      this.geometry.attributes.position.needsUpdate = true;
    }

    // Update uniforms
    projector.updateMatrixWorld();
    this.uniforms.projectorMatrix.value.copy(projector.matrixWorld);
    this.uniforms.baseline.value = projector.invDepthRange.baseline ?? 1.0;

    // Update textures
    this.uniforms.rgbTexture.value = layer.rgbTexture || HoloRenderer.EMPTY_TEXTURE;
    this.uniforms.depthTexture.value = layer.depthTexture || HoloRenderer.EMPTY_TEXTURE;

    // Update camera intrinsics
    this.uniforms.fx.value = layer.intrinsics.fx;
    this.uniforms.fy.value = layer.intrinsics.fy;
    this.uniforms.cx.value = layer.intrinsics.cx;
    this.uniforms.cy.value = layer.intrinsics.cy;

    // Update image dimensions
    this.uniforms.imageWidth.value = layer.width;
    this.uniforms.imageHeight.value = layer.height;

    // Update inverse depth range
    this.uniforms.invZMin.value = layer.invDepthRange.min;
    this.uniforms.invZMax.value = layer.invDepthRange.max;

    // Set render order for proper layering
    this.renderOrder = layer.renderOrder ?? 0;
  }

  /**
   * Render using raycast plane with stereo support (for multi-layer LDI)
   */
  private async renderRaycastLayerStereo(
    projectors: HoloProjector[],
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
  ) {
    // Create raycast plane on first render
    if (!this.raycastPlane) {
      // Create plane with initial size (will be recalculated in updatePlaneDistance)
      this.raycastPlane = new RaycastPlane(1, 1);

      // Get invd from global stereo_render_data if available
      const stereoData = (window as any).lifStereoRenderData;
      const invd = stereoData ? (stereoData.invd ?? stereoData.inv_convergence_distance) : undefined;

      // Pass all projectors (1 for mono, 2 for stereo) and invd
      await this.raycastPlane.initializeFromProjector(projectors, invd);

      // Update plane size to match camera FOV (only needs to be done once, or on window resize)
      this.raycastPlane.updatePlaneSizeFromCamera(camera);

      // PHASE 2: Make plane a child of camera (viewer-local space, like WebXR)
      camera.add(this.raycastPlane);

      // Position at fixed distance in camera-local space
      const planeDistance = this.raycastPlane.planeDistance;
      this.raycastPlane.position.set(0, 0, -planeDistance);
      this.raycastPlane.quaternion.identity(); // Face camera

      console.log("RaycastPlane attached to camera (viewer-local) at distance:", planeDistance);
      console.log("Setting up custom render pass for camera children...");
    }

    // Update camera matrices before transforming to camera-local space
    camera.updateMatrixWorld();

    // Update projector pose in camera-local coordinates
    this.raycastPlane.updateProjectorPose(projectors[0], camera);

    // Update dynamic uniforms (camera pose)
    this.raycastPlane.updateDynamicUniforms(camera, renderer);

    // CRITICAL: Manually render the plane since it's a camera child
    // THREE.js doesn't render camera children by default, so we do it explicitly
    // Use autoClear: false to avoid clearing the scene that was just rendered
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.raycastPlane, camera);
    renderer.autoClear = oldAutoClear;

    // Hide the mesh geometry when in raytracing mode
    if (this.geometry !== new THREE.BufferGeometry()) {
      this.geometry = new THREE.BufferGeometry();
    }
  }

  /**
   * Render using raycast plane (for multi-layer LDI) - legacy single-layer mode
   */
  private async renderRaycastLayer(
    layer: LayerData,
    projector: HoloProjector,
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
  ) {
    // Create raycast plane on first render
    if (!this.raycastPlane) {
      const scale = 1.0 / 100; // Scale down to reasonable size
      this.raycastPlane = new RaycastPlane(
        layer.width * scale,
        layer.height * scale
      );
      await this.raycastPlane.initializeFromProjector(projector);
      this.add(this.raycastPlane); // Add as child
      console.log("RaycastPlane created and initialized");
    }

    // Update dynamic uniforms and transform
    this.raycastPlane.updateDynamicUniforms(camera, renderer);
    this.raycastPlane.updatePlaneTransform(camera);

    // Hide the mesh geometry when in raytracing mode
    if (this.geometry !== new THREE.BufferGeometry()) {
      this.geometry = new THREE.BufferGeometry();
    }
  }

  /**
   * Legacy method: Render entire projector using mesh
   */
  private renderMeshProjector(projector: HoloProjector, camera: THREE.Camera) {
    // Generate or reuse connected mesh geometry
    if (!this.connectedMeshGeometry || this.currentProjector !== projector) {
      if (this.connectedMeshGeometry && this.currentProjector !== projector) {
        this.connectedMeshGeometry.dispose();
        this.connectedMeshGeometry = null;
      }

      this.connectedMeshGeometry = this.generateConnectedMesh(projector);
      this.geometry = this.connectedMeshGeometry;
      this.geometry.attributes.position.needsUpdate = true;
      if (this.geometry.attributes.uv) {
        this.geometry.attributes.uv.needsUpdate = true;
      }
      console.log("HoloRenderer: Generated connected mesh geometry");
    } else if (this.geometry !== this.connectedMeshGeometry ||
               this.geometry === new THREE.BufferGeometry() ||
               !this.geometry.attributes.position) {
      // Restore mesh geometry if it was hidden for raytracing
      this.geometry = this.connectedMeshGeometry;
      this.geometry.attributes.position.needsUpdate = true;
    }

    // Update uniforms
    this.uniforms.rgbTexture.value = projector.rgbTexture;
    this.uniforms.depthTexture.value = projector.depthTexture;

    projector.updateMatrixWorld();
    this.uniforms.projectorMatrix.value.copy(projector.matrixWorld);

    this.uniforms.fx.value = projector.intrinsics.fx;
    this.uniforms.fy.value = projector.intrinsics.fy;
    this.uniforms.cx.value = projector.intrinsics.cx;
    this.uniforms.cy.value = projector.intrinsics.cy;

    this.uniforms.imageWidth.value = projector.width;
    this.uniforms.imageHeight.value = projector.height;

    this.uniforms.invZMin.value = projector.invDepthRange.min;
    this.uniforms.invZMax.value = projector.invDepthRange.max;
    this.uniforms.baseline.value = projector.invDepthRange.baseline ?? 1.0;

    this.currentProjector = projector;
  }

  /**
   * Generate connected mesh geometry from projector data
   */
  private generateConnectedMesh(projector: { width: number; height: number }): THREE.BufferGeometry {
    const width = projector.width;
    const height = projector.height;

    const numVertices = (width + 1) * (height + 1);
    const positions = new Float32Array(numVertices * 3);
    const uvs = new Float32Array(numVertices * 2);

    let vertexIndex = 0;
    for (let y = 0; y <= height; y++) {
      for (let x = 0; x <= width; x++) {
        uvs[vertexIndex * 2] = x / width;
        uvs[vertexIndex * 2 + 1] = y / height;

        positions[vertexIndex * 3] = 0;
        positions[vertexIndex * 3 + 1] = 0;
        positions[vertexIndex * 3 + 2] = 0;

        vertexIndex++;
      }
    }

    const numQuads = width * height;
    const indices = new Uint32Array(numQuads * 6);

    let indexCount = 0;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const topLeft = py * (width + 1) + px;
        const topRight = py * (width + 1) + (px + 1);
        const bottomLeft = (py + 1) * (width + 1) + px;
        const bottomRight = (py + 1) * (width + 1) + (px + 1);

        indices[indexCount++] = topLeft;
        indices[indexCount++] = bottomLeft;
        indices[indexCount++] = topRight;

        indices[indexCount++] = topRight;
        indices[indexCount++] = bottomLeft;
        indices[indexCount++] = bottomRight;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    return geometry;
  }

  // Mode switching
  public setRenderMode(mode: RenderMode): void {
    if (this.renderMode === mode) return;

    console.log(`HoloRenderer: Switching from ${this.renderMode} to ${mode}`);
    this.renderMode = mode;

    // Clean up old mode resources
    if (mode === 'mesh' && this.raycastPlane) {
      // PHASE 2: Remove from camera (parent is now camera, not projector)
      if (this.raycastPlane.parent) {
        this.raycastPlane.parent.remove(this.raycastPlane);
        console.log("RaycastPlane removed from camera");
      }
      this.raycastPlane.dispose();
      this.raycastPlane = null;
      console.log("RaycastPlane disposed and nulled in setRenderMode");
    }

    if (mode === 'raytracing' && this.connectedMeshGeometry) {
      // Don't dispose mesh geometry, just hide it
      this.geometry = new THREE.BufferGeometry();
    }
  }

  public getRenderMode(): RenderMode {
    return this.renderMode;
  }

  // Utility methods
  getActiveProjectors(): HoloProjector[] {
    return this.activeProjectors;
  }

  setGradientThreshold(threshold: number): void {
    this.uniforms.deltaInvZThreshold.value = threshold;
  }

  getGradientThreshold(): number {
    return this.uniforms.deltaInvZThreshold.value;
  }

  toggleDepthVisualization(): boolean {
    const newValue = this.uniforms.showDepth.value > 0.5 ? 0.0 : 1.0;
    this.uniforms.showDepth.value = newValue;
    return newValue > 0.5;
  }

  getDepthVisualization(): boolean {
    return this.uniforms.showDepth.value > 0.5;
  }

  dispose(): void {
    if (this.raycastPlane) {
      this.raycastPlane.dispose();
      this.raycastPlane = null;
    }

    if (this.connectedMeshGeometry) {
      this.connectedMeshGeometry.dispose();
      this.connectedMeshGeometry = null;
    }

    this.geometry.dispose();
    this.material.dispose();
  }
}
