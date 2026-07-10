const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Use PowerShell Expand-Archive to a temp directory and then copy the file
const zipPath = 'c:\\Users\\xanki\\OneDrive\\Documents\\UMC\\tally-connector\\tally-connector-be.zip';
const tempDir = 'c:\\Users\\xanki\\OneDrive\\Documents\\UMC\\tally-connector\\tally-connector-be-temp-extract';
const targetFile = 'c:\\Users\\xanki\\OneDrive\\Documents\\UMC\\tally-connector\\tally-connector-be\\src\\services\\user.service.js';

try {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  fs.mkdirSync(tempDir, { recursive: true });
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempDir}'"`);
  
  const extractedFile = path.join(tempDir, 'src/services/user.service.js');
  if (fs.existsSync(extractedFile)) {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(extractedFile, targetFile);
    console.log('Successfully extracted user.service.js');
  } else {
    console.error('user.service.js not found in zip');
  }
} catch (err) {
  console.error(err);
} finally {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
