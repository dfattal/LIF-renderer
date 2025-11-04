import * as THREE from "three";

import type { HoloProjector } from "./HoloProjector";
import holoFragment from "./shaders/holoFragment.glsl";
import holoVertex from "./shaders/holoVertex.glsl";

export type HoloRendererOptions = {
  // The THREE.WebGLRenderer instance
  renderer: THREE.WebGLRenderer;
  // Maximum standard deviation for Gaussian falloff
  maxStdDev?: number;
  // Base point size in pixels
  pointSize?: number;
  // Enable depth writing for proper occlusion
  depthWrite?: boolean;
};

// Geometry for rendering a single quad (2 triangles)
// Each instance will use this geometry to draw one pixel
const QUAD_VERTICES = new Float32Array([
  -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
]);

const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

export class HoloRenderer extends THREE.Mesh {
  renderer: THREE.WebGLRenderer;
  material: THREE.ShaderMaterial;
  uniforms: ReturnType<typeof HoloRenderer.makeUniforms>;

  maxStdDev: number;
  pointSize: number;

  // Track active projectors
  private activeProjectors: HoloProjector[] = [];
  private currentProjector: HoloProjector | null = null;

  // Store different geometry types for different modes
  private instancedGeometry: THREE.InstancedBufferGeometry;
  private connectedMeshGeometry: THREE.BufferGeometry | null = null;
  private currentMeshMode: number = 0; // 0=billboard, 1=connected mesh

  static EMPTY_TEXTURE = new THREE.Texture();

  constructor(options: HoloRendererOptions) {
    console.log("HoloRenderer: Constructing...");
    const uniforms = HoloRenderer.makeUniforms();
    const depthWrite = options.depthWrite ?? true; // Enable by default
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: holoVertex,
      fragmentShader: holoFragment,
      uniforms,
      transparent: true,
      premultipliedAlpha: true, // Better alpha blending with depth
      depthTest: true,
      depthWrite: depthWrite,
      side: THREE.DoubleSide,
    });

    // Create base geometry (will be instanced)
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(QUAD_VERTICES, 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(QUAD_INDICES, 1));
    geometry.instanceCount = 0; // Will be updated per projector

    super(geometry, material);

    // Store reference to instanced geometry
    this.instancedGeometry = geometry;

    // Disable frustum culling
    this.frustumCulled = false;

    this.renderer = options.renderer;
    this.material = material;
    this.uniforms = uniforms;

    this.maxStdDev = options.maxStdDev ?? 1.0;
    this.pointSize = options.pointSize ?? 2.0;

    console.log("HoloRenderer: Created successfully");
    console.log("  Vertex shader length:", holoVertex.length);
    console.log("  Fragment shader length:", holoFragment.length);
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
      baseline: { value: 1.0 }, // Baseline for stereo depth (default 1.0 = no baseline)

      // Rendering parameters
      maxStdDev: { value: 1.0 },
      pointSize: { value: 2.0 },
      meshMode: { value: 0.0 }, // 0 = billboard mode, 1 = connected mesh mode
      cullSteepFaces: { value: 1.0 }, // 1 = cull steep/back-facing surfaces, 0 = show all
    };
  }

  onBeforeRender(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) {
    // Find all HoloProjector instances in the scene
    this.activeProjectors = [];
    scene.traverse((obj) => {
      // Use duck typing to check for HoloProjector properties
      // since we can't import HoloProjector here (circular dependency)
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
      console.log("HoloRenderer: No active projectors found");
    }

    // Render each projector
    // Note: For multiple projectors, we'd need to render them separately
    // For now, we'll render the first one found
    if (this.activeProjectors.length > 0) {
      const projector = this.activeProjectors[0];
      this.renderProjector(projector, camera);
    } else {
      // No projectors, hide the geometry
      (this.geometry as THREE.InstancedBufferGeometry).instanceCount = 0;
    }
  }

  private renderProjector(projector: HoloProjector, camera: THREE.Camera) {
    const numPixels = projector.width * projector.height;

    // Switch geometry based on mesh mode
    if (this.currentMeshMode === 1) {
      // Connected mesh mode
      if (!this.connectedMeshGeometry || this.currentProjector !== projector) {
        // Generate connected mesh geometry
        this.connectedMeshGeometry = this.generateConnectedMesh(projector);
        this.geometry = this.connectedMeshGeometry;
        this.geometry.attributes.position.needsUpdate = true;
        if (this.geometry.attributes.uv) {
          this.geometry.attributes.uv.needsUpdate = true;
        }
        console.log("HoloRenderer: Switched to connected mesh geometry");
      } else if (this.geometry !== this.connectedMeshGeometry) {
        // Ensure we're using the connected mesh geometry
        this.geometry = this.connectedMeshGeometry;
        this.geometry.attributes.position.needsUpdate = true;
      }
    } else {
      // Billboard mode (instanced)
      if (this.geometry !== this.instancedGeometry) {
        this.geometry = this.instancedGeometry;
        this.geometry.attributes.position.needsUpdate = true;
      }
      (this.geometry as THREE.InstancedBufferGeometry).instanceCount = numPixels;
    }

    // Log only once when projector changes
    if (this.currentProjector !== projector) {
      console.log("HoloRenderer: Rendering projector");
      console.log("  Num pixels (instances):", numPixels);
      console.log(
        "  Image dimensions:",
        projector.width,
        "x",
        projector.height,
      );
      console.log("  RGB texture:", projector.rgbTexture);
      console.log("  Depth texture:", projector.depthTexture);
      console.log("  Intrinsics:", projector.intrinsics);
      console.log("  InvZ range:", projector.invDepthRange);
      this.currentProjector = projector;
    }

    // Update textures
    this.uniforms.rgbTexture.value = projector.rgbTexture;
    this.uniforms.depthTexture.value = projector.depthTexture;

    // Update projector transform
    projector.updateMatrixWorld();
    this.uniforms.projectorMatrix.value.copy(projector.matrixWorld);

    // Update camera intrinsics
    this.uniforms.fx.value = projector.intrinsics.fx;
    this.uniforms.fy.value = projector.intrinsics.fy;
    this.uniforms.cx.value = projector.intrinsics.cx;
    this.uniforms.cy.value = projector.intrinsics.cy;

    // Update image dimensions
    this.uniforms.imageWidth.value = projector.width;
    this.uniforms.imageHeight.value = projector.height;

    // Update inverse depth range
    this.uniforms.invZMin.value = projector.invDepthRange.min;
    this.uniforms.invZMax.value = projector.invDepthRange.max;
    this.uniforms.baseline.value = projector.invDepthRange.baseline ?? 1.0;

    // Update rendering parameters
    this.uniforms.maxStdDev.value = this.maxStdDev;
    this.uniforms.pointSize.value = this.pointSize;
  }

  // Get the list of active projectors being rendered
  getActiveProjectors(): HoloProjector[] {
    return this.activeProjectors;
  }

  // Set mesh mode (0 = billboard, 1 = connected mesh)
  setMeshMode(mode: number): void {
    console.log('HoloRenderer: Setting mesh mode to', mode);
    this.currentMeshMode = mode;
    if (mode === 1) {
      // Connected mesh mode
      this.uniforms.meshMode.value = 1.0;
      console.log('  meshMode uniform set to:', this.uniforms.meshMode.value);
      // Geometry will be swapped in renderProjector
    } else {
      // Billboard mode - use instanced geometry
      this.uniforms.meshMode.value = 0.0;
      console.log('  meshMode uniform set to:', this.uniforms.meshMode.value);
      if (this.geometry !== this.instancedGeometry) {
        this.geometry = this.instancedGeometry;
        this.geometry.attributes.position.needsUpdate = true;
      }
    }
    // Force material update
    this.material.needsUpdate = true;
  }

  // Cycle through mesh modes: 0 -> 1 -> 0
  cycleMeshMode(): number {
    const newMode = (this.currentMeshMode + 1) % 2;
    this.setMeshMode(newMode);
    return newMode;
  }

  // Get current mesh mode
  getMeshMode(): number {
    return this.currentMeshMode;
  }

  // Toggle steep face culling (for mesh mode)
  toggleSteepFaceCulling(): boolean {
    const newValue = this.uniforms.cullSteepFaces.value > 0.5 ? 0.0 : 1.0;
    this.uniforms.cullSteepFaces.value = newValue;
    return newValue > 0.5;
  }

  // Get steep face culling state
  getSteepFaceCulling(): boolean {
    return this.uniforms.cullSteepFaces.value > 0.5;
  }

  // Generate connected mesh geometry from projector data
  // Vertices are at pixel CORNERS (shared between neighbors)
  // Each pixel center is the center of a quad element
  private generateConnectedMesh(projector: HoloProjector): THREE.BufferGeometry {
    const width = projector.width;
    const height = projector.height;

    // Create vertex grid at pixel corners: (width+1) × (height+1) vertices
    // Corner (x,y) is shared by up to 4 pixels: (x-1,y-1), (x,y-1), (x-1,y), (x,y)
    const numVertices = (width + 1) * (height + 1);
    const positions = new Float32Array(numVertices * 3);
    const uvs = new Float32Array(numVertices * 2);

    // We'll compute positions in the shader, so initialize to zero
    // The shader will interpolate depth from the 4 surrounding pixel centers

    let vertexIndex = 0;
    for (let y = 0; y <= height; y++) {
      for (let x = 0; x <= width; x++) {
        // Store corner coordinates in UV
        // Corner (x, y) is at pixel coordinate (x, y) in the image
        // This will be used to compute the ray and sample surrounding pixels
        uvs[vertexIndex * 2] = x / width;
        uvs[vertexIndex * 2 + 1] = y / height;

        // Position will be computed in shader
        positions[vertexIndex * 3] = 0;
        positions[vertexIndex * 3 + 1] = 0;
        positions[vertexIndex * 3 + 2] = 0;

        vertexIndex++;
      }
    }

    // Create face indices: each pixel becomes a quad (2 triangles)
    // Pixel (px, py) uses corners at (px, py), (px+1, py), (px, py+1), (px+1, py+1)
    const numQuads = width * height;
    const indices = new Uint32Array(numQuads * 6);

    let indexCount = 0;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        // Corner indices for this pixel's quad
        const topLeft = py * (width + 1) + px;
        const topRight = py * (width + 1) + (px + 1);
        const bottomLeft = (py + 1) * (width + 1) + px;
        const bottomRight = (py + 1) * (width + 1) + (px + 1);

        // First triangle (top-left, bottom-left, top-right)
        indices[indexCount++] = topLeft;
        indices[indexCount++] = bottomLeft;
        indices[indexCount++] = topRight;

        // Second triangle (top-right, bottom-left, bottom-right)
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

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
