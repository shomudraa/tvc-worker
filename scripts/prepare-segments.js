import { prepareSegments } from "../worker/pipeline.js";
const m = await prepareSegments({ force: true });
console.log(`master ${m.total.toFixed(2)}s, ${m.width}x${m.height}`);
for (const p of m.pieces) console.log(`  ${p.index} ${p.kind.padEnd(4)} ${p.start}-${p.end}s -> ${p.file}`);
console.log(`joined face file: ${m.joinedFace}`);
