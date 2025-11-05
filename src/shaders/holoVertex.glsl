
precision highp float;
precision highp int;
precision highp sampler2D;

// Vertex shader for holographic projector rendering
// Each instance represents one pixel in the projector's image
// Note: position and uv attributes are automatically provided by THREE.js

out vec4 vColor;
out vec2 vQuadUV;
out vec2 vTexUV;
out float vNormalZ; // Surface normal Z component (in projector camera space)

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
uniform float cullSteepFaces; // 1 = cull steep/back-facing surfaces, 0 = show all

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

// Compute surface normal from neighboring depth samples
vec3 computeSurfaceNormal(int pixelX, int pixelY, float centerDepth) {
    // Sample step (can adjust for smoother/sharper normals)
    float step = 1.0;

    // Clamp to valid pixel range
    float leftX = max(0.0, float(pixelX) - step);
    float rightX = min(imageWidth - 1.0, float(pixelX) + step);
    float upY = max(0.0, float(pixelY) - step);
    float downY = min(imageHeight - 1.0, float(pixelY) + step);

    // Get depths for neighboring pixels
    vec2 uvLeft = (vec2(leftX, float(pixelY)) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uvRight = (vec2(rightX, float(pixelY)) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uvUp = (vec2(float(pixelX), upY) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uvDown = (vec2(float(pixelX), downY) + 0.5) / vec2(imageWidth, imageHeight);

    float depthLeft = getDepth(uvLeft);
    float depthRight = getDepth(uvRight);
    float depthUp = getDepth(uvUp);
    float depthDown = getDepth(uvDown);

    // Reconstruct 3D positions
    vec3 posCenter = reconstruct3D(float(pixelX), float(pixelY), centerDepth);
    vec3 posLeft = reconstruct3D(leftX, float(pixelY), depthLeft);
    vec3 posRight = reconstruct3D(rightX, float(pixelY), depthRight);
    vec3 posUp = reconstruct3D(float(pixelX), upY, depthUp);
    vec3 posDown = reconstruct3D(float(pixelX), downY, depthDown);

    // Compute tangent vectors
    vec3 tangentX = posRight - posLeft;
    vec3 tangentY = posDown - posUp;

    // Cross product to get normal (normalize)
    vec3 normal = normalize(cross(tangentX, tangentY));

    return normal;
}

// Build rotation matrix to align Z-axis with given normal
mat3 buildRotationMatrix(vec3 normal) {
    // Target: rotate (0,0,1) to align with normal
    vec3 up = vec3(0.0, 0.0, 1.0);

    // If normal is nearly aligned with up, use a default frame
    if (abs(dot(normal, up)) > 0.999) {
        return mat3(1.0);
    }

    // Build orthonormal basis with normal as the new Z
    vec3 tangent = normalize(cross(up, normal));
    vec3 bitangent = cross(normal, tangent);

    // Rotation matrix (columns are the new basis vectors)
    return mat3(tangent, bitangent, normal);
}

// Helper function to sample depth with bilinear interpolation from 4 surrounding pixels
float sampleInterpolatedDepth(vec2 cornerPixelCoord) {
    // cornerPixelCoord is in pixel coordinates (0 to width, 0 to height)
    // We need to sample from the 4 surrounding pixel CENTERS

    // Get the 4 surrounding pixel center coordinates
    float px = cornerPixelCoord.x - 0.5;  // Offset to pixel centers
    float py = cornerPixelCoord.y - 0.5;

    // Get integer pixel indices and fractional parts for interpolation
    float px0 = floor(px);
    float py0 = floor(py);
    float px1 = px0 + 1.0;
    float py1 = py0 + 1.0;
    float fx = fract(px);
    float fy = fract(py);

    // Clamp to valid pixel range
    px0 = clamp(px0, 0.0, imageWidth - 1.0);
    px1 = clamp(px1, 0.0, imageWidth - 1.0);
    py0 = clamp(py0, 0.0, imageHeight - 1.0);
    py1 = clamp(py1, 0.0, imageHeight - 1.0);

    // Sample depth at 4 pixel centers
    vec2 uv00 = (vec2(px0, py0) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uv10 = (vec2(px1, py0) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uv01 = (vec2(px0, py1) + 0.5) / vec2(imageWidth, imageHeight);
    vec2 uv11 = (vec2(px1, py1) + 0.5) / vec2(imageWidth, imageHeight);

    float depth00 = getDepth(uv00);
    float depth10 = getDepth(uv10);
    float depth01 = getDepth(uv01);
    float depth11 = getDepth(uv11);

    // Bilinear interpolation
    float depth0 = mix(depth00, depth10, fx);
    float depth1 = mix(depth01, depth11, fx);
    float depth = mix(depth0, depth1, fy);

    return depth;
}

void main() {
    // Default to outside the frustum so it's discarded if we return early
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);

    int pixelX, pixelY;
    vec2 texUV;  // Texture sampling coordinates for color
    float depth;

    if (meshMode > 0.5) {
        // CONNECTED MESH MODE: Vertices are at pixel corners
        // UV contains corner coordinates (normalized)
        vec2 cornerPixelCoord = uv * vec2(imageWidth, imageHeight);

        // Interpolate depth from 4 surrounding pixel centers
        depth = sampleInterpolatedDepth(cornerPixelCoord);

        // For color sampling, use the corner UV directly
        // (will blend colors from surrounding pixels)
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
    // For connected mesh mode: use corner coordinates directly (no +0.5 offset)
    // For billboard mode: use pixel center coordinates (with +0.5 offset)
    vec3 posCamera;
    if (meshMode > 0.5) {
        // CONNECTED MESH: Corner is at exact pixel coordinate
        vec2 cornerPixelCoord = uv * vec2(imageWidth, imageHeight);
        posCamera = vec3(
            (cornerPixelCoord.x - cx) * depth / fx,
            (cornerPixelCoord.y - cy) * depth / fy,
            -depth
        );
    } else {
        // BILLBOARD: Pixel center has +0.5 offset
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

    // Compute surface normal for visualization
    vec3 surfaceNormal = computeSurfaceNormal(pixelX, pixelY, depth);
    // Clamp normal.z to [0, 1] range (0 = perpendicular, 1 = facing projector)
    // Projector looks down -Z, so surfaces facing it have positive normal.z
    vNormalZ = max(0.0, surfaceNormal.z);

    // Discard points behind the camera (with small epsilon for numerical stability)
    if (posView.z >= -0.001) {
        return;
    }

    // For mesh mode: optionally cull back-facing triangles relative to projector
    if (meshMode > 0.5 && cullSteepFaces > 0.5) {
        // Compute surface normal from depth map
        vec3 normal = computeSurfaceNormal(pixelX, pixelY, depth);

        // Normal is in camera (projector) space
        // Projector looks down -Z, so surfaces facing projector have normal.z > 0
        // Cull if angle > 45 degrees (dot product < cos(45°) = 0.707)
        if (normal.z < 0.7) {
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
