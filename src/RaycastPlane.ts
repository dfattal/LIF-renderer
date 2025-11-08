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
  private planeDistance: number = 1.0;
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
      sk1: { value: new THREE.Vector2(0, 0) },
      sl1: { value: new THREE.Vector2(0, 0) },
      roll1: { value: 0.0 },
      f1: { value: Array(4).fill(500.0) },
      iRes: { value: Array(4).fill(new THREE.Vector2(1280, 800)) },
      uNumLayers: { value: 0 },

      // Stereo view data (duplicated with L/R suffixes)
      uImageL: { value: Array(4).fill(null) },
      uDisparityMapL: { value: Array(4).fill(null) },
      invZminL: { value: Array(4).fill(0.1) },
      invZmaxL: { value: Array(4).fill(0.01) },
      uViewPositionL: { value: new THREE.Vector3(0, 0, 0) },
      sk1L: { value: new THREE.Vector2(0, 0) },
      sl1L: { value: new THREE.Vector2(0, 0) },
      roll1L: { value: 0.0 },
      f1L: { value: Array(4).fill(500.0) },
      iResL: { value: Array(4).fill(new THREE.Vector2(1280, 800)) },
      uNumLayersL: { value: 0 },

      uImageR: { value: Array(4).fill(null) },
      uDisparityMapR: { value: Array(4).fill(null) },
      invZminR: { value: Array(4).fill(0.1) },
      invZmaxR: { value: Array(4).fill(0.01) },
      uViewPositionR: { value: new THREE.Vector3(0, 0, 0) },
      sk1R: { value: new THREE.Vector2(0, 0) },
      sl1R: { value: new THREE.Vector2(0, 0) },
      roll1R: { value: 0.0 },
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

    // Get baseline in meters
    const baseline_mm = this.projector.invDepthRange.baseline ?? 0.045; // Default 45mm = 0.045m

    // Get inverse convergence distance from stereo_render_data or fallback
    const invd = (this as any).invdFromStereoData ??
                 (this.projector.invDepthRange.min + this.projector.invDepthRange.max) / 2;

    // Calculate distance: z = baseline_mm / invd
    this.planeDistance = baseline_mm / invd;

    console.log(`Plane distance calculated: ${this.planeDistance}m (baseline: ${baseline_mm}m, invd: ${invd})`);
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

      console.log(`Plane size updated from camera FOV:`, {
        distance: this.planeDistance,
        fov: (camera as THREE.PerspectiveCamera).fov,
        aspect,
        planeSize: [planeWidth, planeHeight]
      });
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

      // Set source view position (projector position in THREE.js world space)
      // Note: This is already in meters, scaled by baseline_mm during projector creation
      this.uniforms.uViewPosition.value.copy(this.projector.position);

      // View transform parameters (skew, slant, roll)
      // These are currently zero because:
      // - frustum_skew is handled via principal point offset (cx, cy)
      // - rotation is handled via projector's quaternion transform
      this.uniforms.sk1.value.set(0, 0);
      this.uniforms.sl1.value.set(0, 0);
      this.uniforms.roll1.value = 0;

      console.log('Mono view uniforms set:', {
        uViewPosition: this.uniforms.uViewPosition.value.toArray(),
        f1: this.uniforms.f1.value,
        iRes: this.uniforms.iRes.value.map((v: any) => [v.x, v.y]),
        invZranges: layers.map((l, i) => [this.uniforms.invZmin.value[i], this.uniforms.invZmax.value[i]]),
        numLayers
      });

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

    console.log(`Static uniforms updated for ${this.viewCount} view(s)`);
  }

  /**
   * Update view-dependent uniforms (called every frame)
   * These represent the render camera (where we're viewing from)
   */
  public updateDynamicUniforms(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    if (!this.projector) return;

    // Update render camera position with Z flipped
    this.uniforms.uFacePosition.value.set(
      camera.position.x,
      camera.position.y,
      -camera.position.z
    );

    // Get raycast plane physical size (in meters)
    const planeGeometry = this.geometry as THREE.PlaneGeometry;
    const planeWidth = planeGeometry.parameters.width;
    const planeHeight = planeGeometry.parameters.height;

    // Set oRes to the physical plane size
    this.uniforms.oRes.value.set(planeWidth, planeHeight);

    // Calculate focal length f2 from camera FOV and plane size
    // Formula: f2 = (planeHeight / 2) / tan(fov / 2)
    if ((camera as THREE.PerspectiveCamera).fov) {
      const fovRadians = THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov);
      this.uniforms.f2.value = (planeHeight / 2) / Math.tan(fovRadians / 2);
    } else {
      // Fallback if not a perspective camera
      this.uniforms.f2.value = this.planeDistance;
    }

    // Pass camera rotation matrix directly to shader
    // Get the full rotation matrix from camera quaternion
    const cameraMatrix = new THREE.Matrix4();
    cameraMatrix.makeRotationFromQuaternion(camera.quaternion);
    const R = new THREE.Matrix3().setFromMatrix4(cameraMatrix);

    // Both THREE.js Matrix3 and GLSL mat3 are column-major, so direct copy works
    // THREE.js will upload the matrix elements in the correct order for GLSL
    this.uniforms.uFaceRotation.value.copy(R);

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
