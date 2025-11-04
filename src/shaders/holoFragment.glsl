
precision highp float;
precision highp int;

// Fragment shader for holographic projector rendering

in vec4 vColor;
in vec2 vQuadUV;

out vec4 fragColor;

uniform float maxStdDev;
uniform float meshMode;

void main() {
    // Output color
    fragColor = vColor;

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
