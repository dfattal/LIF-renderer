// LifLoader.ts - TypeScript port of LIF file format loader
import * as THREE from "three";

import type { HoloProjector, HoloProjectorOptions } from "./HoloProjector";
import type { LifData, LifView } from "./types/lif";

/**
 * Converts LIF rotation encoding to THREE.js Quaternion
 * LIF rotation format: [sl.x, sl.y, roll]
 * - Forward vector: normalize(vec3(sl.x, sl.y, 1))
 * - Roll: rotation around forward axis
 */
export function lifRotationToQuaternion(
  rotation: [number, number, number],
): THREE.Quaternion {
  console.log('lifRotationToQuaternion input:', rotation, 'type:', typeof rotation, 'isArray:', Array.isArray(rotation));

  // Handle case where rotation might be an object with properties
  let slX: number, slY: number, roll: number;

  if (Array.isArray(rotation)) {
    // Legacy format: [sl.x, sl.y, roll]
    [slX, slY, roll] = rotation;
  } else if (typeof rotation === 'object' && rotation !== null) {
    // New format: { rotation_slant: {x, y}, roll_degrees: number }
    const rotObj = rotation as any;

    if (rotObj.rotation_slant) {
      // Extract from rotation_slant object
      slX = rotObj.rotation_slant.x ?? 0;
      slY = rotObj.rotation_slant.y ?? 0;
      // Convert degrees to radians
      roll = (rotObj.roll_degrees ?? 0) * (Math.PI / 180);
      console.log('Extracted from rotation_slant format:', { slX, slY, roll_degrees: rotObj.roll_degrees, roll_radians: roll });
    } else {
      // Try numeric indices as fallback
      slX = rotObj[0] ?? rotObj.x ?? 0;
      slY = rotObj[1] ?? rotObj.y ?? 0;
      roll = rotObj[2] ?? rotObj.roll ?? 0;
      console.log('Extracted from object properties:', { slX, slY, roll });
    }
  } else {
    console.error('Invalid rotation format:', rotation);
    throw new Error('Rotation must be an array [slX, slY, roll] or object with rotation_slant');
  }

  // Calculate forward vector from steering parameters
  // LIF convention: forward = (slX, slY, 1) means looking in +Z direction
  // THREE.js convention: cameras look down -Z axis
  // So we need to NEGATE the Z component to convert from LIF to THREE.js
  const lifForward = new THREE.Vector3(slX, slY, 1);
  const threeForward = new THREE.Vector3(slX, slY, -1).normalize(); // Flip Z!

  // THREE.js camera default: looks down -Z axis
  const defaultForward = new THREE.Vector3(0, 0, -1);

  // Calculate rotation to align default forward with THREE.js forward
  const axis = new THREE.Vector3()
    .crossVectors(defaultForward, threeForward)
    .normalize();
  const angle = Math.acos(
    Math.max(-1, Math.min(1, defaultForward.dot(threeForward))),
  ); // Clamp for numerical stability

  // Handle edge case: forward aligned with ±Z axis (cross product is zero)
  let quaternion: THREE.Quaternion;
  if (axis.lengthSq() < 0.0001) {
    // Forward is aligned with +Z or -Z (after negation)
    if (threeForward.z > 0) {
      // Forward points at +Z, need 180° rotation around Y
      quaternion = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0),
        Math.PI,
      );
    } else {
      // Forward points at -Z, no rotation needed
      quaternion = new THREE.Quaternion();
    }
  } else {
    quaternion = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  }

  // Apply roll around the forward axis (use THREE.js forward for roll)
  const rollQuat = new THREE.Quaternion().setFromAxisAngle(threeForward, roll);
  quaternion.premultiply(rollQuat);

  console.log('Rotation conversion:', {
    lifForward: lifForward.toArray(),
    threeForward: threeForward.toArray(),
    quaternion: quaternion.toArray(),
  });

  return quaternion;
}

/**
 * Helper function to create HoloProjector from LIF view
 * Handles all necessary conversions and parameter mapping
 */
export async function createHoloProjectorFromLifView(
  view: LifView,
  options?: Partial<HoloProjectorOptions>,
  baselineMeters: number = 1.0,
): Promise<HoloProjector> {
  // Dynamic import to avoid circular dependency
  const { HoloProjector } = await import("./HoloProjector");

  // Calculate principal point from frustum_skew if available
  // Formula: cx = width/2 - skew.x * fx, cy = height/2 - skew.y * fy
  let cx: number, cy: number;

  if (view.frustum_skew) {
    // Handle frustum_skew as either array [x, y] or object {x, y}
    const skewX = Array.isArray(view.frustum_skew) ? view.frustum_skew[0] : view.frustum_skew.x;
    const skewY = Array.isArray(view.frustum_skew) ? view.frustum_skew[1] : view.frustum_skew.y;

    cx = view.width_px / 2 - skewX * view.focal_px;
    cy = view.height_px / 2 - skewY * view.focal_px;
    console.log('Computed principal point from frustum_skew:', {
      skew: { x: skewX, y: skewY },
      centered: [view.width_px / 2, view.height_px / 2],
      offset: [skewX * view.focal_px, skewY * view.focal_px],
      final: [cx, cy]
    });
  } else {
    // Default to centered principal point
    cx = view.width_px / 2;
    cy = view.height_px / 2;
    console.log('Using centered principal point (no frustum_skew):', { cx, cy });
  }

  const projectorOptions: HoloProjectorOptions = {
    // Textures from blob URLs
    rgbUrl: view.image.url,
    depthUrl: view.inv_z_map.url,

    // Dimensions
    width: view.width_px,
    height: view.height_px,

    // Camera intrinsics (square pixels assumed: fx = fy)
    intrinsics: {
      fx: view.focal_px,
      fy: view.focal_px, // Square pixels
      cx: cx,
      cy: cy,
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

  const projector: HoloProjector = new HoloProjector(projectorOptions);

  console.log('createHoloProjectorFromLifView - view data:', {
    position: view.position,
    rotation: view.rotation,
    baseline: baselineMeters,
  });

  // Apply camera pose from LIF data
  // IMPORTANT: LIF positions are normalized relative to baseline
  // Must multiply by baseline to get THREE.js units (meters)
  if (view.position && Array.isArray(view.position)) {
    projector.position.set(
      (view.position[0] ?? 0) * baselineMeters,
      (view.position[1] ?? 0) * baselineMeters,
      (view.position[2] ?? 0) * baselineMeters,
    );
    console.log('Set position (scaled by baseline):', projector.position);
  } else if (view.position && typeof view.position === 'object') {
    // Handle case where position might be an object {x, y, z}
    const pos = view.position as any;
    projector.position.set(
      (pos.x ?? pos[0] ?? 0) * baselineMeters,
      (pos.y ?? pos[1] ?? 0) * baselineMeters,
      (pos.z ?? pos[2] ?? 0) * baselineMeters,
    );
    console.log('Set position from object (scaled by baseline):', projector.position);
  } else {
    console.warn('No valid position found in view, using (0,0,0):', view.position);
  }

  // Convert LIF rotation to THREE.js quaternion
  const quaternion = lifRotationToQuaternion(view.rotation);
  projector.quaternion.copy(quaternion);
  console.log('Set quaternion:', projector.quaternion);

  return projector;
}

// --- LIF Binary File Loader ---

class BinaryStream {
  private dataView: DataView;
  public offset: number = 0;

  constructor(arrayBuffer: ArrayBuffer) {
    this.dataView = new DataView(arrayBuffer);
  }

  readBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(this.dataView.buffer, this.offset, length);
    this.offset += length;
    return bytes;
  }

  readUInt16(): number {
    const value = this.dataView.getUint16(this.offset, false);
    this.offset += 2;
    return value;
  }

  readUInt32(): number {
    const value = this.dataView.getUint32(this.offset, false);
    this.offset += 4;
    return value;
  }
}

class Field {
  fieldType: number;
  fieldDataSize: number;
  fieldData: Uint8Array;

  constructor(fieldType: number = -1, data: Uint8Array = new Uint8Array()) {
    this.fieldType = fieldType;
    this.fieldDataSize = data.byteLength;
    this.fieldData = data;
  }

  toBlob(): Blob {
    return new Blob([this.fieldData]);
  }

  toObjectUrl(): string {
    return URL.createObjectURL(this.toBlob());
  }

  toString(): string {
    return new TextDecoder().decode(this.fieldData);
  }
}

class Metadata {
  fields: Field[] = [];
  fullSize: number = 0;
  regionOffset: number = 0;
  fieldCount: number = 0;

  addField(field: Field): void {
    this.fields.push(field);
  }

  getFieldByType(fieldType: number): Field | undefined {
    return this.fields.find((field) => field.fieldType === fieldType);
  }

  getJsonMeta(): unknown {
    const JSON_META = 7;
    const JSON_META_NEW = 8;
    const metaField =
      this.getFieldByType(JSON_META_NEW) || this.getFieldByType(JSON_META);
    if (!metaField) {
      throw new Error("Failed to extract LIF meta");
    }
    return JSON.parse(metaField.toString());
  }
}

export class LifLoader {
  views: LifView[] | null = null;
  stereo_render_data: unknown = null;
  animations: unknown = null;

  constructor() {}

  /**
   * Loads a LIF file and extracts its metadata, views, and stereo rendering data.
   * @param file - The LIF file to be loaded.
   * @returns The parsed views and stereo rendering data.
   */
  async load(file: File): Promise<LifData> {
    const arrayBuffer = await file.arrayBuffer();
    const metadata = await this._parseBinary(arrayBuffer);
    const lifJson = metadata.getJsonMeta();
    console.log("LIF JSON:", lifJson);

    // Replace legacy keys with standardized names.
    const result = this.replaceKeys(
      lifJson,
      [
        "albedo",
        "disparity",
        "inv_z_dist",
        "max_disparity",
        "min_disparity",
        "inv_z_dist_min",
        "inv_z_dist_max",
      ],
      ["image", "inv_z_map", "inv_z_map", "max", "min", "max", "min"],
    );

    // Process views and store them in this.views
    this.views = await this._processViews(result, metadata, arrayBuffer);

    // Store stereo rendering data separately
    this.stereo_render_data = result.stereo_render_data;

    // Attach baseline_mm to the return data
    const returnData: any = {
      views: this.views,
      stereo_render_data: this.stereo_render_data,
    };

    if ((lifJson as any).baseline_mm !== undefined) {
      returnData.baseline_mm = (lifJson as any).baseline_mm;
    }

    return returnData;
  }

  /**
   * Returns the processed views.
   * @returns The processed views stored in this.views.
   */
  getViews(): LifView[] {
    if (!this.views) {
      throw new Error("Views have not been loaded yet. Call load() first.");
    }
    return this.views;
  }

  /**
   * Returns the stereo rendering data.
   * @returns The stereo rendering data stored in this.stereo_render_data.
   */
  getStereoRenderData(): unknown {
    if (!this.stereo_render_data) {
      throw new Error(
        "Stereo render data has not been loaded yet. Call load() first.",
      );
    }
    return this.stereo_render_data;
  }

  /**
   * Returns the animations data.
   * @returns The animations data stored in this.animations.
   */
  getAnimations(): unknown {
    if (!this.animations) {
      throw new Error(
        "Animations have not been loaded yet. Call load() first.",
      );
    }
    return this.animations;
  }

  // --- Private Methods ---

  private async _parseBinary(arrayBuffer: ArrayBuffer): Promise<Metadata> {
    const fullSize = arrayBuffer.byteLength;
    const stream = new BinaryStream(arrayBuffer);

    // Check magic end marker.
    stream.offset = fullSize - 2;
    const endMarker = stream.readUInt16();
    if (endMarker !== 0x1e1a) {
      throw new Error("Not a LIF file");
    }

    stream.offset = fullSize - 6;
    const regionOffset = stream.readUInt32();
    stream.offset = fullSize - regionOffset;

    const metadata = new Metadata();
    metadata.fieldCount = stream.readUInt32();
    for (let i = 0; i < metadata.fieldCount; i++) {
      const fieldType = stream.readUInt32();
      const fieldDataSize = stream.readUInt32();
      const fieldData = stream.readBytes(fieldDataSize);
      metadata.addField(new Field(fieldType, fieldData));
    }
    metadata.regionOffset = regionOffset;
    metadata.fullSize = fullSize;
    return metadata;
  }

  private replaceKeys(
    obj: any,
    oldKeys: string[],
    newKeys: string[],
  ): any {
    if (typeof obj !== "object" || obj === null) return obj;
    const newObj: any = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        const index = oldKeys.indexOf(key);
        const updatedKey = index !== -1 ? newKeys[index] : key;
        newObj[updatedKey] = this.replaceKeys(obj[key], oldKeys, newKeys);
      }
    }
    return Array.isArray(obj) ? Object.values(newObj) : newObj;
  }

  private async getImageDimensions(
    url: string,
  ): Promise<{ width: number; height: number }> {
    const img = new Image();

    return new Promise((resolve, reject) => {
      img.onload = () => {
        resolve({ width: img.width, height: img.height });
      };

      img.onerror = () => {
        reject(new Error("Failed to load image"));
      };

      img.src = url;
    });
  }

  private async _processViews(
    result: any,
    metadata: Metadata,
    arrayBuffer: ArrayBuffer,
  ): Promise<LifView[]> {
    if (!result.views) return [];

    const makeUrls = (obj: any) => {
      if (obj.image) {
        if (obj.image.blob_id === -1) {
          const rgbBlob = new Blob([arrayBuffer], { type: "image/jpeg" });
          obj.image.url = URL.createObjectURL(rgbBlob);
        } else {
          const field = metadata.getFieldByType(obj.image.blob_id);
          if (field) {
            const rgbBlob = field.toBlob();
            obj.image.url = URL.createObjectURL(rgbBlob);
          }
        }
      }

      if (obj.inv_z_map) {
        const field = metadata.getFieldByType(obj.inv_z_map.blob_id);
        if (field) {
          const invZBlob = field.toBlob();
          obj.inv_z_map.url = URL.createObjectURL(invZBlob);
        }
      }

      if (obj.mask) {
        const field = metadata.getFieldByType(obj.mask.blob_id);
        if (field) {
          const maskBlob = field.toBlob();
          obj.mask.url = URL.createObjectURL(maskBlob);
        }
      }
    };

    for (const view of result.views) {
      makeUrls(view);

      // Legacy support: calculate dimensions if not already provided.
      if (!view.width_px) {
        // prior to 5.3
        const dims = await this.getImageDimensions(view.image.url);
        view.width_px = dims.width;
        view.height_px = dims.height;
        view.focal_px =
          view.camera_data.focal_ratio_to_width * dims.width;
        view.position = view.camera_data.position;
        view.frustum_skew = view.camera_data.frustum_skew;
        view.rotation = view.camera_data.rotation;
        view.inv_z_map.max /= -view.camera_data.focal_ratio_to_width;
        view.inv_z_map.min /= -view.camera_data.focal_ratio_to_width;
      }

      let outpaint_width_px: number, outpaint_height_px: number, camera_data: any;
      if (!view.layers_top_to_bottom && view.layered_depth_image_data) {
        view.layers_top_to_bottom =
          view.layered_depth_image_data.layers_top_to_bottom;
        outpaint_width_px =
          view.layered_depth_image_data.outpainting_added_width_px;
        outpaint_height_px =
          view.layered_depth_image_data.outpainting_added_height_px;
        camera_data = view.camera_data;
        delete view.camera_data;
      }

      if (view.layers_top_to_bottom) {
        for (const layer of view.layers_top_to_bottom) {
          makeUrls(layer);
          if (camera_data) {
            layer.camera_data = camera_data;
            layer.outpainting_added_width_px = outpaint_width_px;
            layer.outpainting_added_height_px = outpaint_height_px;
            layer.inv_z_map.min /= 1 + outpaint_width_px / view.width_px;
            layer.inv_z_map.max /= 1 + outpaint_width_px / view.width_px;
          }
          if (layer.outpainting_added_width_px) {
            outpaint_width_px = layer.outpainting_added_width_px;
            outpaint_height_px = layer.outpainting_added_height_px;
            layer.width_px = view.width_px + outpaint_width_px;
            layer.height_px = view.height_px + outpaint_height_px;
            layer.focal_px = view.focal_px;
            layer.inv_z_map.max /= -layer.camera_data.focal_ratio_to_width;
            layer.inv_z_map.min /= -layer.camera_data.focal_ratio_to_width;
            delete layer.camera_data;
            delete layer.outpainting_added_width_px;
            delete layer.outpainting_added_height_px;
            delete view.layered_depth_image_data;
            delete view.camera_data;
          }
        }
      }
    }

    return result.views;
  }
}

/**
 * Result of loading a LIF file with projectors and optional orbit center
 */
export interface LoadLifFileResult {
  projectors: HoloProjector[];
  orbitCenter?: THREE.Vector3;
  stereo_render_data?: unknown;
}

/**
 * Convenience function to load a LIF file and create HoloProjector instances
 * @param file - The LIF file to load
 * @returns Object with projectors array and optional orbit center
 */
export async function loadLifFile(file: File): Promise<LoadLifFileResult> {
  const loader = new LifLoader();
  const data = await loader.load(file);

  // Extract baseline from LIF file metadata (convert mm to meters)
  const lifData = data as any;
  const baselineMeters = lifData.baseline_mm ? lifData.baseline_mm / 1000 : 1.0;
  console.log('LIF baseline:', lifData.baseline_mm, 'mm =', baselineMeters, 'm');

  const projectors = await Promise.all(
    data.views.map((view) =>
      createHoloProjectorFromLifView(
        view,
        {
          invDepthRange: {
            min: view.inv_z_map.min,
            max: view.inv_z_map.max,
            baseline: baselineMeters,
          },
        },
        baselineMeters, // Pass baseline for position scaling
      ),
    ),
  );

  // Calculate orbit center from stereo_render_data if available
  let orbitCenter: THREE.Vector3 | undefined = undefined;

  if (data.stereo_render_data && projectors.length > 0) {
    const stereoData = data.stereo_render_data as any;
    const invd = stereoData.invd ?? stereoData.inv_convergence_distance;

    console.log('Stereo render data:', stereoData);

    if (invd && invd !== 0) {
      const firstProjector = projectors[0];
      const firstView = data.views[0];

      // Get frustum skew from stereo_render_data or fall back to view's frustum_skew
      let sk = stereoData.frustum_skew;

      if (!sk && firstView.frustum_skew) {
        // Handle frustum_skew as either array [x, y] or object {x, y}
        if (Array.isArray(firstView.frustum_skew)) {
          sk = {
            x: firstView.frustum_skew[0],
            y: firstView.frustum_skew[1]
          };
        } else {
          sk = firstView.frustum_skew;
        }
        console.log('Using frustum_skew from view:', sk);
      } else if (!sk) {
        // Default to center (no skew)
        sk = { x: 0, y: 0 };
        console.log('No frustum_skew found, using center point (0, 0)');
      }

      // Calculate convergence depth in projector space
      // invd is in units of 1/meters, baseline is in meters
      // depth = baseline / invd (in meters)
      const convergenceDepth = baselineMeters / invd;

      // Get camera intrinsics
      const fx = firstProjector.intrinsics.fx;
      const fy = firstProjector.intrinsics.fy;
      const cx = firstProjector.intrinsics.cx;
      const cy = firstProjector.intrinsics.cy;

      // Calculate the ray through projector center and (sk.x, sk.y, 1)
      // In projector space, the point at depth z on a ray through pixel (px, py) is:
      // X = (px - cx) * z / fx
      // Y = (py - cy) * z / fy
      // Z = -z (camera looks down -Z)

      // The skew is in normalized coordinates, so convert to pixel coordinates
      // sk represents the offset from center in focal length units
      // So the pixel coordinate is: center + sk * focal_length
      const px = cx + sk.x * fx;
      const py = cy + sk.y * fy;

      // Calculate 3D point in projector space
      const X = (px - cx) * convergenceDepth / fx;
      const Y = (py - cy) * convergenceDepth / fy;
      const Z = -convergenceDepth; // Camera looks down -Z

      // Create point in projector local space
      const localPoint = new THREE.Vector3(X, Y, Z);

      // Transform to world space
      firstProjector.updateMatrixWorld();
      orbitCenter = localPoint.applyMatrix4(firstProjector.matrixWorld);

      console.log('Calculated orbit center from stereo_render_data:');
      console.log('  invd:', invd);
      console.log('  frustum_skew:', sk);
      console.log('  baseline_mm:', baselineMeters * 1000);
      console.log('  convergenceDepth:', convergenceDepth);
      console.log('  pixel coords:', { px, py });
      console.log('  projector space:', { X, Y, Z });
      console.log('  world space:', orbitCenter);
    } else {
      console.log('No valid stereo_render_data for orbit center calculation');
      console.log('  invd:', invd);
    }
  }

  return {
    projectors,
    orbitCenter,
    stereo_render_data: data.stereo_render_data,
  };
}
