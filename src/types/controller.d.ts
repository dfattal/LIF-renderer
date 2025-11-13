import type * as THREE from 'three';
import type { HoloProjector } from '../HoloProjector';

/**
 * Information about a VR controller ray intersection with LDI content
 */
export interface ControllerHitInfo {
  /** Whether the ray hit any LDI surface */
  hit: boolean;

  /** World-space 3D point where ray intersects surface */
  point: THREE.Vector3;

  /** Normalized UV coordinates (0-1) on the projector image */
  uv: THREE.Vector2;

  /** Layer index that was hit (0 = front layer, 1 = back layer, etc.) */
  layer: number;

  /** Distance from controller origin to hit point (in meters) */
  distance: number;

  /** The projector that was hit */
  projector: HoloProjector;
}
