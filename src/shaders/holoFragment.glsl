
precision highp float;
precision highp int;
precision highp sampler2D;

// Fragment shader for holographic projector rendering

in vec4 vColor;
in vec2 vQuadUV;
in vec2 vTexUV;

out vec4 fragColor;

uniform float maxStdDev;
uniform float meshMode;
uniform float showDepth;
uniform sampler2D depthTexture;
uniform float invZMin;
uniform float invZMax;

// Linear to sRGB conversion (gamma correction)
vec3 linearTosRGB(vec3 linear) {
    // sRGB standard gamma curve
    vec3 sRGB;
    sRGB.r = (linear.r <= 0.0031308) ? linear.r * 12.92 : 1.055 * pow(linear.r, 1.0/2.4) - 0.055;
    sRGB.g = (linear.g <= 0.0031308) ? linear.g * 12.92 : 1.055 * pow(linear.g, 1.0/2.4) - 0.055;
    sRGB.b = (linear.b <= 0.0031308) ? linear.b * 12.92 : 1.055 * pow(linear.b, 1.0/2.4) - 0.055;
    return sRGB;
}

void main() {
    // Output color - check visualization mode
    if (showDepth > 0.5) {
        // Depth visualization mode: show depth as grayscale
        float depthValue = texture(depthTexture, vTexUV).r;

        // Convert to a visible grayscale value (invert so near is bright, far is dark)
        fragColor = vec4(vec3(depthValue), 1.0);
    } else {
        // Normal RGB rendering
        fragColor = vColor;
    }

    // Apply linear to sRGB conversion for proper display
    fragColor.rgb = linearTosRGB(fragColor.rgb);

    if (meshMode > 0.5) {
        // CONNECTED MESH MODE: Solid surface, no edge softening
        // Keep full alpha and don't premultiply (alpha is 1.0)
        fragColor.a = 1.0;
    } else {
        // BILLBOARD MODE: Apply edge softening to reduce aliasing

        // Calculate distance to edge of square (in range 0 at center, 1 at edge)
        float edgeDist = max(abs(vQuadUV.x), abs(vQuadUV.y));

        // Soft edge falloff (only affects outer 10% of quad)
        float edgeSoftness = 0.1;
        float falloff = 1.0 - smoothstep(1.0 - edgeSoftness, 1.0, edgeDist);

        // Apply edge softening
        fragColor.a *= falloff;

        // Discard nearly transparent fragments
        if (fragColor.a < 0.01) {
            discard;
        }

        // Premultiply alpha for correct blending with depth
        fragColor.rgb *= fragColor.a;
    }
}
