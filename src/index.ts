// LIF (Light Field) Renderer
// A THREE.js holographic projector renderer for RGB+Depth images

export { HoloProjector } from "./HoloProjector";
export { HoloRenderer } from "./HoloRenderer";
export type { HoloProjectorOptions } from "./HoloProjector";
export type { HoloRendererOptions } from "./HoloRenderer";

// LIF file format support
export {
  LifLoader,
  loadLifFile,
  lifRotationToQuaternion,
  createHoloProjectorFromLifView,
} from "./LifLoader";
export type { LifView, LifData, LifStereoRenderData } from "./types/lif";
