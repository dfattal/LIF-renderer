// Type definitions for LIF (Light Field Image) file format

import * as THREE from "three";

export interface LifView {
  // RGB image data
  image: {
    url: string; // Blob URL for RGB image (JPEG)
    blob_id: number; // Internal blob ID
  };

  // Inverse depth map data
  inv_z_map: {
    url: string; // Blob URL for inverse depth map (grayscale PNG)
    min: number; // Minimum inverse depth (closest point)
    max: number; // Maximum inverse depth (furthest point)
    blob_id: number; // Internal blob ID
  };

  // Optional mask (for layered depth images)
  mask?: {
    url: string;
    blob_id: number;
  };

  // Image dimensions in pixels
  width_px: number;
  height_px: number;

  // Camera intrinsics
  focal_px: number; // Focal length in pixels (assumes square pixels: fx = fy)

  // Camera pose
  position: [number, number, number]; // 3D position [x, y, z]
  rotation: [number, number, number]; // [sl.x, sl.y, roll] where forward = normalize(vec3(sl.x, sl.y, 1))

  // Optional: frustum skew (for non-centered principal points)
  // Principal point: cx = width/2 - frustum_skew.x * focal_px, cy = height/2 - frustum_skew.y * focal_px
  // Can be either array [x, y] (legacy) or object {x, y} (current)
  frustum_skew?: [number, number] | { x: number; y: number };

  // Layered depth image support (ignore for basic usage)
  layers_top_to_bottom?: LifLayer[];

  // Legacy camera data (pre-5.3 format)
  camera_data?: {
    focal_ratio_to_width: number;
    position: [number, number, number];
    rotation: [number, number, number];
    frustum_skew?: [number, number];
  };

  // Legacy layered depth image data
  layered_depth_image_data?: {
    layers_top_to_bottom: LifLayer[];
    outpainting_added_width_px: number;
    outpainting_added_height_px: number;
  };
}

export interface LifLayer {
  image?: {
    url: string;
    blob_id: number;
  };
  inv_z_map?: {
    url: string;
    min: number;
    max: number;
    blob_id: number;
  };
  mask?: {
    url: string;
    blob_id: number;
  };
  width_px?: number;
  height_px?: number;
  focal_px?: number;
  camera_data?: {
    focal_ratio_to_width: number;
    position: [number, number, number];
    rotation: [number, number, number];
    frustum_skew?: [number, number];
  };
  outpainting_added_width_px?: number;
  outpainting_added_height_px?: number;
}

export interface LifStereoRenderData {
  inv_convergence_distance?: number;
  invd?: number; // Alias for inv_convergence_distance
  frustum_skew?: {
    x: number;
    y: number;
  };
  [key: string]: unknown; // Allow additional properties
}

export interface LifData {
  views: LifView[];
  stereo_render_data?: LifStereoRenderData;
}

/**
 * Processed layer data for rendering
 * Created by HoloProjector from LifView data
 */
export interface LayerData {
  // Textures (loaded from URLs)
  rgbTexture: THREE.Texture | null;
  depthTexture: THREE.Texture | null;

  // Original URLs (for raycast plane texture loading)
  rgbUrl?: string;
  depthUrl?: string;
  maskUrl?: string;

  // Dimensions
  width: number;
  height: number;

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

  // Layer ordering (for multi-layer rendering)
  renderOrder?: number;
}
