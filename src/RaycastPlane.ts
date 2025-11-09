import * as THREE from "three";
import type { HoloProjector } from "./HoloProjector";
import type { LayerData } from "./types/lif";
import rayCastMonoLDI from "./shaders/rayCastMonoLDI.glsl";
import rayCastStereoLDI from "./shaders/rayCastStereoLDI.glsl";
import { createDepthMaskTexture, createRGBTexture, calculateViewportScale } from "./utils/textureUtils";

/**
 * RaycastPlane: A THREE.Mesh that renders LIF layers using fragment shader raycasting
 * Positioned at z = baseline_mm / invd from the projector
 */
export class RaycastPlane extends THREE.Mesh {
  private projector: HoloProjector | null = null;
  private projectors: HoloProjector[] = []; // Store all projectors for stereo
  private viewCount: number = 1;
  private uniforms: { [uniform: string]: THREE.IUniform };
  public planeDistance: number = 1.0;
  public trackedCamera: THREE.Camera | null = null;
  private layerTextures: Map<number, { rgb: THREE.Texture; depthMask: THREE.Texture }> = new Map();

  constructor(width: number = 1, height: number = 1) {
    // Create plane geometry
    const geometry = new THREE.PlaneGeometry(width, height);

    // Initialize uniforms (will be populated later)
    const uniforms = RaycastPlane.createUniforms();

    // Create shader material (mono by default, will be updated)
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: RaycastPlane.createVertexShader(),
      fragmentShader: rayCastMonoLDI,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
    });

    super(geometry, material);

    this.uniforms = uniforms;
    this.name = "RaycastPlane";

    // IMPORTANT: Force rendering even when attached to camera
    this.frustumCulled = false;
    this.matrixAutoUpdate = true;

    // Store reference to camera (will be set during initialization)
    this.trackedCamera = null;
    this.planeDistance = 1.0;

    // onBeforeRender will be set up after initialization when we know the camera
    // (removed auto-update code - camera child handles this automatically)

    // Add red border helper for debugging
    const borderGeometry = new THREE.EdgesGeometry(geometry);
    const borderMaterial = new THREE.LineBasicMaterial({
      color: 0xff0000,
      linewidth: 5,
      depthTest: false,
      depthWrite: false
    });
    const border = new THREE.LineSegments(borderGeometry, borderMaterial);
    border.renderOrder = 999; // Render on top
    this.add(border);

    console.log("RaycastPlane created with red border for debugging");
  }

  /**
   * Creates the default uniforms for the raycast shader
   */
  private static createUniforms(): { [uniform: string]: THREE.IUniform } {
    return {
      // Viewport info
      iResOriginal: { value: new THREE.Vector2(1280, 800) },
      oRes: { value: new THREE.Vector2(800, 600) },
      uTime: { value: 0.0 },

      // Rendering camera (where we're viewing from)
      uFacePosition: { value: new THREE.Vector3(0, 0, 0) },
      uFaceRotation: { value: new THREE.Matrix3() }, // Camera rotation matrix
      sk2: { value: new THREE.Vector2(0, 0) },
      sl2: { value: new THREE.Vector2(0, 0) },
      roll2: { value: 0.0 },
      f2: { value: 500.0 },

      // Visual effects
      feathering: { value: 0.1 },
      background: { value: new THREE.Vector4(0, 0, 0, 0) }, // Transparent background

      // Mono view data (arrays for up to 4 layers)
      uImage: { value: Array(4).fill(null) },
      uDisparityMap: { value: Array(4).fill(null) },
      invZmin: { value: Array(4).fill(0.1) },
      invZmax: { value: Array(4).fill(0.01) },
      uViewPosition: { value: new THREE.Vector3(0, 0, 0) },
      uViewRotation: { value: new THREE.Matrix3() }, // NEW: Projector rotation matrix
      sk1: { value: new THREE.Vector2(0, 0) }, // DEPRECATED: kept for compatibility
      sl1: { value: new THREE.Vector2(0, 0) }, // DEPRECATED: kept for compatibility
      roll1: { value: 0.0 }, // DEPRECATED: kept for compatibility
      f1: { value: Array(4).fill(500.0) },
      iRes: { value: Array(4).fill(new THREE.Vector2(1280, 800)) },
      uNumLayers: { value: 0 },

      // Stereo view data (duplicated with L/R suffixes)
      uImageL: { value: Array(4).fill(null) },
      uDisparityMapL: { value: Array(4).fill(null) },
      invZminL: { value: Array(4).fill(0.1) },
      invZmaxL: { value: Array(4).fill(0.01) },
      uViewPositionL: { value: new THREE.Vector3(0, 0, 0) },
      uViewRotationL: { value: new THREE.Matrix3() }, // NEW: Left projector rotation matrix
      sk1L: { value: new THREE.Vector2(0, 0) }, // DEPRECATED
      sl1L: { value: new THREE.Vector2(0, 0) }, // DEPRECATED
      roll1L: { value: 0.0 }, // DEPRECATED
      f1L: { value: Array(4).fill(500.0) },
      iResL: { value: Array(4).fill(new THREE.Vector2(1280, 800)) },
      uNumLayersL: { value: 0 },

      uImageR: { value: Array(4).fill(null) },
      uDisparityMapR: { value: Array(4).fill(null) },
      invZminR: { value: Array(4).fill(0.1) },
      invZmaxR: { value: Array(4).fill(0.01) },
      uViewPositionR: { value: new THREE.Vector3(0, 0, 0) },
      uViewRotationR: { value: new THREE.Matrix3() }, // NEW: Right projector rotation matrix
      sk1R: { value: new THREE.Vector2(0, 0) }, // DEPRECATED
      sl1R: { value: new THREE.Vector2(0, 0) }, // DEPRECATED
      roll1R: { value: 0.0 }, // DEPRECATED
      f1R: { value: Array(4).fill(500.0) },
      iResR: { value: Array(4).fill(new THREE.Vector2(1280, 800)) },
      uNumLayersR: { value: 0 },
    };
  }

  /**
   * Creates a simple pass-through vertex shader
   */
  private static createVertexShader(): string {
    return `
      varying highp vec2 v_texcoord;

      void main(void) {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        v_texcoord = uv;
      }
    `;
  }

  /**
   * Initialize the plane from HoloProjector(s)
   * Pass single projector for mono, or array of 2 projectors for stereo
   * @param projector - Single projector or array of projectors
   * @param invd - Optional inverse convergence distance from stereo_render_data
   */
  public async initializeFromProjector(
    projector: HoloProjector | HoloProjector[],
    invd?: number
  ): Promise<void> {
    // Handle array or single projector
    this.projectors = Array.isArray(projector) ? projector : [projector];
    this.projector = this.projectors[0]; // Store first projector for reference

    // Store invd for plane distance calculation
    if (invd !== undefined) {
      (this as any).invdFromStereoData = invd;
      console.log(`RaycastPlane: Using invd from stereo_render_data: ${invd}`);
    }

    // Determine view count based on number of projectors
    // For now, force mono rendering even if we have multiple projectors
    this.viewCount = 1; // Force mono for now
    console.log(`RaycastPlane: Initializing with ${this.projectors.length} projector(s), forcing mono rendering`);

    // Always use mono shader for now
    console.log('RaycastPlane: Using mono shader');

    // Load textures for all layers from all projectors
    // For now, always use mono rendering (single view)
    await this.loadLayerTextures(this.projectors[0].lifLayers);

    // Calculate and set plane distance
    this.updatePlaneDistance();

    // Set initial uniform values
    this.updateStaticUniforms();

    console.log(`RaycastPlane initialized with ${this.projector.lifLayers.length} layers per view`);
  }

  /**
   * Load RGB and depth+mask textures for all layers (mono)
   */
  private async loadLayerTextures(layers: LayerData[]): Promise<void> {
    const maxLayers = Math.min(layers.length, 4);

    for (let i = 0; i < maxLayers; i++) {
      const layer = layers[i];

      if (!layer.rgbUrl || !layer.depthUrl) {
        console.warn(`Layer ${i} missing texture URLs`);
        continue;
      }

      try {
        // Load RGB texture
        const rgbTexture = await createRGBTexture(layer.rgbUrl);

        // Load depth+mask combined texture
        const depthMaskTexture = await createDepthMaskTexture(
          layer.depthUrl,
          layer.maskUrl
        );

        this.layerTextures.set(i, {
          rgb: rgbTexture,
          depthMask: depthMaskTexture,
        });

        // Also set textures on the layer object for raycasting
        layer.rgbTexture = rgbTexture;
        layer.depthTexture = depthMaskTexture; // Store combined depth+mask texture

        console.log(`Layer ${i} textures loaded: ${layer.width}x${layer.height}`);
      } catch (error) {
        console.error(`Failed to load textures for layer ${i}:`, error);
      }
    }
  }

  /**
   * Load RGB and depth+mask textures for stereo (left and right views)
   */
  private async loadStereoLayerTextures(layersL: LayerData[], layersR: LayerData[]): Promise<void> {
    const maxLayers = Math.min(layersL.length, layersR.length, 4);
    console.log(`Loading stereo textures: ${maxLayers} layers per view`);

    for (let i = 0; i < maxLayers; i++) {
      const layerL = layersL[i];
      const layerR = layersR[i];

      if (!layerL.rgbUrl || !layerL.depthUrl || !layerR.rgbUrl || !layerR.depthUrl) {
        console.warn(`Layer ${i} missing texture URLs in one or both views`);
        continue;
      }

      try {
        // Load LEFT view textures
        const rgbTextureL = await createRGBTexture(layerL.rgbUrl);
        const depthMaskTextureL = await createDepthMaskTexture(
          layerL.depthUrl,
          layerL.maskUrl
        );

        // Load RIGHT view textures
        const rgbTextureR = await createRGBTexture(layerR.rgbUrl);
        const depthMaskTextureR = await createDepthMaskTexture(
          layerR.depthUrl,
          layerR.maskUrl
        );

        // Store with stereo marker (use negative indices for right view)
        this.layerTextures.set(i, {
          rgb: rgbTextureL,
          depthMask: depthMaskTextureL,
        });
        this.layerTextures.set(i + 100, { // Right view offset by 100
          rgb: rgbTextureR,
          depthMask: depthMaskTextureR,
        });

        console.log(`Layer ${i} stereo textures loaded: L=${layerL.width}x${layerL.height}, R=${layerR.width}x${layerR.height}`);
      } catch (error) {
        console.error(`Failed to load stereo textures for layer ${i}:`, error);
      }
    }
  }

  /**
   * Calculate plane distance from baseline and invd
   */
  private updatePlaneDistance(): void {
    if (!this.projector) return;

    // Use a very large distance to place the raycast plane far from camera
    // This avoids depth precision issues and ensures it's always rendered
    this.planeDistance = 1e6; // 1 million units

    console.log(`Plane distance set to: ${this.planeDistance} units (far plane for raycast rendering)`);
  }

  /**
   * Update plane size to match camera FOV at the current distance
   * Call this on initialization and window resize
   */
  public updatePlaneSizeFromCamera(camera: THREE.Camera): void {
    if (!this.projector) return;

    // Calculate plane size based on camera FOV at plane distance
    // Formula: size = 2 * distance * tan(fov / 2)
    if ((camera as THREE.PerspectiveCamera).fov) {
      const fovRadians = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
      const aspect = (camera as THREE.PerspectiveCamera).aspect;

      const planeHeight = 2 * this.planeDistance * Math.tan(fovRadians / 2);
      const planeWidth = planeHeight * aspect;

      // Update the plane geometry to match
      const newGeometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
      this.geometry.dispose();
      this.geometry = newGeometry;

      // Recreate the border with new geometry
      const children = this.children.filter(c => c.type === 'LineSegments');
      children.forEach(c => {
        this.remove(c);
        (c as any).geometry?.dispose();
      });
      const borderGeometry = new THREE.EdgesGeometry(newGeometry);
      const borderMaterial = new THREE.LineBasicMaterial({
        color: 0xff0000,
        linewidth: 5,
        depthTest: false,
        depthWrite: false
      });
      const border = new THREE.LineSegments(borderGeometry, borderMaterial);
      border.renderOrder = 999;
      this.add(border);

      console.log(`RaycastPlane: Plane size updated (${planeWidth.toFixed(2)}m x ${planeHeight.toFixed(2)}m at ${this.planeDistance.toFixed(2)}m)`);
    }
  }

  /**
   * Update static uniforms that don't change every frame
   */
  private updateStaticUniforms(): void {
    if (!this.projector) return;

    const layers = this.projector.lifLayers;
    const numLayers = Math.min(layers.length, 4);

    if (this.viewCount === 1) {
      // Mono rendering
      this.uniforms.uNumLayers.value = numLayers;

      for (let i = 0; i < numLayers; i++) {
        const layer = layers[i];
        const textures = this.layerTextures.get(i);

        if (!textures) continue;

        // Bind textures
        this.uniforms.uImage.value[i] = textures.rgb;
        this.uniforms.uDisparityMap.value[i] = textures.depthMask;

        // Set inverse depth range (scale by 1/baseline_mm to convert to normalized space)
        const baseline_mm = layer.invDepthRange.baseline ?? 0.045;
        this.uniforms.invZmin.value[i] = layer.invDepthRange.min / baseline_mm;
        this.uniforms.invZmax.value[i] = layer.invDepthRange.max / baseline_mm;

        // Set focal length (in pixels)
        this.uniforms.f1.value[i] = layer.intrinsics.fx;

        // Set image resolution (in pixels)
        this.uniforms.iRes.value[i] = new THREE.Vector2(layer.width, layer.height);
      }

      // NOTE: uViewPosition and uViewRotation are now set by updateProjectorPose()
      // which transforms from world space to camera-local space
      // Initialize to identity matrix (will be overwritten by updateProjectorPose in render loop)
      this.uniforms.uViewRotation.value.identity();
      this.uniforms.uViewPosition.value.set(0, 0, 0);

      // View transform parameters (skew, slant, roll)
      // These are currently zero because:
      // - frustum_skew is handled via principal point offset (cx, cy)
      // - rotation is handled via projector's quaternion transform (via uViewRotation)
      this.uniforms.sk1.value.set(0, 0);
      this.uniforms.sl1.value.set(0, 0);
      this.uniforms.roll1.value = 0;

    } else if (this.viewCount === 2) {
      // Stereo rendering
      this.uniforms.uNumLayersL.value = numLayers;
      this.uniforms.uNumLayersR.value = numLayers;

      for (let i = 0; i < numLayers; i++) {
        const layer = layers[i];

        // LEFT view (index i)
        const texturesL = this.layerTextures.get(i);
        if (texturesL) {
          this.uniforms.uImageL.value[i] = texturesL.rgb;
          this.uniforms.uDisparityMapL.value[i] = texturesL.depthMask;
          this.uniforms.invZminL.value[i] = layer.invDepthRange.min;
          this.uniforms.invZmaxL.value[i] = layer.invDepthRange.max;
          this.uniforms.f1L.value[i] = layer.intrinsics.fx;
          this.uniforms.iResL.value[i] = new THREE.Vector2(layer.width, layer.height);
        }

        // RIGHT view (index i + 100)
        const texturesR = this.layerTextures.get(i + 100);
        if (texturesR) {
          this.uniforms.uImageR.value[i] = texturesR.rgb;
          this.uniforms.uDisparityMapR.value[i] = texturesR.depthMask;
          this.uniforms.invZminR.value[i] = layer.invDepthRange.min;
          this.uniforms.invZmaxR.value[i] = layer.invDepthRange.max;
          this.uniforms.f1R.value[i] = layer.intrinsics.fx;
          this.uniforms.iResR.value[i] = new THREE.Vector2(layer.width, layer.height);
        }
      }

      // Set LEFT and RIGHT view positions from projectors
      this.uniforms.uViewPositionL.value.copy(this.projectors[0].position);
      this.uniforms.sk1L.value.set(0, 0);
      this.uniforms.sl1L.value.set(0, 0);
      this.uniforms.roll1L.value = 0;

      if (this.projectors.length > 1) {
        this.uniforms.uViewPositionR.value.copy(this.projectors[1].position);
        this.uniforms.sk1R.value.set(0, 0);
        this.uniforms.sl1R.value.set(0, 0);
        this.uniforms.roll1R.value = 0;
      }
    }

    // Set iResOriginal to physical plane size (same as oRes)
    // This is calculated in updatePlaneDistance() as:
    // planeWidth = (layer.width * planeDistance) / fx
    // planeHeight = (layer.height * planeDistance) / fy
    if (layers[0]) {
      const planeGeometry = this.geometry as THREE.PlaneGeometry;
      const planeWidth = planeGeometry.parameters.width;
      const planeHeight = planeGeometry.parameters.height;
      this.uniforms.iResOriginal.value.set(planeWidth, planeHeight);
    }

    console.log(`RaycastPlane: Static uniforms ready (${this.viewCount} view(s), ${numLayers} layer(s))`);
  }

  /**
   * Update the projector data (textures and intrinsics) when switching views
   * This allows changing which view is being rendered without recreating the RaycastPlane
   */
  public async updateProjectorData(projector: HoloProjector): Promise<void> {
    if (!projector || !projector.lifLayers || projector.lifLayers.length === 0) {
      console.warn('RaycastPlane: Invalid projector or no layers');
      return;
    }

    this.projector = projector;

    // Reload textures for the new projector's layers
    await this.loadLayerTextures(projector.lifLayers);

    // Update static uniforms with new projector data
    this.updateStaticUniforms();

    console.log('RaycastPlane: Updated to new projector data');
  }

  /**
   * Update projector pose uniforms in camera-local coordinates
   * Transforms projector world-space pose to camera-local space
   */
  public updateProjectorPose(projector: HoloProjector, camera: THREE.Camera): void {
    if (!projector) return;

    // Get camera's inverse matrix (world → camera transform)
    const cameraMatrixInv = camera.matrixWorldInverse;

    // Update projector's world matrix
    projector.updateMatrixWorld();

    // Transform position: world → camera space
    const posInCameraSpace = projector.position.clone().applyMatrix4(cameraMatrixInv);

    // Flip Z coordinate: THREE.js camera looks down -Z, shader expects +Z forward
    // So we negate Z when passing to shader
    this.uniforms.uViewPosition.value.set(
      posInCameraSpace.x,
      posInCameraSpace.y,
      -posInCameraSpace.z  // Z-flip for coordinate system conversion
    );

    // Store for debugging
    (this as any)._debugProjectorWorldPos = projector.position.clone();
    (this as any)._debugProjectorCameraPos = posInCameraSpace.clone();
    (this as any)._debugProjectorShaderPos = this.uniforms.uViewPosition.value.clone();

    // Transform rotation: world → camera space
    // Extract rotation matrix from projector's world matrix
    const projectorRotationWorld = new THREE.Matrix3().setFromMatrix4(projector.matrixWorld);

    // Extract rotation matrix from camera's inverse matrix
    const cameraRotationInv = new THREE.Matrix3().setFromMatrix4(cameraMatrixInv);

    // Combine: camera_rotation_inv * projector_rotation_world
    const rotationInCameraSpace = new THREE.Matrix3().multiplyMatrices(
      cameraRotationInv,
      projectorRotationWorld
    );

    this.uniforms.uViewRotation.value.copy(rotationInCameraSpace);
  }

  /**
   * Update view-dependent uniforms (called every frame)
   * These represent the render camera (where we're viewing from)
   */
  public updateDynamicUniforms(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    if (!this.projector) return;

    // PHASE 2: Camera position in camera-local space is origin (canvas is camera child)
    // The raycast shader expects both C1 (projector) and C2 (camera) in the same coordinate system
    this.uniforms.uFacePosition.value.set(0, 0, 0);

    // Get raycast plane physical size (in meters)
    const planeGeometry = this.geometry as THREE.PlaneGeometry;
    const planeWidth = planeGeometry.parameters.width;
    const planeHeight = planeGeometry.parameters.height;

    // Set oRes AND iResOriginal to the physical plane size
    this.uniforms.oRes.value.set(planeWidth, planeHeight);
    this.uniforms.iResOriginal.value.set(planeWidth, planeHeight);

    // Calculate focal length f2 from camera FOV and plane size
    // Formula: f2 = (planeHeight / 2) / tan(fov / 2)
    if ((camera as THREE.PerspectiveCamera).fov) {
      const fovRadians = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
      this.uniforms.f2.value = (planeHeight / 2) / Math.tan(fovRadians / 2);
    } else {
      // Fallback if not a perspective camera
      this.uniforms.f2.value = this.planeDistance;
    }

    // PHASE 2: Camera rotation in camera-local space is identity (canvas is camera child)
    // The camera has no rotation relative to itself
    this.uniforms.uFaceRotation.value.identity();

    // Still set legacy uniforms for compatibility (though shader now uses uFaceRotation)
    this.uniforms.sk2.value.set(0, 0);
    this.uniforms.sl2.value.set(0, 0);
    this.uniforms.roll2.value = 0;

    // Update time for animations
    this.uniforms.uTime.value = performance.now() / 1000;
  }

  /**
   * Position the plane at fixed distance from camera, perpendicular to camera Z axis
   * The plane follows the camera and always faces it
   */
  public updatePlaneTransform(camera: THREE.Camera): void {
    if (!this.projector) return;

    // Get camera forward direction
    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyQuaternion(camera.quaternion);

    // Position plane at distance along camera's forward direction
    this.position.copy(camera.position);
    this.position.addScaledVector(forward, this.planeDistance);

    // Make plane face the camera (perpendicular to camera Z axis)
    this.quaternion.copy(camera.quaternion);
  }

  /**
   * Set background color
   */
  public setBackground(r: number, g: number, b: number, a: number = 1.0): void {
    this.uniforms.background.value.set(r, g, b, a);
  }

  /**
   * Set feathering amount for edge softening
   */
  public setFeathering(amount: number): void {
    this.uniforms.feathering.value = amount;
  }

  /**
   * Debug: Log all shader uniforms (call from 'U' key handler)
   */
  public logUniforms(): void {
    console.log('=== RaycastPlane Shader Uniforms ===');
    console.log('Viewport:');
    console.log('  iResOriginal:', this.uniforms.iResOriginal.value.toArray());
    console.log('  oRes:', this.uniforms.oRes.value.toArray());
    console.log('  uTime:', this.uniforms.uTime.value);

    console.log('\nCamera (Face):');
    console.log('  uFacePosition:', this.uniforms.uFacePosition.value.toArray());
    console.log('  uFaceRotation:', this.uniforms.uFaceRotation.value.elements);
    console.log('  sk2:', this.uniforms.sk2.value.toArray());
    console.log('  sl2:', this.uniforms.sl2.value.toArray());
    console.log('  roll2:', this.uniforms.roll2.value);
    console.log('  f2:', this.uniforms.f2.value);

    console.log('\nProjector (View):');
    console.log('  World Position:', (this as any)._debugProjectorWorldPos?.toArray() || 'N/A');
    console.log('  Camera-Local Position (before Z-flip):', (this as any)._debugProjectorCameraPos?.toArray() || 'N/A');
    console.log('  Shader Position (uViewPosition, after Z-flip):', this.uniforms.uViewPosition.value.toArray());
    console.log('  uViewRotation:', this.uniforms.uViewRotation.value.elements);
    console.log('  sk1:', this.uniforms.sk1.value.toArray());
    console.log('  sl1:', this.uniforms.sl1.value.toArray());
    console.log('  roll1:', this.uniforms.roll1.value);
    console.log('  uNumLayers:', this.uniforms.uNumLayers.value);

    console.log('\nLayers:');
    for (let i = 0; i < this.uniforms.uNumLayers.value; i++) {
      console.log(`  Layer ${i}:`);
      console.log('    uImage:', this.uniforms.uImage.value[i] ? 'Texture' : 'null');
      console.log('    uDisparityMap:', this.uniforms.uDisparityMap.value[i] ? 'Texture' : 'null');
      console.log('    f1:', this.uniforms.f1.value[i]);
      console.log('    iRes:', this.uniforms.iRes.value[i].toArray());
      console.log('    invZmin:', this.uniforms.invZmin.value[i]);
      console.log('    invZmax:', this.uniforms.invZmax.value[i]);
    }

    console.log('\nVisual:');
    console.log('  feathering:', this.uniforms.feathering.value);
    console.log('  background:', this.uniforms.background.value);
  }

  /**
   * Clean up resources
   */
  public dispose(): void {
    // Dispose textures
    this.layerTextures.forEach(({ rgb, depthMask }) => {
      rgb.dispose();
      depthMask.dispose();
    });
    this.layerTextures.clear();

    // Dispose geometry and material
    this.geometry.dispose();
    (this.material as THREE.ShaderMaterial).dispose();

    console.log("RaycastPlane disposed");
  }
}
