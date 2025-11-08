import * as THREE from "three";

import { HoloRenderer, type RenderMode } from "./HoloRenderer";
import type { HoloProjector } from "./HoloProjector";

/**
 * Container class that manages multiple HoloRenderer meshes, one per layer.
 * Automatically detects whether to use mesh or raytracing mode based on layer count:
 * - Single layer: mesh mode (connected mesh geometry)
 * - Multiple layers: raytracing mode (fragment shader raycasting)
 */
export class HoloLayerGroup extends THREE.Group {
  /**
   * Array of HoloRenderer meshes, one per layer
   */
  layerRenderers: HoloRenderer[] = [];

  /**
   * Reference to the HoloProjector this group is rendering
   */
  projector: HoloProjector | null = null;

  constructor() {
    super();
    this.name = "HoloLayerGroup";
  }

  /**
   * Initializes layer renderers from a HoloProjector's layer data
   * Automatically chooses render mode:
   * - 1 layer -> 'mesh' mode (fast, single-layer reconstruction)
   * - 2+ layers -> 'raytracing' mode (full LDI with occlusion)
   * @param projector - The HoloProjector containing layer data
   */
  initializeFromProjector(projector: HoloProjector): void {
    // Clean up existing renderers
    this.dispose();

    this.projector = projector;

    // Auto-detect render mode based on layer count
    const renderMode: RenderMode = projector.lifLayers.length > 1 ? 'raytracing' : 'mesh';

    console.log(`HoloLayerGroup: Initializing with ${projector.lifLayers.length} layers in ${renderMode} mode`);

    // Create one renderer per layer
    for (let i = 0; i < projector.lifLayers.length; i++) {
      const layer = projector.lifLayers[i];

      // Create renderer with the detected mode
      const renderer = new HoloRenderer(renderMode);

      // Assign this specific layer to the renderer
      renderer.assignedLayer = layer;
      renderer.assignedProjector = projector;

      // Set render order for proper layering (front layers drawn last)
      renderer.renderOrder = layer.renderOrder ?? i;

      // Add to group
      this.add(renderer);
      this.layerRenderers.push(renderer);

      console.log(`  Layer ${i}: ${layer.width}x${layer.height}, renderOrder=${renderer.renderOrder}`);
    }
  }

  /**
   * Gets the current render mode of all layers
   * @returns The render mode ('mesh' or 'raytracing')
   */
  getRenderMode(): RenderMode {
    return this.layerRenderers[0]?.getRenderMode() ?? 'mesh';
  }

  /**
   * Sets the render mode for all layer renderers
   * @param mode - The render mode to use ('mesh' or 'raytracing')
   */
  setRenderMode(mode: RenderMode): void {
    console.log(`HoloLayerGroup: Switching to ${mode} mode`);
    this.layerRenderers.forEach(renderer => renderer.setRenderMode(mode));
  }

  /**
   * Updates all layer renderers (called automatically via onBeforeRender hooks)
   * Note: Individual renderers have their own onBeforeRender, so this is optional
   * @param camera - The camera being rendered from
   * @param renderer - The WebGL renderer
   */
  updateLayers(camera: THREE.Camera, renderer: THREE.WebGLRenderer): void {
    // Individual HoloRenderer instances handle their own updates in onBeforeRender
    // This method is kept for compatibility but is not required
  }

  /**
   * Gets the number of layers being rendered
   */
  getLayerCount(): number {
    return this.layerRenderers.length;
  }

  /**
   * Gets statistics about the layer group
   */
  getStats(): {
    layerCount: number;
    renderMode: RenderMode;
    layerDetails: Array<{
      index: number;
      renderOrder: number;
      width: number;
      height: number;
      hasMask: boolean;
    }>;
  } {
    return {
      layerCount: this.layerRenderers.length,
      renderMode: this.getRenderMode(),
      layerDetails: this.layerRenderers.map((renderer, index) => {
        const layer = renderer.assignedLayer;
        return {
          index,
          renderOrder: renderer.renderOrder,
          width: layer?.width ?? 0,
          height: layer?.height ?? 0,
          hasMask: !!layer?.maskUrl,
        };
      }),
    };
  }

  /**
   * Sets the gradient threshold for all layer renderers (mesh mode only)
   * @param threshold - The threshold value
   */
  setGradientThreshold(threshold: number): void {
    this.layerRenderers.forEach(renderer => renderer.setGradientThreshold(threshold));
  }

  /**
   * Gets the gradient threshold from the first renderer
   */
  getGradientThreshold(): number {
    return this.layerRenderers[0]?.getGradientThreshold() ?? 0.0;
  }

  /**
   * Toggles depth visualization for all layer renderers
   * @returns The new visualization state
   */
  toggleDepthVisualization(): boolean {
    const newState = this.layerRenderers[0]?.toggleDepthVisualization() ?? false;
    // Sync all other renderers
    for (let i = 1; i < this.layerRenderers.length; i++) {
      const current = this.layerRenderers[i].getDepthVisualization();
      if (current !== newState) {
        this.layerRenderers[i].toggleDepthVisualization();
      }
    }
    return newState;
  }

  /**
   * Disposes of all layer renderers and cleans up resources
   */
  dispose(): void {
    this.layerRenderers.forEach(renderer => {
      this.remove(renderer);
      renderer.dispose();
    });
    this.layerRenderers = [];
    this.projector = null;
  }
}
