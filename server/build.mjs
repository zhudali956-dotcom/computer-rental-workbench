import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive:true });
await build({ entryPoints:['src/app.jsx'], bundle:true, minify:true, jsx:'automatic', define:{'process.env.NODE_ENV':'"production"'}, outfile:'dist/app.js' });
await copyFile('src/index.html','dist/index.html');
