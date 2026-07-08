const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const fixturesDir = path.join(__dirname);

const fixtures = [
  { name: 'test_video_small.mp4', duration: 2, size: '320x240' },
  { name: 'test_video_medium.mp4', duration: 3, size: '640x480' },
];

for (const f of fixtures) {
  const outPath = path.join(fixturesDir, f.name);
  if (fs.existsSync(outPath)) {
    console.log(`Fixture already exists: ${f.name}`);
    continue;
  }

  console.log(`Generating fixture: ${f.name} (${f.duration}s, ${f.size})`);
  execFileSync('ffmpeg', [
    '-f', 'lavfi',
    '-i', `testsrc=duration=${f.duration}:size=${f.size}:rate=24`,
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${f.duration}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-c:a', 'aac',
    '-shortest',
    '-y',
    outPath,
  ], { stdio: 'pipe' });

  const stat = fs.statSync(outPath);
  console.log(`  Created: ${f.name} (${stat.size} bytes)`);
}

console.log('Fixture generation complete.');
