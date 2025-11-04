import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import glsl from "vite-plugin-glsl";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ command, mode }) => {
  const isBuild = command === "build";
  const isDemoBuild = mode === "demo";

  return {
    // Set base path for GitHub Pages deployment
    base: isDemoBuild ? "/LIF-renderer/" : "/",

    plugins: [
      glsl({
        include: ["**/*.glsl"],
      }),
      // Only generate types for library builds, not demo builds
      ...(isBuild && !isDemoBuild ? [dts({ outDir: "dist/types" })] : []),
    ],

    build: isBuild
      ? isDemoBuild
        ? {
            // Demo build: Build index.html and assets
            outDir: "dist-demo",
            sourcemap: true,
            rollupOptions: {
              input: {
                main: path.resolve(__dirname, "index.html"),
              },
            },
          }
        : {
            // Library build: Build as ES/CJS modules
            lib: {
              entry: path.resolve(__dirname, "src/index.ts"),
              name: "LIFRenderer",
              formats: ["es", "cjs"],
              fileName: (format) =>
                format === "es"
                  ? "lif-renderer.module.js"
                  : `lif-renderer.${format}.js`,
            },
            sourcemap: true,
            rollupOptions: {
              external: ["three"],
              output: {
                globals: {
                  three: "THREE",
                },
              },
            },
          }
      : {},

    server: {
      port: 8080,
    },

    resolve: {
      alias: {
        "lif-renderer": path.resolve(__dirname, "src/index.ts"),
      },
    },

    optimizeDeps: {
      exclude: ["three"],
    },
  };
});
