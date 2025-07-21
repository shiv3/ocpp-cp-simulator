#!/usr/bin/env node

import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const iconsDir = join(projectRoot, "src-tauri", "icons");

// Simple PNG generation using canvas-like approach
async function generatePNG(size) {
  // Create a simple blue square with white text as PNG
  // This is a simplified version - in production, use a proper image library
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#2563eb" rx="${size * 0.125}"/>
  <text x="${size / 2}" y="${size * 0.6}" font-family="Arial, sans-serif" font-size="${size * 0.15}" font-weight="bold" text-anchor="middle" fill="#ffffff">OCPP</text>
</svg>`;

  return svg;
}

async function createIcons() {
  try {
    await mkdir(iconsDir, { recursive: true });

    // For now, create placeholder files
    // In a real implementation, you would convert SVG to PNG using a library like sharp or canvas
    const sizes = [
      { name: "32x32.png", size: 32 },
      { name: "128x128.png", size: 128 },
      { name: "128x128@2x.png", size: 256 },
    ];

    for (const { name, size } of sizes) {
      const svg = await generatePNG(size);
      const svgPath = join(iconsDir, name.replace(".png", ".svg"));

      await fs.writeFile(svgPath, svg);
      console.log(`Created placeholder for ${name}`);
    }

    // Create empty ico and icns files for now
    await fs.writeFile(join(iconsDir, "icon.ico"), "");
    await fs.writeFile(join(iconsDir, "icon.icns"), "");

    console.log(
      "Icon placeholders created. For production, convert these to proper formats.",
    );
  } catch (error) {
    console.error("Error creating icons:", error);
    process.exit(1);
  }
}

createIcons();
