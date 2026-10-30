const fs = require('fs');
const path = require('path');

// Simple PNG to ICO converter
// ICO format: Header (6 bytes) + Entry (16 bytes) + PNG data
function pngToIco(pngPath, icoPath) {
    const png = fs.readFileSync(pngPath);
    
    // Read PNG dimensions from IHDR chunk
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    
    // ICO Header (6 bytes)
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);     // Reserved
    header.writeUInt16LE(1, 2);     // Type: 1 = ICO
    header.writeUInt16LE(1, 4);     // Count: 1 image

    // ICO Directory Entry (16 bytes)
    const entry = Buffer.alloc(16);
    entry.writeUInt8(width >= 256 ? 0 : width, 0);   // Width (0 = 256)
    entry.writeUInt8(height >= 256 ? 0 : height, 1);  // Height (0 = 256)
    entry.writeUInt8(0, 2);         // Color palette
    entry.writeUInt8(0, 3);         // Reserved
    entry.writeUInt16LE(1, 4);      // Color planes
    entry.writeUInt16LE(32, 6);     // Bits per pixel
    entry.writeUInt32LE(png.length, 8);  // Size of PNG data
    entry.writeUInt32LE(22, 12);    // Offset to PNG data (6 + 16 = 22)

    const ico = Buffer.concat([header, entry, png]);
    fs.writeFileSync(icoPath, ico);
    console.log(`ICO created: ${icoPath} (${ico.length} bytes)`);
}

pngToIco(
    path.join(__dirname, 'assets', 'icon-512.png'),
    path.join(__dirname, 'assets', 'icon-512.ico')
);
