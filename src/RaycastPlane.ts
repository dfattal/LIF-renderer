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

  // Base geometry dimensions for scale calculations
  private baseGeometryWidth: number = 1.0;
  private baseGeometryHeight: number = 1.0;

  // Frustum offset for asymmetric frustums (public for access from HoloRenderer)
  public frustumOffsetX: number = 0;
  public frustumOffsetY: number = 0;

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

    // Store base geometry dimensions for scale calculations
    this.baseGeometryWidth = width;
    this.baseGeometryHeight = height;

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

      // VR Controller hit visualization
      uControllerHit1: { value: new THREE.Vector4(0, 0, 0, 0) }, // (uv.x, uv.y, layer, active)
      uControllerHit2: { value: new THREE.Vector4(0, 0, 0, 0) }, // (uv.x, uv.y, layer, active)
      uPatchRadius: { value: 0.05 }, // Gaussian radius (5% of image size)
      uPatchColor: { value: new THREE.Vector3(1, 0, 0) }, // Red color
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
    // Start with mono by default, can be toggled with setViewMode()
    this.viewCount = 1; // Start mono
    console.log(`RaycastPlane: Initializing with ${this.projectors.length} projector(s), starting in mono mode`);

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
  public updatePlaneSizeFromCamera(camera: THREE.Camera, eyeLabel?: string): void {
    if (!this.projector) return;

    let planeWidth: number;
    let planeHeight: number;
    let offsetX = 0;
    let offsetY = 0;

    // For XR cameras (identified by eyeLabel), always extract from projection matrix
    // For regular desktop cameras, use direct properties
    if (eyeLabel) {
      // XR camera - extract asymmetric frustum from projection matrix
      const fovTanAngles = this.computeFovTanAngles(camera);

      // Calculate plane dimensions at plane distance using tan angles
      // tanRight and tanLeft are distances from center, so width = distance from left edge to right edge
      planeWidth = this.planeDistance * (fovTanAngles.tanRight - fovTanAngles.tanLeft);
      // tanUp and tanDown: tanUp is positive (above center), tanDown is negative (below center)
      planeHeight = this.planeDistance * (fovTanAngles.tanUp - fovTanAngles.tanDown);

      // Calculate offset for asymmetric frustum (plane center offset from camera forward axis)
      // Center is midpoint between left and right edges
      offsetX = this.planeDistance * (fovTanAngles.tanRight + fovTanAngles.tanLeft) / 2;
      // Center is midpoint between top and bottom edges
      offsetY = this.planeDistance * (fovTanAngles.tanUp + fovTanAngles.tanDown) / 2;

      console.log(`${eyeLabel}: Asymmetric frustum - tanLeft=${fovTanAngles.tanLeft.toFixed(3)}, tanRight=${fovTanAngles.tanRight.toFixed(3)}, tanUp=${fovTanAngles.tanUp.toFixed(3)}, tanDown=${fovTanAngles.tanDown.toFixed(3)}`);
      console.log(`${eyeLabel}: Plane offset (${offsetX.toFixed(2)}m, ${offsetY.toFixed(2)}m)`);
    } else {
      // Regular perspective camera with direct FOV property (desktop mode - assume symmetric)
      const perspCam = camera as THREE.PerspectiveCamera;
      const fovRadians = THREE.MathUtils.degToRad(perspCam.fov);
      const aspect = perspCam.aspect;
      planeHeight = 2 * this.planeDistance * Math.tan(fovRadians / 2);
      planeWidth = planeHeight * aspect;
      // Desktop cameras are symmetric, no offset needed
    }

    // Update the plane geometry to match
    const newGeometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    this.geometry.dispose();
    this.geometry = newGeometry;

    // Store base geometry dimensions (first time only, or when explicitly recreating)
    this.baseGeometryWidth = planeWidth;
    this.baseGeometryHeight = planeHeight;

    // Store the offset for use when positioning the plane
    this.frustumOffsetX = offsetX;
    this.frustumOffsetY = offsetY;

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

    const eyeInfo = eyeLabel ? ` [${eyeLabel}]` : '';
    console.log(`RaycastPlane${eyeInfo}: Canvas plane size ${planeWidth.toFixed(2)}m x ${planeHeight.toFixed(2)}m at distance ${this.planeDistance.toFixed(2)}m`);
  }

  /**
   * Compute FOV tan angles from projection matrix (handles asymmetric frustums)
   */
  public computeFovTanAngles(camera: THREE.Camera): {
    tanUp: number;
    tanDown: number;
    tanLeft: number;
    tanRight: number;
  } {
    const projMatrix = camera.projectionMatrix;

    // Extract relevant values from projection matrix
    const m00 = projMatrix.elements[0];
    const m05 = projMatrix.elements[5];
    const m08 = projMatrix.elements[8];
    const m09 = projMatrix.elements[9];

    // Check for division by zero
    if (Math.abs(m00) < 0.0001 || Math.abs(m05) < 0.0001) {
      console.warn("Near-zero values in projection matrix, may cause NaN in FOV calculation");
    }

    // Extract frustum bounds in normalized device coordinates
    const left = (1 - m08) / m00;
    const right = (1 + m08) / m00;
    const bottom = (1 - m09) / m05;
    const top = (1 + m09) / m05;

    return {
      tanUp: top,
      tanDown: -bottom,
      tanLeft: -left,
      tanRight: right
    };
  }

  /**
   * Update frustum dimensions and offsets from camera projection matrix
   * Uses scale transform instead of geometry recreation for efficiency
   * Call this per-frame for eye-tracked displays with dynamic frustums
   */
  public updateFrustumFromCamera(camera: THREE.Camera, eyeLabel?: string): void {
    // Compute frustum tan angles from projection matrix
    const fovTanAngles = this.computeFovTanAngles(camera);

    // Calculate new dimensions at plane distance
    const newWidth = this.planeDistance * (fovTanAngles.tanRight - fovTanAngles.tanLeft);
    const newHeight = this.planeDistance * (fovTanAngles.tanUp - fovTanAngles.tanDown);

    // Update scale to match new dimensions (no geometry recreation needed!)
    this.scale.set(
      newWidth / this.baseGeometryWidth,
      newHeight / this.baseGeometryHeight,
      1.0
    );

    // Update frustum offsets for asymmetric frustums
    this.frustumOffsetX = this.planeDistance * (fovTanAngles.tanRight + fovTanAngles.tanLeft) / 2;
    this.frustumOffsetY = this.planeDistance * (fovTanAngles.tanUp + fovTanAngles.tanDown) / 2;

    // Optional debug logging
    if (eyeLabel) {
      console.log(`${eyeLabel}: Dynamic frustum update - scale=(${this.scale.x.toFixed(3)}, ${this.scale.y.toFixed(3)}), offset=(${this.frustumOffsetX.toFixed(2)}m, ${this.frustumOffsetY.toFixed(2)}m)`);
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
      // Stereo rendering - use layers from both projectors
      const layersL = this.projectors[0]?.lifLayers || [];
      const layersR = this.projectors[1]?.lifLayers || [];
      const numLayersL = Math.min(layersL.length, 4);
      const numLayersR = Math.min(layersR.length, 4);

      this.uniforms.uNumLayersL.value = numLayersL;
      this.uniforms.uNumLayersR.value = numLayersR;

      for (let i = 0; i < Math.max(numLayersL, numLayersR); i++) {
        // LEFT view (index i)
        if (i < numLayersL) {
          const layerL = layersL[i];
          const texturesL = this.layerTextures.get(i);
          if (texturesL) {
            this.uniforms.uImageL.value[i] = texturesL.rgb;
            this.uniforms.uDisparityMapL.value[i] = texturesL.depthMask;
            const baseline_mm_L = layerL.invDepthRange.baseline ?? 0.045;
            this.uniforms.invZminL.value[i] = layerL.invDepthRange.min / baseline_mm_L;
            this.uniforms.invZmaxL.value[i] = layerL.invDepthRange.max / baseline_mm_L;
            this.uniforms.f1L.value[i] = layerL.intrinsics.fx;
            this.uniforms.iResL.value[i] = new THREE.Vector2(layerL.width, layerL.height);
          }
        }

        // RIGHT view (index i + 100)
        if (i < numLayersR) {
          const layerR = layersR[i];
          const texturesR = this.layerTextures.get(i + 100);
          if (texturesR) {
            this.uniforms.uImageR.value[i] = texturesR.rgb;
            this.uniforms.uDisparityMapR.value[i] = texturesR.depthMask;
            const baseline_mm_R = layerR.invDepthRange.baseline ?? 0.045;
            this.uniforms.invZminR.value[i] = layerR.invDepthRange.min / baseline_mm_R;
            this.uniforms.invZmaxR.value[i] = layerR.invDepthRange.max / baseline_mm_R;
            this.uniforms.f1R.value[i] = layerR.intrinsics.fx;
            this.uniforms.iResR.value[i] = new THREE.Vector2(layerR.width, layerR.height);
          }
        }
      }

      // NOTE: uViewPositionL/R and uViewRotationL/R are now set by updateProjectorPoses()
      // Initialize to identity/zero (will be overwritten in render loop)
      this.uniforms.uViewPositionL.value.set(0, 0, 0);
      this.uniforms.uViewRotationL.value.identity();
      this.uniforms.sk1L.value.set(0, 0);
      this.uniforms.sl1L.value.set(0, 0);
      this.uniforms.roll1L.value = 0;

      this.uniforms.uViewPositionR.value.set(0, 0, 0);
      this.uniforms.uViewRotationR.value.identity();
      this.uniforms.sk1R.value.set(0, 0);
      this.uniforms.sl1R.value.set(0, 0);
      this.uniforms.roll1R.value = 0;
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
   * Update all projector poses in stereo mode (called for both L and R projectors)
   */
  public updateProjectorPoses(camera: THREE.Camera): void {
    // Get camera's inverse matrix (world → camera transform)
    const cameraMatrixInv = camera.matrixWorldInverse;
    const cameraRotationInv = new THREE.Matrix3().setFromMatrix4(cameraMatrixInv);

    if (this.viewCount === 1) {
      // Mono mode: update single projector
      if (this.projector) {
        this.updateProjectorPose(this.projector, camera);
      }
    } else if (this.viewCount === 2) {
      // Stereo mode: update both projectors (L and R)
      if (this.projectors.length >= 2) {
        const projectorL = this.projectors[0];
        const projectorR = this.projectors[1];

        // Update left projector
        projectorL.updateMatrixWorld();
        const posL = projectorL.position.clone().applyMatrix4(cameraMatrixInv);
        this.uniforms.uViewPositionL.value.set(posL.x, posL.y, -posL.z); // Z-flip

        const rotL = new THREE.Matrix3().setFromMatrix4(projectorL.matrixWorld);
        const rotLInCameraSpace = new THREE.Matrix3().multiplyMatrices(cameraRotationInv, rotL);
        this.uniforms.uViewRotationL.value.copy(rotLInCameraSpace);

        // Update right projector
        projectorR.updateMatrixWorld();
        const posR = projectorR.position.clone().applyMatrix4(cameraMatrixInv);
        this.uniforms.uViewPositionR.value.set(posR.x, posR.y, -posR.z); // Z-flip

        const rotR = new THREE.Matrix3().setFromMatrix4(projectorR.matrixWorld);
        const rotRInCameraSpace = new THREE.Matrix3().multiplyMatrices(cameraRotationInv, rotR);
        this.uniforms.uViewRotationR.value.copy(rotRInCameraSpace);
      }
    }
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

    // Get raycast plane ACTUAL physical size (base geometry × scale, in meters)
    const planeGeometry = this.geometry as THREE.PlaneGeometry;
    const planeWidth = planeGeometry.parameters.width * this.scale.x;
    const planeHeight = planeGeometry.parameters.height * this.scale.y;

    // Set oRes AND iResOriginal to the actual scaled plane size
    this.uniforms.oRes.value.set(planeWidth, planeHeight);
    this.uniforms.iResOriginal.value.set(planeWidth, planeHeight);

    // Calculate focal length f2 from actual plane geometry and distance
    // For a plane at distance d with height h, if the camera sees the full plane:
    // tan(fov/2) = (h/2) / d, so f2 = d (for symmetric frustum)
    // For VR asymmetric frustums, we derive f2 from projection matrix:
    const fovTanAngles = this.computeFovTanAngles(camera);
    const tanHalfFovY = (fovTanAngles.tanUp - fovTanAngles.tanDown) / 2;

    // f2 = (planeHeight / 2) / tan(halfFovY)
    // This ensures f2 matches the actual camera-to-plane geometry
    if (tanHalfFovY > 0.0001) {
      this.uniforms.f2.value = (planeHeight / 2) / tanHalfFovY;
    } else {
      // Fallback
      this.uniforms.f2.value = this.planeDistance;
    }

    // PHASE 2: Camera rotation in camera-local space is identity (canvas is camera child)
    // The camera has no rotation relative to itself
    this.uniforms.uFaceRotation.value.identity();

    // Compute skew values (tangent angles) from frustum offsets
    // sk2.x = horizontal skew (tanSkewX), sk2.y = vertical skew (tanSkewY)
    // These represent the tangent of the angle from camera center to principal point
    const tanSkewX = this.frustumOffsetX / this.planeDistance;
    const tanSkewY = this.frustumOffsetY / this.planeDistance;
    this.uniforms.sk2.value.set(tanSkewX, tanSkewY);

    // Still set legacy uniforms for compatibility
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
   * Set VR controller hit information for shader visualization
   * @param hits - Map of controller index → hit info
   */
  public setControllerHits(hits: Map<number, any>): void {
    // Update controller 1 hit uniform
    const hit1 = hits.get(0);
    if (hit1 && hit1.hit) {
      this.uniforms.uControllerHit1.value.set(
        hit1.uv.x,
        hit1.uv.y,
        hit1.layer,
        1.0 // Active
      );
    } else {
      this.uniforms.uControllerHit1.value.w = 0.0; // Inactive
    }

    // Update controller 2 hit uniform
    const hit2 = hits.get(1);
    if (hit2 && hit2.hit) {
      this.uniforms.uControllerHit2.value.set(
        hit2.uv.x,
        hit2.uv.y,
        hit2.layer,
        1.0 // Active
      );
    } else {
      this.uniforms.uControllerHit2.value.w = 0.0; // Inactive
    }
  }

  /**
   * Toggle between mono and stereo rendering modes
   * @returns The new view mode ('mono' or 'stereo')
   */
  public async toggleViewMode(): Promise<'mono' | 'stereo'> {
    if (this.projectors.length < 2) {
      console.warn('RaycastPlane: Cannot enable stereo mode - only 1 projector available');
      return 'mono';
    }

    // Toggle between 1 (mono) and 2 (stereo)
    const oldViewCount = this.viewCount;
    this.viewCount = this.viewCount === 1 ? 2 : 1;
    const mode = this.viewCount === 1 ? 'mono' : 'stereo';

    // If switching to stereo, load textures for both projectors
    if (this.viewCount === 2 && oldViewCount === 1) {
      console.log('RaycastPlane: Loading stereo textures...');
      await this.loadStereoLayerTextures(
        this.projectors[0].lifLayers,
        this.projectors[1].lifLayers
      );
      // Update uniforms with stereo data
      this.updateStaticUniforms();
    }

    // Switch fragment shader (vertex shader stays the same)
    const fragmentShader = this.viewCount === 1 ? rayCastMonoLDI : rayCastStereoLDI;

    const material = this.material as THREE.ShaderMaterial;
    material.fragmentShader = fragmentShader;
    material.needsUpdate = true;

    console.log(`RaycastPlane: Switched to ${mode} mode (${this.viewCount} view${this.viewCount > 1 ? 's' : ''})`);
    return mode;
  }

  /**
   * Get the current view mode
   */
  public getViewMode(): 'mono' | 'stereo' {
    return this.viewCount === 1 ? 'mono' : 'stereo';
  }

  /**
   * Get the number of projectors available
   */
  public getProjectorCount(): number {
    return this.projectors.length;
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
