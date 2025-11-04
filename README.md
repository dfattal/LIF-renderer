# LIF Renderer

A THREE.js holographic projector renderer for RGB+Depth (Light Field Image Format) data.

## Overview

LIF Renderer enables real-time 3D reconstruction and rendering of Light Field Images - RGB images paired with inverse depth maps. It renders square pixels as instanced quads, reconstructing 3D geometry from projector intrinsics and depth data.

## Features

- **Real-time rendering** of RGB+Depth images as 3D point clouds
- **Camera intrinsics support** with configurable focal length and principal point
- **Inverse depth mapping** with stereo baseline correction
- **Square pixel rendering** for perfect tiling with no gaps
- **Frustum visualization** showing the projection pyramid
- **Interactive camera controls** with orbit mode and smooth transitions
- **Auto-injection** - automatically sets up renderer when projector is added to scene

## Installation

```bash
npm install lif-renderer three
```

## Quick Start

```typescript
import * as THREE from 'three';
import { HoloProjector } from 'lif-renderer';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
const renderer = new THREE.WebGLRenderer();

// Create a holographic projector
const projector = new HoloProjector({
  rgbUrl: 'path/to/rgb.jpg',
  depthUrl: 'path/to/depth.png',
  intrinsics: {
    fx: 998.4,  // Focal length X in pixels
    fy: 998.4,  // Focal length Y in pixels
    cx: 640,    // Principal point X
    cy: 400,    // Principal point Y
  },
  invDepthRange: {
    min: 0.09,      // Closest point (depth map value = 1)
    max: 0.0001,    // Furthest point (depth map value = 0)
    baseline: 0.045 // Stereo baseline in meters (optional)
  },
  width: 1280,
  height: 800,
  onLoad: (projector) => {
    console.log('Projector loaded!');
  }
});

scene.add(projector);

// The renderer is auto-injected, just render the scene
function animate() {
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
```

## API

### HoloProjector

The main class representing a holographic projector in 3D space.

#### Constructor Options

```typescript
interface HoloProjectorOptions {
  // Image sources (provide URLs or textures)
  rgbUrl?: string;
  rgbTexture?: THREE.Texture;
  depthUrl?: string;
  depthTexture?: THREE.Texture;

  // Camera intrinsics in pixel units
  intrinsics: {
    fx: number;  // Focal length X in pixels
    fy: number;  // Focal length Y in pixels
    cx: number;  // Principal point X in pixels
    cy: number;  // Principal point Y in pixels
  };

  // Inverse depth range mapping
  invDepthRange: {
    min: number;       // Closest point (depth map value 1 or 255)
    max: number;       // Furthest point (depth map value 0)
    baseline?: number; // Optional baseline in meters (for stereo depth)
  };

  // Image dimensions
  width?: number;
  height?: number;

  // Callback when loading is complete
  onLoad?: (projector: HoloProjector) => void | Promise<void>;
}
```

#### Properties

- `rgbTexture: THREE.Texture` - RGB color texture
- `depthTexture: THREE.Texture` - Inverse depth texture
- `intrinsics` - Camera intrinsics
- `invDepthRange` - Inverse depth range
- `width, height` - Image dimensions
- `frustumHelper: THREE.Group` - Frustum visualization (toggle with `.visible`)
- `initialized: Promise<HoloProjector>` - Promise that resolves when loading is complete
- `isInitialized: boolean` - Whether initialization is complete

#### Methods

- `dispose()` - Clean up textures and resources

### HoloRenderer

The rendering engine (usually auto-injected, but can be manually added).

#### Constructor Options

```typescript
interface HoloRendererOptions {
  renderer: THREE.WebGLRenderer;
  pointSize?: number;    // Size multiplier (1.0 = perfect tiling)
  maxStdDev?: number;    // Not used for square rendering
  depthWrite?: boolean;  // Enable depth writing (default: true)
}
```

## Depth Encoding

The renderer expects inverse depth maps where:
- **0** (black) = furthest point → `invZMax`
- **1 or 255** (white) = closest point → `invZMin`

Depth is calculated as: `Z = baseline / invZ`

Where `baseline` is the stereo camera baseline in meters (default: 1.0).

## Camera Intrinsics

The intrinsics define how pixels map to 3D space:

```
fx, fy = focal length in pixels (e.g., 0.78 * imageWidth for typical FOV)
cx, cy = principal point (usually center: width/2, height/2)
```

The 3D position of pixel (x, y) at depth Z is:
```
X = (x - cx) * Z / fx
Y = (y - cy) * Z / fy
Z = -Z  (camera looks down -Z axis)
```

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build library
npm run build

# Clean
npm run clean
```

## Demo

The demo uses the SFMoMA restaurant scene included in `public/assets/`.

Run the dev server and open http://localhost:8080:
```bash
npm run dev
```

The demo includes:
- WASD movement
- Click+drag rotation
- Double-click orbit mode with smooth transitions
- F key to toggle frustum visualization
- Mouse wheel zoom in orbit mode

## Data Format

Example data: [SFMoMA Restaurant Scene](https://huggingface.co/datasets/davidfattal/LIF-samples/tree/main/sfmoma-restaurant)

- `rgb.jpg` - Color image (JPEG, PNG, etc.)
- `depth.png` - Grayscale inverse depth map
- Filename convention: `rgb_invZ{min}_{max}.jpg` and `depth_invZ{min}_{max}.png`

## License

MIT

## Credits

Developed by David Fattal
