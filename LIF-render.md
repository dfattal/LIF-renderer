# LIF Renderer - Fragment Shader-Based Rendering Knowledge Document

## Executive Summary

This document contains all relevant knowledge needed to implement fragment shader-based LIF rendering using raycasting techniques. The new approach replaces the current instanced geometry method with a full-screen quad + fragment shader raycast approach that directly renders from LIF view data.

---

## Table of Contents

1. [LIF File Format Overview](#lif-file-format-overview)
2. [Shader Architecture](#shader-architecture)
3. [Mono vs Stereo Rendering](#mono-vs-stereo-rendering)
4. [Uniform Requirements](#uniform-requirements)
5. [Texture Loading and Preparation](#texture-loading-and-preparation)
6. [Camera Model and Transformations](#camera-model-and-transformations)
7. [Raycasting Algorithm](#raycasting-algorithm)
8. [Layer Blending](#layer-blending)
9. [Implementation Checklist](#implementation-checklist)

---

## 1. LIF File Format Overview

### Current LIF TypeScript Types

```typescript
interface LifView {
  // Image data
  image: { url: string; blob_id: number };
  inv_z_map: { url: string; min: number; max: number; blob_id: number };

  // Dimensions
  width_px: number;
  height_px: number;

  // Camera intrinsics
  focal_px: number;

  // Camera pose
  position: [number, number, number];
  rotation: [number, number, number];
  frustum_skew?: { x: number; y: number } | [number, number];

  // Multi-layer support
  layers_top_to_bottom?: LifLayer[];
}

interface LifLayer {
  image?: { url: string; blob_id: number };
  inv_z_map?: { url: string; min: number; max: number; blob_id: number };
  mask?: { url: string; blob_id: number };
  width_px?: number;
  height_px?: number;
  focal_px?: number;
  // ... camera data inherited or specified per layer
}

interface LifStereoRenderData {
  inv_convergence_distance?: number;
  invd?: number; // Alias for inv_convergence_distance
  frustum_skew?: { x: number; y: number };
}

interface LifData {
  views: LifView[];
  stereo_render_data?: LifStereoRenderData;
}
```

### Key Concepts

- **Mono LIF**: Contains 1 view (single camera position)
- **Stereo LIF**: Contains 2 views (left and right eye positions)
- **LDI (Layered Depth Image)**: Views may contain `layers_top_to_bottom` array (up to 4 layers)
- **Inverse Depth**: Depth is stored as `invZ = 1/Z` where Z is depth in meters
- **Blob Storage**: Images are stored as blob URLs extracted from JPEG metadata

---

## 2. Shader Architecture

### Rendering Approach

Instead of instanced quads, use:
- **Geometry**: Single full-screen quad (2 triangles)
- **Vertex Shader**: Simple pass-through with texture coordinates
- **Fragment Shader**: Performs raycasting per pixel to reconstruct 3D scene

### Shader Selection Logic

```javascript
// Determine which shader to use
const shaderPath = (views.length === 1)
  ? 'rayCastMonoLDI.glsl'    // 1 view
  : 'rayCastStereoLDI.glsl';  // 2 views
```

### Vertex Shader (Simple Pass-Through)

```glsl
attribute vec4 aVertexPosition;
attribute vec2 aTextureCoord;
varying highp vec2 v_texcoord;

void main(void) {
    gl_Position = aVertexPosition;
    v_texcoord = aTextureCoord;
}
```

---

## 3. Mono vs Stereo Rendering

### Mono Rendering (rayCastMonoLDI.glsl)

**Purpose**: Render from a single view with optional multi-layer support

**Key Features**:
- Renders from ONE camera position
- Supports up to 4 layers (LDI)
- Simpler uniform structure

### Stereo Rendering (rayCastStereoLDI.glsl)

**Purpose**: Render from TWO views (left + right) and blend based on camera position

**Key Features**:
- Renders from TWO camera positions (view L and view R)
- Blends layers from both views using `weight2()` function
- Supports up to 4 layers PER VIEW
- More complex uniform structure (duplicated for L and R)

**Blending Function**:
```glsl
float weight2(vec3 C, vec3 C1, vec3 C2) {
    // Generalizes weightR for arbitrary 2 views blending
    return smoothstep(0.0, 1.0, dot(C2 - C1, C - C1) / dot(C2 - C1, C2 - C1));
}

// Usage in main():
float wR = weight2(C2, C1L, C1R);
layer = (1.0 - wR) * layer1L + wR * layer1R;
```

---

## 4. Uniform Requirements

### Common Uniforms (Both Shaders)

```glsl
// Viewport info
uniform vec2 iResOriginal;      // Original LIF image dimensions
uniform vec2 oRes;              // Output viewport resolution in pixels
uniform float uTime;            // Animation time

// Rendering camera (where we're viewing from)
uniform vec3 uFacePosition;     // Camera position in normalized space
uniform vec2 sk2, sl2;          // Skew and slant for rendering camera
uniform float roll2;            // Roll angle in degrees
uniform float f2;               // Focal length in pixels

// Visual effects
uniform float feathering;       // Edge feathering factor (e.g., 0.1)
uniform vec4 background;        // Background color (RGBA)
```

### Mono-Specific Uniforms (rayCastMonoLDI.glsl)

```glsl
// Source view data (arrays for LDI support)
uniform sampler2D uImage[4];         // RGB textures per layer
uniform sampler2D uDisparityMap[4];  // Inverse depth + mask (RGBA)
uniform float invZmin[4];            // Min inverse depth per layer
uniform float invZmax[4];            // Max inverse depth per layer

// Source camera parameters (common to all layers)
uniform vec3 uViewPosition;          // Camera position "C1"
uniform vec2 sk1, sl1;               // Skew and slant
uniform float roll1;                 // Roll angle
uniform float f1[4];                 // Focal length per layer
uniform vec2 iRes[4];                // Image resolution per layer

uniform int uNumLayers;              // Number of layers (0-4)
```

### Stereo-Specific Uniforms (rayCastStereoLDI.glsl)

All mono uniforms **duplicated** with `L` and `R` suffixes:

```glsl
// Left view
uniform sampler2D uImageL[4];
uniform sampler2D uDisparityMapL[4];
uniform float invZminL[4], invZmaxL[4];
uniform vec3 uViewPositionL;
uniform vec2 sk1L, sl1L;
uniform float roll1L, f1L[4];
uniform vec2 iResL[4];
uniform int uNumLayersL;

// Right view (same structure)
uniform sampler2D uImageR[4];
uniform sampler2D uDisparityMapR[4];
uniform float invZminR[4], invZmaxR[4];
uniform vec3 uViewPositionR;
uniform vec2 sk1R, sl1R;
uniform float roll1R, f1R[4];
uniform vec2 iResR[4];
uniform int uNumLayersR;
```

---

## 5. Texture Loading and Preparation

### From LifLoader to WebGL Textures

Based on `Renderers.js` implementation:

#### Step 1: Load Images from Blob URLs

```javascript
async _loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = url;  // Blob URL from LIF metadata
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load: ${url}`));
    });
}
```

#### Step 2: Create 4-Channel Depth+Mask Texture

The depth map and mask are combined into a single RGBA texture:

```javascript
_create4ChannelImage(depthImage, maskImage) {
    const canvas = document.createElement("canvas");
    canvas.width = depthImage.width;
    canvas.height = depthImage.height;
    const ctx = canvas.getContext("2d");

    // Get depth data (R channel contains inverse depth)
    ctx.drawImage(depthImage, 0, 0);
    const depthData = ctx.getImageData(0, 0, width, height).data;

    // Get mask data
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(maskImage, 0, 0);
    const maskData = ctx.getImageData(0, 0, width, height).data;

    // Combine: RGB from depth, A from mask
    const combined = ctx.createImageData(width, height);
    for (let i = 0; i < depthData.length; i += 4) {
        combined.data[i]     = depthData[i];     // R
        combined.data[i + 1] = depthData[i + 1]; // G
        combined.data[i + 2] = depthData[i + 2]; // B
        combined.data[i + 3] = maskData[i];      // A from mask
    }

    ctx.putImageData(combined, 0, 0);
    return canvas;
}
```

#### Step 3: Create WebGL Texture

```javascript
_createTexture(image) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return texture;
}
```

#### Step 4: Bind to Uniform Array

```javascript
// Bind up to 4 layer textures
for (let i = 0; i < Math.min(layers.length, 4); i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, layers[i].image.texture);
    gl.uniform1i(uImageLocation[i], i);

    gl.activeTexture(gl.TEXTURE4 + i);
    gl.bindTexture(gl.TEXTURE_2D, layers[i].invZ.texture);
    gl.uniform1i(uDisparityMapLocation[i], 4 + i);
}
```

---

## 6. Camera Model and Transformations

### Normalized Camera Space

All positions are in **normalized camera space** where:
- Origin is at the camera's optical center
- Units are in **image width fractions**
- Z-axis points along viewing direction

### Matrix Builders (from shader)

```glsl
mat3 matFromFocal(vec2 fxy) {
    // Focal matrix: converts from normalized to pixel coordinates
    return mat3(fxy.x, 0.0, 0.0,
                0.0, fxy.y, 0.0,
                0.0, 0.0, 1.0);
}

mat3 matFromSkew(vec2 sk) {
    // Frustum skew matrix (for off-axis projection)
    return mat3(1.0, 0.0, 0.0,
                0.0, 1.0, 0.0,
                -sk.x, -sk.y, 1.0);
}

mat3 matFromRoll(float th) {
    // Roll rotation (degrees)
    float c = cos(th * 3.141593 / 180.0);
    float s = sin(th * 3.141593 / 180.0);
    return mat3(c, s, 0.0,
                -s, c, 0.0,
                0.0, 0.0, 1.0);
}

mat3 matFromSlant(vec2 sl) {
    // Slant rotation (tangent space)
    float invsqx = 1.0 / sqrt(1.0 + sl.x * sl.x);
    float invsqy = 1.0 / sqrt(1.0 + sl.y * sl.y);
    float invsq = 1.0 / sqrt(1.0 + sl.x * sl.x + sl.y * sl.y);
    return mat3(invsqx, 0.0, sl.x * invsq,
                0.0, invsqy, sl.y * invsq,
                -sl.x * invsqx, -sl.y * invsqy, invsq);
}
```

### Transform Composition

**Source View (where LIF was captured)**:
```glsl
mat3 SKR1 = matFromSkew(sk1) * matFromRoll(roll1) * matFromSlant(sl1);
mat3 FSKR1 = matFromFocal(f1 / iRes) * SKR1;
```

**Target View (where we're rendering to)**:
```glsl
mat3 FSKR2 = matFromFocal(f2 / oRes) * matFromSkew(sk2) * matFromRoll(roll2) * matFromSlant(sl2);
```

### Coordinate System Conversion

```javascript
// From LIF rotation (axis-angle) to slant vector
function lifRotationToSlant(rotation) {
    // rotation is [rx, ry, rz] axis-angle representation
    // Convert to slant (tangent of rotation angles)
    return {
        x: Math.tan(rotation[0]),
        y: Math.tan(rotation[1])
    };
}

// From frustum_skew to uniform sk
function frustumSkewToUniform(frustum_skew) {
    if (Array.isArray(frustum_skew)) {
        return { x: frustum_skew[0], y: frustum_skew[1] };
    }
    return frustum_skew; // Already {x, y}
}
```

---

## 7. Raycasting Algorithm

### High-Level Overview

For each output pixel:
1. **Ray Definition**: Define ray from rendering camera through pixel
2. **Inverse Depth Search**: March along ray in inverse depth space
3. **Surface Intersection**: Find where ray intersects virtual surface
4. **Texture Lookup**: Sample color from source view at intersection
5. **Masking**: Check alpha channel to discard masked pixels

### Raycasting Function Signature

```glsl
vec4 raycasting(
    vec2 s2,              // Normalized screen coord [-0.5, 0.5]
    mat3 FSKR2,           // Target camera transform
    vec3 C2,              // Target camera position
    mat3 FSKR1,           // Source camera transform
    vec3 C1,              // Source camera position
    sampler2D iChannelCol,    // RGB texture
    sampler2D iChannelDisp,   // Depth+mask texture
    float invZmin,        // Min inverse depth
    float invZmax,        // Max inverse depth
    vec2 iRes,            // Source image resolution
    float t,              // Animation parameter
    out float invZ2,      // Output: reconstructed inverse depth
    out float confidence  // Output: confidence of reconstruction
)
```

### Algorithm Steps (40 iterations)

```glsl
const int numsteps = 40;
float invZ = invZmin;  // Start at closest depth
float dinvZ = (invZmin - invZmax) / float(numsteps);

// Precompute projection matrix blocks
mat3 P = FSKR1 * inverse(FSKR2);
vec3 C = FSKR1 * (C2 - C1);

mat2 Pxyxy = mat2(P[0].xy, P[1].xy);
vec2 Pxyz = P[2].xy;
vec2 Pzxy = vec2(P[0].z, P[1].z);
float Pzz = P[2].z;

// Initial ray-plane intersection
vec2 s1 = C.xy * invZ + (1.0 - C.z * invZ) * (Pxyxy * s2 + Pxyz) / (dot(Pzxy, s2) + Pzz);
vec2 ds1 = (C.xy - C.z * (Pxyxy * s2 + Pxyz) / (dot(Pzxy, s2) + Pzz)) * dinvZ;

// Binary search for surface
for(int i = 0; i < numsteps; i++) {
    invZ -= dinvZ;
    s1 -= ds1;

    // Sample depth at current position
    float disp = readDisp(iChannelDisp, s1 + 0.5, invZmin, invZmax, iRes);

    // Check if ray is below surface
    invZ2 = invZ * (dot(Pzxy, s2) + Pzz) / (1.0 - C.z * invZ);
    if((disp > invZ) && (invZ2 > 0.0)) {
        // Refine: step back and reduce step size
        invZ += dinvZ;
        s1 += ds1;
        dinvZ /= 2.0;
        ds1 /= 2.0;
    }
}

// Return color if valid
if((abs(s1.x) < 0.5) && (abs(s1.y) < 0.5) && (invZ2 > 0.0)) {
    float maskValue = texture(iChannelDisp, s1 + 0.5).a;
    if (maskValue < 0.5) {
        return vec4(0.0); // Masked pixel
    }
    return vec4(readColor(iChannelCol, s1 + 0.5), taper(s1 + 0.5));
} else {
    return vec4(background.rgb, 0.0);
}
```

### Depth Reading

```glsl
float readDisp(sampler2D iChannel, vec2 uv, float vMin, float vMax, vec2 iRes) {
    // Clamp to avoid edge artifacts
    vec2 clampedUV = vec2(
        clamp(uv.x, 2.0 / iRes.x, 1.0 - 2.0 / iRes.x),
        clamp(uv.y, 2.0 / iRes.y, 1.0 - 2.0 / iRes.y)
    );
    // R channel contains normalized invZ, remap to [vMax, vMin]
    return texture(iChannel, clampedUV).x * (vMin - vMax) + vMax;
}
```

### Masking

```glsl
// Check if any neighboring pixel is masked (dilated mask)
bool isMaskAround(vec2 xy, sampler2D tex, vec2 iRes) {
    for(float x = -1.0; x <= 1.0; x += 1.0) {
        for(float y = -1.0; y <= 1.0; y += 1.0) {
            const float maskDilation = 1.5;
            vec2 offset_xy = xy + maskDilation * vec2(x, y) / iRes;
            if(texture(tex, offset_xy).a < 0.5) {
                return true;
            }
        }
    }
    return false;
}
```

---

## 8. Layer Blending

### Mono LDI Blending (Back-to-Front)

```glsl
// Layer 1 (top/foreground)
vec4 result = raycasting(..., uImage[0], uDisparityMap[0], ...);
result.rgb *= result.a; // Premultiply alpha

if(!(result.a == 1.0 || uNumLayers == 1)) {
    // Layer 2
    vec4 layer2 = raycasting(..., uImage[1], uDisparityMap[1], ...);
    result.rgb = result.rgb + (1.0 - result.a) * layer2.a * layer2.rgb;
    result.a = layer2.a + result.a * (1.0 - layer2.a);

    // Layer 3, 4... (same pattern)
}

// Final background blend
result.rgb = background.rgb * background.a * (1.0 - result.a) + result.rgb;
result.a = background.a + result.a * (1.0 - background.a);
```

### Stereo LDI Blending

For each layer, raycast BOTH views, then blend:

```glsl
// Layer 1 from both views
vec4 layer1L = raycasting(..., uImageL[0], uDisparityMapL[0], ...);
vec4 layer1R = raycasting(..., uImageR[0], uDisparityMapR[0], ...);

// Handle occlusions (if one view fails, use the other)
if((aL == 0.0) && (aR == 1.0) || (layer1L.a < layer1R.a - 0.1)) {
    layer1L = layer1R;
}
if((aR == 0.0) && (aL == 1.0) || (layer1R.a < layer1L.a - 0.1)) {
    layer1R = layer1L;
}

// Blend based on camera position
float wR = weight2(C2, C1L, C1R);
vec4 layer = (1.0 - wR) * layer1L + wR * layer1R;

// Accumulate layers (same as mono)
result = layer;
result.rgb *= result.a;
// ... continue with layer 2, 3, 4
```

---

## 9. Implementation Checklist

### Phase 1: Setup

- [ ] Create new shader loader utility
- [ ] Add fragment shaders to project (rayCastMonoLDI.glsl, rayCastStereoLDI.glsl)
- [ ] Create simple vertex shader (full-screen quad)
- [ ] Modify LifLoader to properly set rotation_slant from rotation field

### Phase 2: Renderer Class

- [ ] Create `RaycastRenderer` base class (similar to `Renderers.js`)
- [ ] Implement texture loading from LIF blob URLs
- [ ] Implement 4-channel depth+mask texture creation
- [ ] Add uniform location caching
- [ ] Implement uniform setting methods

### Phase 3: Mono Renderer

- [ ] Create `MonoRaycastRenderer` extending base
- [ ] Load and compile rayCastMonoLDI.glsl
- [ ] Set up uniform arrays for up to 4 layers
- [ ] Implement camera transform calculations
- [ ] Test with single-layer LIF
- [ ] Test with multi-layer LDI

### Phase 4: Stereo Renderer

- [ ] Create `StereoRaycastRenderer` extending base
- [ ] Load and compile rayCastStereoLDI.glsl
- [ ] Set up duplicated uniform arrays (L/R)
- [ ] Implement view blending weight calculation
- [ ] Test with stereo LIF
- [ ] Test with stereo LDI

### Phase 5: Integration

- [ ] Replace HoloRenderer/HoloLayerGroup with RaycastRenderer
- [ ] Update demo to use new renderer
- [ ] Add camera movement/interaction
- [ ] Add focus slider (modifies invd)
- [ ] Performance testing and optimization

### Phase 6: Polish

- [ ] Add animation support (harmonic motion)
- [ ] Add viewport scaling logic
- [ ] Add feathering controls
- [ ] Add background color controls
- [ ] Documentation and examples

---

## Key Differences from Current Architecture

| Aspect | Current (Instanced Geometry) | New (Raycast Shader) |
|--------|------------------------------|----------------------|
| **Geometry** | One quad instance per pixel | Single full-screen quad |
| **Vertex Shader** | Reconstructs 3D position | Simple pass-through |
| **Fragment Shader** | Simple texture lookup | Full raycasting algorithm |
| **Multi-layer** | Multiple mesh objects | Single pass with blending |
| **Performance** | Limited by instance count | Limited by fragment complexity |
| **View Blending** | Not supported | Native stereo support |

---

## Reference Implementation Files

- **Shaders**: `/Users/david.fattal/Documents/GitHub/dfattal.github.io/Shaders/rayCastMonoLDI.glsl`
- **Shaders**: `/Users/david.fattal/Documents/GitHub/dfattal.github.io/Shaders/rayCastStereoLDI.glsl`
- **Renderer**: `/Users/david.fattal/Documents/GitHub/dfattal.github.io/VIZ/Renderers.js`
- **Viewer**: `/Users/david.fattal/Documents/GitHub/dfattal.github.io/LIF/lifViewer-modern.js`
- **Current Types**: `/Users/david.fattal/Documents/GitHub/LIF-renderer/src/types/lif.d.ts`
- **Current Loader**: `/Users/david.fattal/Documents/GitHub/LIF-renderer/src/LifLoader.ts`

---

## Additional Notes

### Viewport Scaling

The viewport scale factor adjusts focal length when rendering at different resolutions:

```javascript
viewportScale = Math.min(canvasWidth, canvasHeight) / Math.min(imageWidth, imageHeight);
f2 = view.focal_px * viewportScale * (1 - cameraPos.z * invd);
```

### Convergence Distance (invd)

For stereo rendering, `invd` (inverse convergence distance) controls the depth plane of zero parallax:

```javascript
// Default from LIF file
invd = stereo_render_data.inv_convergence_distance;

// Or calculated from frustum skew
invd = Math.abs(view.frustum_skew.x) / 0.5;

// Modified by focus slider (0-1)
invd = focus * view.inv_z_map.min;
```

### Edge Feathering

The `taper()` function applies smooth edge falloff to avoid hard boundaries:

```glsl
float taper(vec2 uv) {
    return smoothstep(0.0, feathering, uv.x) *
           (1.0 - smoothstep(1.0 - feathering, 1.0, uv.x)) *
           smoothstep(0.0, feathering, uv.y) *
           (1.0 - smoothstep(1.0 - feathering, 1.0, uv.y));
}
```

---

## End of Document

This document should provide all necessary information to implement the fragment shader-based LIF rendering approach. The key insight is that the shader performs view-dependent raycasting to reconstruct 3D geometry on-the-fly, enabling efficient multi-layer and multi-view rendering in a single pass.
