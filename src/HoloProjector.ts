import * as THREE from "three";

import { HoloRenderer } from "./HoloRenderer";
import type { LifView } from "./types/lif";

export type HoloProjectorOptions = {
  // URL to fetch RGB image from. (default: undefined)
  rgbUrl?: string;
  // Raw RGB texture to use directly. (default: undefined)
  rgbTexture?: THREE.Texture;
  // URL to fetch depth map from. (default: undefined)
  depthUrl?: string;
  // Raw depth texture to use directly. (default: undefined)
  depthTexture?: THREE.Texture;
  // Camera intrinsics in pixel units
  intrinsics: {
    fx: number; // Focal length X in pixels
    fy: number; // Focal length Y in pixels
    cx: number; // Principal point X in pixels
    cy: number; // Principal point Y in pixels
  };
  // Inverse depth range mapping
  invDepthRange: {
    min: number; // Closest point (depth map value 1 or 255)
    max: number; // Furthest point (depth map value 0)
    baseline?: number; // Optional baseline in meters (for stereo depth)
  };
  // Image dimensions (required if using URLs)
  width?: number;
  height?: number;
  // Callback when loading is complete
  onLoad?: (projector: HoloProjector) => Promise<void> | void;
};

export class HoloProjector extends THREE.Object3D {
  // A Promise<HoloProjector> you can await to ensure loading is complete
  initialized: Promise<HoloProjector>;
  // A boolean indicating whether initialization is complete
  isInitialized = false;

  // RGB texture containing the color information
  rgbTexture: THREE.Texture;
  // Depth texture containing inverse depth values (0-1 or 0-255)
  depthTexture: THREE.Texture;

  // Camera intrinsics
  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
  };

  // Inverse depth range
  invDepthRange: {
    min: number;
    max: number;
    baseline?: number;
  };

  // Image dimensions
  width: number;
  height: number;

  // Frustum visualization (Group containing LineSegments)
  frustumHelper: THREE.Group;

  /**
   * Create a HoloProjector from a LIF view object
   * Automatically converts LIF rotation encoding to THREE.js quaternion
   * @param view - LIF view object with image, depth, intrinsics, and pose
   * @param options - Optional overrides for HoloProjector parameters
   * @returns HoloProjector instance with pose applied
   */
  static async fromLifView(
    view: LifView,
    options?: Partial<HoloProjectorOptions>,
  ): Promise<HoloProjector> {
    // Import the rotation conversion function
    const { lifRotationToQuaternion } = await import("./LifLoader");

    const projectorOptions: HoloProjectorOptions = {
      // Textures from blob URLs
      rgbUrl: view.image.url,
      depthUrl: view.inv_z_map.url,

      // Dimensions
      width: view.width_px,
      height: view.height_px,

      // Camera intrinsics (assuming centered principal point, square pixels)
      intrinsics: {
        fx: view.focal_px,
        fy: view.focal_px, // Square pixels
        cx: view.width_px / 2, // Centered principal point
        cy: view.height_px / 2,
      },

      // Inverse depth range (direct mapping)
      invDepthRange: {
        min: view.inv_z_map.min,
        max: view.inv_z_map.max,
        baseline: 1.0, // Default, can be overridden
      },

      // Merge any custom options
      ...options,
    };

    const projector = new HoloProjector(projectorOptions);

    // Apply camera pose from LIF data
    projector.position.set(
      view.position[0],
      view.position[1],
      view.position[2],
    );

    // Convert LIF rotation to THREE.js quaternion
    const quaternion = lifRotationToQuaternion(view.rotation);
    projector.quaternion.copy(quaternion);

    return projector;
  }

  constructor(options: HoloProjectorOptions) {
    super();

    console.log("HoloProjector: Constructing...");
    console.log("  Options:", options);

    this.intrinsics = { ...options.intrinsics };
    this.invDepthRange = { ...options.invDepthRange };

    // Initialize dimensions
    this.width = options.width || 0;
    this.height = options.height || 0;

    // Set up textures
    if (options.rgbTexture) {
      this.rgbTexture = options.rgbTexture;
      if (!this.width || !this.height) {
        this.width = this.rgbTexture.image?.width || this.width;
        this.height = this.rgbTexture.image?.height || this.height;
      }
    } else {
      this.rgbTexture = new THREE.Texture();
    }

    if (options.depthTexture) {
      this.depthTexture = options.depthTexture;
    } else {
      this.depthTexture = new THREE.Texture();
    }

    // Handle async initialization if URLs are provided
    if (options.rgbUrl || options.depthUrl) {
      this.initialized = this.asyncInitialize(options).then(async () => {
        this.isInitialized = true;
        if (options.onLoad) {
          const maybePromise = options.onLoad(this);
          if (maybePromise instanceof Promise) {
            await maybePromise;
          }
        }
        return this;
      });
    } else {
      this.isInitialized = true;
      this.initialized = Promise.resolve(this);
      if (options.onLoad) {
        const maybePromise = options.onLoad(this);
        if (maybePromise instanceof Promise) {
          this.initialized = maybePromise.then(() => this);
        }
      }
    }

    // Add auto-injection detection mesh
    this.add(createHoloRendererDetectionMesh());

    // Create frustum visualization
    this.frustumHelper = createFrustumHelper(this);
    this.frustumHelper.visible = false; // Hidden by default
    this.add(this.frustumHelper);
  }

  private async asyncInitialize(options: HoloProjectorOptions): Promise<void> {
    const loader = new THREE.TextureLoader();
    const promises: Promise<void>[] = [];

    // Load RGB texture
    if (options.rgbUrl) {
      const rgbUrl = options.rgbUrl;
      promises.push(
        new Promise<void>((resolve, reject) => {
          loader.load(
            rgbUrl,
            (texture) => {
              this.rgbTexture = texture;
              this.rgbTexture.colorSpace = THREE.SRGBColorSpace;
              this.rgbTexture.minFilter = THREE.LinearFilter;
              this.rgbTexture.magFilter = THREE.LinearFilter;
              if (!this.width || !this.height) {
                this.width = texture.image.width;
                this.height = texture.image.height;
              }
              resolve();
            },
            undefined,
            reject,
          );
        }),
      );
    }

    // Load depth texture
    if (options.depthUrl) {
      const depthUrl = options.depthUrl;
      promises.push(
        new Promise<void>((resolve, reject) => {
          loader.load(
            depthUrl,
            (texture) => {
              this.depthTexture = texture;
              this.depthTexture.colorSpace = THREE.LinearSRGBColorSpace;
              this.depthTexture.minFilter = THREE.NearestFilter;
              this.depthTexture.magFilter = THREE.NearestFilter;
              resolve();
            },
            undefined,
            reject,
          );
        }),
      );
    }

    await Promise.all(promises);
  }

  dispose(): void {
    this.rgbTexture.dispose();
    this.depthTexture.dispose();
  }
}

const EMPTY_GEOMETRY = new THREE.BufferGeometry();
const EMPTY_MATERIAL = new THREE.ShaderMaterial();

// Creates a frustum visualization for the holographic projector
function createFrustumHelper(projector: HoloProjector): THREE.Group {
  const { fx, fy, cx, cy } = projector.intrinsics;
  const { width, height } = projector;
  const {
    min: invZMin,
    max: invZMax,
    baseline = 1.0,
  } = projector.invDepthRange;

  // Calculate depths from inverse depth range
  const nearDepth = baseline / invZMin;
  const farDepth = baseline / invZMax;

  // Calculate 4 corners of the image in normalized camera coordinates
  // Top-left, top-right, bottom-right, bottom-left
  const corners = [
    [(0 - cx) / fx, (0 - cy) / fy], // Top-left
    [(width - cx) / fx, (0 - cy) / fy], // Top-right
    [(width - cx) / fx, (height - cy) / fy], // Bottom-right
    [(0 - cx) / fx, (height - cy) / fy], // Bottom-left
  ];

  // Create 8 vertices: 4 at near plane, 4 at far plane
  const vertices: number[] = [];

  // Near plane corners
  for (const [x, y] of corners) {
    vertices.push(x * nearDepth, y * nearDepth, -nearDepth);
  }

  // Far plane corners
  for (const [x, y] of corners) {
    vertices.push(x * farDepth, y * farDepth, -farDepth);
  }

  // Create line indices for frustum edges
  const indices: number[] = [];

  // Near plane rectangle (0-1-2-3-0)
  indices.push(0, 1, 1, 2, 2, 3, 3, 0);

  // Far plane rectangle (4-5-6-7-4)
  indices.push(4, 5, 5, 6, 6, 7, 7, 4);

  // Connecting lines from near to far (0-4, 1-5, 2-6, 3-7)
  indices.push(0, 4, 1, 5, 2, 6, 3, 7);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3),
  );
  geometry.setIndex(indices);

  const material = new THREE.LineBasicMaterial({
    color: 0x00ff00,
    opacity: 0.6,
    transparent: true,
  });

  const frustumLines = new THREE.LineSegments(geometry, material);

  // Add dashed lines from apex (origin) to near plane corners
  const apexVertices: number[] = [];
  // Origin point
  const origin = [0, 0, 0];

  // Lines from origin to each near plane corner (0-3)
  for (let i = 0; i < 4; i++) {
    apexVertices.push(...origin);
    apexVertices.push(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
  }

  const apexGeometry = new THREE.BufferGeometry();
  apexGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(apexVertices, 3),
  );

  const apexMaterial = new THREE.LineDashedMaterial({
    color: 0x00ff00,
    opacity: 0.6,
    transparent: true,
    dashSize: 0.1,
    gapSize: 0.05,
  });

  const apexLines = new THREE.LineSegments(apexGeometry, apexMaterial);
  apexLines.computeLineDistances(); // Required for dashed lines

  // Create a group to hold both line sets
  const group = new THREE.Group();
  group.add(frustumLines);
  group.add(apexLines);

  return group;
}

// Creates an empty mesh to hook into Three.js rendering.
// This is used to detect if a HoloRenderer is present in the scene.
// If not, one will be injected automatically.
function createHoloRendererDetectionMesh(): THREE.Mesh {
  const mesh = new THREE.Mesh(EMPTY_GEOMETRY, EMPTY_MATERIAL);
  mesh.frustumCulled = false;
  mesh.onBeforeRender = function (renderer, scene) {
    if (!scene.isScene) {
      // The HoloProjector is part of render call that doesn't have a Scene at its root
      // Don't auto-inject a renderer.
      this.removeFromParent();
      return;
    }

    // Check if the scene has a HoloRenderer instance
    let hasHoloRenderer = false;
    scene.traverse((c) => {
      if (c instanceof HoloRenderer) {
        hasHoloRenderer = true;
      }
    });

    if (!hasHoloRenderer) {
      // No holo renderer present in the scene, inject one.
      scene.add(
        new HoloRenderer({
          renderer,
          pointSize: 1.0, // 1.0 = perfect square tiling (no gaps/overlaps)
          maxStdDev: 2.0, // Not used for square rendering
        }),
      );
    }

    // Remove mesh to stop checking
    this.removeFromParent();
  };
  return mesh;
}
