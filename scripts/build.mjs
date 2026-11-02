import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, lstat, rm, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const inside = (root, target) => { const relative = path.relative(root, target); return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

export function normalizeBasePath(basePath) {
  if (typeof basePath !== 'string' || !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]*$/.test(basePath)
    || basePath.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Invalid base path');
  return basePath.endsWith('/') ? basePath : `${basePath}/`;
}

async function owned(root, name) {
  if (!['dist', '.build-staging'].includes(name)) throw new Error('Unowned build directory');
  const target = path.resolve(root, name);
  if (!inside(root, target)) throw new Error('Build directory escaped its root');
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || await realpath(target) !== target) throw new Error('Build directory must not be a link');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

async function sources(directory, relative = '') {
  const files = [];
  for (const entry of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source link is not permitted: ${name}`);
    if (entry.isDirectory()) files.push(...await sources(directory, name));
    else if (entry.isFile()) files.push({ name, data: await readFile(path.join(directory, name)) });
  }
  return files;
}

async function previousAssets(previousDirectory) {
  if (previousDirectory === undefined) return [];
  const previous = path.resolve(previousDirectory);
  if ((await lstat(previous)).isSymbolicLink()) throw new Error('Previous artifact must not be a link');
  const assets = path.join(await realpath(previous), 'assets');
  try {
    const info = await lstat(assets);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Previous assets must be a directory without links');
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of await readdir(assets, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Previous asset link is not permitted');
    if (!/^[a-f0-9]{12,64}$/.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error('Previous asset identity must name a directory');
    for (const file of await sources(path.join(assets, entry.name))) files.push({ name: path.join(entry.name, file.name), data: file.data });
  }
  return files;
}

export async function build({ root = process.cwd(), basePath = '/', previousDirectory } = {}) {
  basePath = normalizeBasePath(basePath);
  root = await realpath(path.resolve(root));
  const directory = await owned(root, 'dist');
  const staging = await owned(root, '.build-staging');
  const files = await sources(path.join(root, 'src'));
  const retained = await previousAssets(previousDirectory);
  const entry = files.find(file => file.name === 'index.html');
  if (!entry) throw new Error('src/index.html is required');
  const template = entry.data.toString('utf8');
  if (!template.includes('__BUILD_ID__') || !template.includes('__ASSET_BASE__')) throw new Error('HTML build tokens are required');
  const hash = createHash('sha256').update(basePath).update('\0');
  for (const file of files) hash.update(file.name.replaceAll(path.sep, '/')).update('\0').update(file.data).update('\0');
  const buildId = hash.digest('hex').slice(0, 16);
  const assetBase = `${basePath}assets/${buildId}`;
  await rm(await owned(root, '.build-staging'), { recursive: true, force: true });
  await mkdir(path.join(staging, 'assets', buildId), { recursive: true });
  for (const file of retained) {
    const output = path.join(staging, 'assets', file.name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, file.data);
  }
  for (const file of files) {
    if (file.name === 'index.html') continue;
    const output = path.join(staging, 'assets', buildId, file.name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, file.data);
  }
  await writeFile(path.join(staging, 'index.html'), template.replaceAll('__BUILD_ID__', buildId).replaceAll('__ASSET_BASE__', assetBase));
  await writeFile(path.join(staging, 'version.json'), JSON.stringify({ buildId }) + '\n');
  await writeFile(path.join(staging, '.nojekyll'), '');
  await writeFile(path.join(staging, '404.html'), `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>404 · CHECKSUM RUSH</title><body style="background:#080b10;color:#dcff63;font-family:system-ui;padding:8vw"><h1>404 · SIGNAL LOST</h1><p>요청한 파일을 찾을 수 없습니다.</p><a style="color:#dcff63" href="${basePath}">CHECKSUM RUSH로 돌아가기</a></body></html>`);
  await writeFile(path.join(staging, '_headers'), '/\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-store\n/version.json\n  Cache-Control: no-store\n/404.html\n  Cache-Control: no-store\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/*\n  X-Content-Type-Options: nosniff\n');
  await rm(await owned(root, 'dist'), { recursive: true, force: true });
  await rename(await owned(root, '.build-staging'), directory);
  return { buildId, directory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    while (args.length) {
      const flag = args.shift();
      if (!['--base', '--previous'].includes(flag) || !args.length) throw new Error(`Unknown or incomplete option: ${flag}`);
      options[flag === '--base' ? 'basePath' : 'previousDirectory'] = args.shift();
    }
    const result = await build(options);
    console.log(`Built CHECKSUM RUSH ${result.buildId} → ${result.directory}`);
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
