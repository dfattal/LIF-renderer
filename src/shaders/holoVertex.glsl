
precision highp float;
precision highp int;
precision highp sampler2D;

// Vertex shader for holographic projector rendering
//
// BILLBOARD MODE (meshMode=0):
//   Each instance represents one pixel in the projector's image
//   Vertices positioned at pixel centers (i+0.5, j+0.5)
//   RGB sampled from pixel center
//   Depth sampled from pixel center
//
// MESH MODE (meshMode=1):
//   Vertices at pixel corners (i, j)
//   Pixel (i,j) has quad with corners: (i,j), (i+1,j), (i+1,j+1), (i,j+1)
//   Quad center at (i+0.5, j+0.5)
//   RGB sampled at pixel center (i+0.5, j+0.5) via UV interpolation
//   Vertex depth averaged from 4 neighboring pixel centers
//
// Note: position and uv attributes are automatically provided by THREE.js

out vec4 vColor;
out vec2 vQuadUV;
out vec2 vTexUV;

uniform sampler2D rgbTexture;
uniform sampler2D depthTexture;
uniform mat4 projectorMatrix;
uniform float fx;
uniform float fy;
uniform float cx;
uniform float cy;
uniform float imageWidth;
uniform float imageHeight;
uniform float invZMin;
uniform float invZMax;
uniform float baseline;
uniform float pointSize;
uniform float meshMode; // 0 = billboard mode, 1 = mesh mode with normals
uniform float deltaInvZThreshold; // Discard mesh elements if invZ range exceeds this (0 = show all)

// Constants for handling invZ = 0
const float EPSILON = 1e-8;
const float INF_Z = 1e6; // Map infinity to a very large but finite Z

// Helper function to reconstruct 3D position from pixel coordinates and depth
vec3 reconstruct3D(float px, float py, float depth) {
    return vec3(
        (px + 0.5 - cx) * depth / fx,
        (py + 0.5 - cy) * depth / fy,
        -depth
    );
}

// Helper function to get depth from depth map
float getDepth(vec2 uv) {
    float depthValue = texture(depthTexture, uv).r;
    float invZ = mix(invZMax, invZMin, depthValue);
    if (abs(invZ) < EPSILON) {
        return INF_Z;
    }
    return baseline / invZ;
}

// Helper function to average depth from 4 neighboring pixels
// For corner at (i,j), average depths from pixels (i-1,j-1), (i,j-1), (i-1,j), (i,j)
float sampleAveragedDepth(vec2 cornerPixelCoord) {
    // cornerPixelCoord is in pixel coordinates (0 to width, 0 to height)
    // For corner (i,j), we need to average from 4 surrounding pixel centers

    float cx = cornerPixelCoord.x;
    float cy = cornerPixelCoord.y;

    // The 4 pixels sharing this corner:
    // Top-left:    (cx-1, cy-1)
    // Top-right:   (cx, cy-1)
    // Bottom-left: (cx-1, cy)
    // Bottom-right:(cx, cy)

    // Clamp to valid pixel range [0, width-1] and [0, height-1]
    float px0 = max(0.0, cx - 1.0);
    float px1 = min(imageWidth - 1.0, cx);
    float py0 = max(0.0, cy - 1.0);
    float py1 = min(imageHeight - 1.0, cy);

    // Sample depth at 4 pixel centers
    vec2 uvTopLeft = (vec2(px0, py0) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uvTopRight = (vec2(px1, py0) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uvBottomLeft = (vec2(px0, py1) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uvBottomRight = (vec2(px1, py1) + 0.5) / vec2(imageWidth, imageHeight);

    float depthTopLeft = getDepth(uvTopLeft);
    float depthTopRight = getDepth(uvTopRight);
    float depthBottomLeft = getDepth(uvBottomLeft);
    float depthBottomRight = getDepth(uvBottomRight);

    // Simple average of the 4 depths
    float avgDepth = (depthTopLeft + depthTopRight + depthBottomLeft + depthBottomRight) * 0.25;

    return avgDepth;
}

void main() {
    // Default to outside the frustum so it's discarded if we return early
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

    int pixelX, pixelY;
    vec2 texUV;  // Texture sampling coordinates for color
    float depth;

    if (meshMode > 0.5) {
        // CONNECTED MESH MODE: Vertices are at pixel corners
        // UV contains corner coordinates (normalized 0 to 1)
        vec2 cornerPixelCoord = uv * vec2(imageWidth, imageHeight);

        // Average depth from 4 surrounding pixel centers
        depth = sampleAveragedDepth(cornerPixelCoord);

        // For color sampling in the fragment shader, we want to identify which pixel
        // this vertex belongs to. However, corner vertices are shared by multiple pixels.
        // We'll pass the corner UV and let the fragment shader handle interpolation.
        // The fragment shader will naturally interpolate between pixel centers.
        texUV = uv;

        // Pixel coordinates for this corner (used for 3D reconstruction)
        pixelX = int(cornerPixelCoord.x);
        pixelY = int(cornerPixelCoord.y);
    } else {
        // BILLBOARD MODE: Calculate from instance ID
        pixelX = gl_InstanceID % int(imageWidth);
        pixelY = gl_InstanceID / int(imageWidth);

        if (pixelY >= int(imageHeight)) {
            return; // Out of bounds
        }

        // Calculate UV coordinates for texture sampling
        texUV = (vec2(float(pixelX), float(pixelY)) + 0.5) / vec2(imageWidth, imageHeight);

        // Sample depth at pixel center
        float depthValue = texture(depthTexture, texUV).r;
        float invZ = mix(invZMax, invZMin, depthValue);
        if (abs(invZ) < EPSILON) {
            depth = INF_Z;
        } else {
            depth = baseline / invZ;
        }
    }

    // Reconstruct 3D position in projector's camera space
    // For connected mesh mode: corner at pixel coordinate (i,j) is placed at ray for (i,j)
    // For billboard mode: use pixel center coordinates (with +0.5 offset)
    vec3 posCamera;
    if (meshMode > 0.5) {
        // CONNECTED MESH: Corner is at exact pixel coordinate (i,j)
        // Using averaged depth from 4 surrounding pixel centers
        vec2 cornerPixelCoord = uv * vec2(imageWidth, imageHeight);
        posCamera = vec3(
            (cornerPixelCoord.x - cx) * depth / fx,
            (cornerPixelCoord.y - cy) * depth / fy,
            -depth
        );
    } else {
        // BILLBOARD: Pixel center at (i+0.5, j+0.5)
        posCamera = vec3(
            (float(pixelX) + 0.5 - cx) * depth / fx,
            (float(pixelY) + 0.5 - cy) * depth / fy,
            -depth
        );
    }

    // Transform to world space using projector's transform
    vec4 posWorld = projectorMatrix * vec4(posCamera, 1.0);

    // Transform to view space
    vec4 posView = viewMatrix * posWorld;

    // Sample RGB color first
    vColor = texture(rgbTexture, texUV);
    vColor.a = 1.0; // Full opacity for now

    // Pass texture UV to fragment shader for depth visualization
    vTexUV = texUV;

    // Discard points behind the camera (with small epsilon for numerical stability)
    if (posView.z >= -0.001) {
        return;
    }

    // For mesh mode: optionally cull faces with steep depth gradients
    if (meshMode > 0.5 && deltaInvZThreshold > 0.0) {
        // Sample depth at current pixel and neighbors (1 pixel step)
        float step = 1.0;
        float leftX = max(0.0, float(pixelX) - step);
        float rightX = min(imageWidth - 1.0, float(pixelX) + step);
        float upY = max(0.0, float(pixelY) - step);
        float downY = min(imageHeight - 1.0, float(pixelY) + step);

        // Get inverse depth values for neighboring pixels
        vec2 uvCenter = (vec2(float(pixelX), float(pixelY)) + 0.5) / vec2(imageWidth, imageHeight);
        vec2 uvLeft = (vec2(leftX, float(pixelY)) + 0.5) / vec2(imageWidth, imageHeight);
        vec2 uvRight = (vec2(rightX, float(pixelY)) + 0.5) / vec2(imageWidth, imageHeight);
        vec2 uvUp = (vec2(float(pixelX), upY) + 0.5) / vec2(imageWidth, imageHeight);
        vec2 uvDown = (vec2(float(pixelX), downY) + 0.5) / vec2(imageWidth, imageHeight);

        float invZCenter = texture(depthTexture, uvCenter).r;
        float invZLeft = texture(depthTexture, uvLeft).r;
        float invZRight = texture(depthTexture, uvRight).r;
        float invZUp = texture(depthTexture, uvUp).r;
        float invZDown = texture(depthTexture, uvDown).r;

        // Convert from [0,1] texture values to actual inverse depth values
        invZCenter = mix(invZMax, invZMin, invZCenter);
        invZLeft = mix(invZMax, invZMin, invZLeft);
        invZRight = mix(invZMax, invZMin, invZRight);
        invZUp = mix(invZMax, invZMin, invZUp);
        invZDown = mix(invZMax, invZMin, invZDown);

        // Find the range of inverse depth in the local neighborhood
        float minInvZ = min(min(min(min(invZCenter, invZLeft), invZRight), invZUp), invZDown);
        float maxInvZ = max(max(max(max(invZCenter, invZLeft), invZRight), invZUp), invZDown);
        float deltaInvZ = maxInvZ - minInvZ;

        // Cull if gradient exceeds threshold
        if (deltaInvZ > deltaInvZThreshold) {
            return; // Cull this vertex
        }
    }

    // Transform to clip space
    vec4 posClip = projectionMatrix * posView;

    // Let GPU handle frustum clipping - don't discard here
    // This prevents incorrect culling when camera is at extreme angles

    if (meshMode > 0.5) {
        // CONNECTED MESH MODE: Direct vertex placement (no quad offsetting)
        // The mesh topology handles connectivity between vertices
        gl_Position = posClip;
        vQuadUV = vec2(0.0, 0.0); // Not used for mesh rendering

    } else {
        // BILLBOARD MODE: Screen-aligned quads

        // Use the quad vertex position attribute (-1,-1,0)..(1,1,0)
        vec2 quadVertex = position.xy;
        vQuadUV = quadVertex;

        // Calculate point size based on projector pixel spacing
        // At distance d from projector, one pixel covers physical size d/fx
        float distToProjector = length(posCamera);
        float pixelSizeX = distToProjector / fx;
        float pixelSizeY = distToProjector / fy;

        // Convert physical size to NDC by projecting through view camera
        // ndcSize = worldSize * viewFocalLength / viewDepth
        vec2 ndcSize = vec2(
            pixelSizeX * projectionMatrix[0][0] / abs(posView.z),
            pixelSizeY * projectionMatrix[1][1] / abs(posView.z)
        );

        // Scale by pointSize parameter for overlap control
        vec2 offset = quadVertex * ndcSize * pointSize;

        // Apply offset in clip space
        gl_Position = posClip;
        gl_Position.xy += offset * posClip.w;

        // Ensure depth is correct (use center point depth, not quad corner depth)
        // This prevents depth fighting between corners of the same billboard
        gl_Position.z = posClip.z;
    }
}
