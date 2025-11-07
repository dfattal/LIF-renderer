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

    console.log("RaycastPlane created");
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
      sk2: { value: new THREE.Vector2(0, 0) },
      sl2: { value: new THREE.Vector2(0, 0) },
      roll2: { value: 0.0 },
      f2: { value: 500.0 },

      // Visual effects
      feathering: { value: 0.1 },
      background: { value: new THREE.Vector4(0.1, 0.1, 0.1, 1.0) },

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
      attribute vec4 aVertexPosition;
      attribute vec2 aTextureCoord;
      varying highp vec2 v_texcoord;

      void main(void) {
        gl_Position = projectionMatrix * modelViewMatrix * position;
        v_texcoord = uv;
      }
    `;
  }

  /**
   * Initialize the plane from a HoloProjector
   */
  public async initializeFromProjector(projector: HoloProjector): Promise<void> {
    this.projector = projector;

    // Determine view count (1 for mono, 2 for stereo)
    // For now, we only support mono (single view)
    this.viewCount = 1;

    // Update shader based on view count
    if (this.viewCount === 2) {
      (this.material as THREE.ShaderMaterial).fragmentShader = rayCastStereoLDI;
      (this.material as THREE.ShaderMaterial).needsUpdate = true;
    }

    // Load textures for all layers
    await this.loadLayerTextures(projector.lifLayers);

    // Calculate and set plane distance
    this.updatePlaneDistance();

    // Set initial uniform values
    this.updateStaticUniforms();

    console.log(`RaycastPlane initialized with ${projector.lifLayers.length} layers`);
  }

  /**
   * Load RGB and depth+mask textures for all layers
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

        console.log(`Layer ${i} textures loaded: ${layer.width}x${layer.height}`);
      } catch (error) {
        console.error(`Failed to load textures for layer ${i}:`, error);
      }
    }
  }

  /**
   * Calculate plane distance from projector: z = baseline_mm / invd
   */
  private updatePlaneDistance(): void {
    if (!this.projector) return;

    // Get inverse convergence distance
    const invd =
      this.projector.invDepthRange.baseline ?? 0.1;

    // Get baseline in mm (or use 1.0 as default)
    const baseline_mm = this.projector.invDepthRange.baseline ?? 1.0;

    // Calculate distance
    this.planeDistance = baseline_mm / invd;

    console.log(`Plane distance: ${this.planeDistance} (baseline: ${baseline_mm}, invd: ${invd})`);
  }

  /**
   * Update static uniforms that don't change every frame
   */
  private updateStaticUniforms(): void {
    if (!this.projector) return;

    const layers = this.projector.lifLayers;
    const numLayers = Math.min(layers.length, 4);

    // Update layer count
    this.uniforms.uNumLayers.value = numLayers;

    // Bind textures and set layer-specific uniforms
    for (let i = 0; i < numLayers; i++) {
      const layer = layers[i];
      const textures = this.layerTextures.get(i);

      if (!textures) continue;

      // Bind textures
      this.uniforms.uImage.value[i] = textures.rgb;
      this.uniforms.uDisparityMap.value[i] = textures.depthMask;

      // Set inverse depth range
      this.uniforms.invZmin.value[i] = layer.invDepthRange.min;
      this.uniforms.invZmax.value[i] = layer.invDepthRange.max;

      // Set focal length
      this.uniforms.f1.value[i] = layer.intrinsics.fx;

      // Set image resolution
      this.uniforms.iRes.value[i] = new THREE.Vector2(layer.width, layer.height);
    }

    // Set original image dimensions (from first layer)
    if (layers[0]) {
      this.uniforms.iResOriginal.value.set(layers[0].width, layers[0].height);
    }

    // Set source view position (from projector)
    this.uniforms.uViewPosition.value.copy(this.projector.position);

    // Set source view transforms
    // For now, use default values (no rotation/skew)
    this.uniforms.sk1.value.set(0, 0);
    this.uniforms.sl1.value.set(0, 0);
    this.uniforms.roll1.value = 0;

    console.log("Static uniforms updated");
  }

  /**
   * Update view-dependent uniforms (called every frame)
   */
  public updateDynamicUniforms(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    if (!this.projector) return;

    // Update camera position (in world space, will need to convert to normalized space)
    this.uniforms.uFacePosition.value.copy(camera.position);

    // Update viewport resolution
    const canvas = renderer.domElement;
    this.uniforms.oRes.value.set(canvas.width, canvas.height);

    // Calculate viewport scale
    const viewportScale = calculateViewportScale(
      this.uniforms.iResOriginal.value.x,
      this.uniforms.iResOriginal.value.y,
      canvas.width,
      canvas.height
    );

    // Update focal length with viewport scaling
    if (this.projector.lifLayers[0]) {
      this.uniforms.f2.value = this.projector.lifLayers[0].intrinsics.fx * viewportScale;
    }

    // Update time for animations
    this.uniforms.uTime.value = performance.now() / 1000;

    // Camera transforms (for now, use defaults)
    this.uniforms.sk2.value.set(0, 0);
    this.uniforms.sl2.value.set(0, 0);
    this.uniforms.roll2.value = 0;
  }

  /**
   * Position the plane at the correct distance from projector and make it face the camera
   */
  public updatePlaneTransform(camera: THREE.Camera): void {
    if (!this.projector) return;

    // Position plane in front of projector
    this.position.copy(this.projector.position);
    this.position.z += this.planeDistance;

    // Make plane face the camera
    this.lookAt(camera.position);
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
