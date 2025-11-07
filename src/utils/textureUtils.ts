import * as THREE from "three";

/**
 * Loads an image from a URL (typically a blob URL from LIF metadata)
 * @param url - The URL to load the image from
 * @returns Promise resolving to the loaded HTMLImageElement
 */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
  });
}

/**
 * Creates a 4-channel RGBA texture combining depth map and mask
 * RGB channels contain the depth data, Alpha channel contains the mask
 * @param depthImageUrl - URL to the inverse depth map image
 * @param maskImageUrl - Optional URL to the mask image
 * @returns THREE.CanvasTexture with combined depth+mask data
 */
export async function createDepthMaskTexture(
  depthImageUrl: string,
  maskImageUrl?: string
): Promise<THREE.CanvasTexture> {
  // Load the depth image
  const depthImage = await loadImage(depthImageUrl);

  const width = depthImage.width;
  const height = depthImage.height;

  // Create a canvas to combine the images
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  // Enable willReadFrequently for optimization
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Failed to get 2D context from canvas");
  }

  // Draw depth image and extract pixel data
  ctx.drawImage(depthImage, 0, 0, width, height);
  const depthData = ctx.getImageData(0, 0, width, height).data;

  let maskData: Uint8ClampedArray | null = null;

  // Load and extract mask data if provided
  if (maskImageUrl) {
    const maskImage = await loadImage(maskImageUrl);

    // Clear canvas before drawing mask
    ctx.clearRect(0, 0, width, height);

    // Draw mask image
    ctx.drawImage(maskImage, 0, 0, width, height);
    maskData = ctx.getImageData(0, 0, width, height).data;
  }

  // Create combined image data
  const combinedData = ctx.createImageData(width, height);
  const combinedPixels = combinedData.data;

  // Combine: RGB from depth, A from mask (or full opacity if no mask)
  for (let i = 0; i < depthData.length; i += 4) {
    // Copy RGB from depth map
    combinedPixels[i] = depthData[i]; // R
    combinedPixels[i + 1] = depthData[i + 1]; // G
    combinedPixels[i + 2] = depthData[i + 2]; // B

    // Alpha from mask (red channel) or full opacity
    if (maskData) {
      combinedPixels[i + 3] = maskData[i]; // A from mask R channel
    } else {
      combinedPixels[i + 3] = 255; // Full opacity
    }
  }

  // Put combined data back on canvas
  ctx.putImageData(combinedData, 0, 0);

  // Create THREE.js texture from canvas
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.LinearSRGBColorSpace; // Depth is linear
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  return texture;
}

/**
 * Creates a standard RGB texture from an image URL
 * @param imageUrl - URL to the RGB image
 * @returns THREE.Texture with the loaded image
 */
export async function createRGBTexture(
  imageUrl: string
): Promise<THREE.Texture> {
  const image = await loadImage(imageUrl);

  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace; // RGB images are in sRGB
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return texture;
}

/**
 * Calculates viewport scale factor for focal length adjustment
 * @param imageWidth - Source image width
 * @param imageHeight - Source image height
 * @param viewportWidth - Target viewport width
 * @param viewportHeight - Target viewport height
 * @returns Scale factor
 */
export function calculateViewportScale(
  imageWidth: number,
  imageHeight: number,
  viewportWidth: number,
  viewportHeight: number
): number {
  return (
    Math.min(viewportWidth, viewportHeight) /
    Math.min(imageWidth, imageHeight)
  );
}
