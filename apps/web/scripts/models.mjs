// Copies the models the 3D views use out of Kenney's CC0 packs into apps/web/public/models, with each pack's licence and texture.
// Usage: node scripts/models.mjs <folder holding the unzipped packs>
//   Each pack is unzipped into its own folder named after its zip (kenney_car-kit.zip into car-kit, and so on).
// Only the models listed here are kept, so the repository carries what the views draw and nothing else.
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKS = {
  characters: {
    from: 'mini-characters',
    title: 'Mini Characters',
    models: [
      'character-male-a',
      'character-male-b',
      'character-male-c',
      'character-male-d',
      'character-male-e',
      'character-male-f',
      'character-female-a',
      'character-female-b',
      'character-female-c',
      'character-female-d',
      'character-female-e',
      'character-female-f',
      'character-worker',
    ],
  },
  vehicles: { from: 'car-kit', title: 'Car Kit', models: ['ambulance', 'truck', 'truck-flat', 'delivery', 'van', 'sedan'] },
  industrial: {
    from: 'city-kit-industrial',
    title: 'City Kit (Industrial)',
    models: [
      'building-a',
      'building-b',
      'building-c',
      'building-d',
      'building-e',
      'building-f',
      'chimney-large',
      'chimney-medium',
      'detail-tank-large',
      'detail-tank',
      'water-tower',
      'windmill',
      'solar-panel-landscape-group',
      'shipping-container-a',
      'shipping-container-b',
      'shipping-container-c',
    ],
  },
  suburban: {
    from: 'city-kit-suburban',
    title: 'City Kit (Suburban)',
    models: [
      'building-type-a',
      'building-type-b',
      'building-type-c',
      'building-type-d',
      'building-type-e',
      'building-type-f',
      'building-type-g',
      'building-type-h',
      'tree-large',
      'tree-small',
    ],
  },
  commercial: {
    from: 'city-kit-commercial',
    title: 'City Kit (Commercial)',
    models: ['building-a', 'building-b', 'building-c', 'building-d', 'building-e', 'building-f', 'building-skyscraper-a', 'building-skyscraper-b'],
  },
  watercraft: { from: 'watercraft-pack', title: 'Watercraft Pack', models: ['ship-cargo-a', 'ship-cargo-b', 'boat-tug-a', 'cargo-pile-a'] },
  factory: {
    from: 'factory-kit',
    title: 'Factory Kit',
    models: [
      'robot-arm-a',
      'robot-arm-b',
      'conveyor-long',
      'conveyor',
      'machine',
      'machine-window',
      'scanner-high',
      'crane',
      'box-large',
      'box-small',
      'hopper-round',
      'screen-wide',
    ],
  },
  furniture: {
    from: 'furniture-kit',
    title: 'Furniture Kit',
    models: ['bedSingle', 'desk', 'deskCorner', 'chairDesk', 'computerScreen', 'laptop', 'cardboardBoxClosed', 'chair', 'pottedPlant'],
  },
  nature: { from: 'nature-kit', title: 'Nature Kit', models: ['tree_default', 'tree_cone', 'tree_detailed', 'tree_fat', 'rock_largeA', 'rock_largeB', 'rock_tallA'] },
};

const source = process.argv[2];
if (!source || !existsSync(source)) {
  console.error('Usage: node scripts/models.mjs <folder holding the unzipped packs>');
  process.exit(1);
}
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/models');

// The unzipped pack whose folder name starts with the pack's name, and every file under it, found by name
const packFolder = (name) => readdirSync(source).find((d) => d === name || d.startsWith(`${name}_`));
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));

rmSync(out, { recursive: true, force: true });
let bytes = 0;
const credits = [
  '# 3D models',
  '',
  'Every model here is from a pack by Kenney (https://kenney.nl), released under Creative Commons Zero (CC0).',
  'Each folder keeps its pack’s licence file. Copied by `node scripts/models.mjs`.',
  '',
];
for (const [slug, pack] of Object.entries(PACKS)) {
  const folder = packFolder(pack.from);
  if (!folder) {
    console.error(`missing pack: ${pack.from}`);
    continue;
  }
  const files = walk(path.join(source, folder));
  const glbs = files.filter((f) => f.endsWith('.glb') && f.includes('GLB'));
  const target = path.join(out, slug);
  mkdirSync(target, { recursive: true });
  for (const model of pack.models) {
    const file = glbs.find((f) => path.basename(f) === `${model}.glb`) ?? files.find((f) => path.basename(f) === `${model}.glb`);
    if (!file) {
      console.error(`missing model: ${pack.from}/${model}`);
      continue;
    }
    copyFileSync(file, path.join(target, `${model}.glb`));
    bytes += statSync(file).size;
  }
  // The pack's palette texture, which its models refer to as Textures/colormap.png
  const texture = files.find((f) => f.includes('GLB') && /Textures[\\/]colormap\.png$/.test(f));
  if (texture) {
    mkdirSync(path.join(target, 'Textures'), { recursive: true });
    copyFileSync(texture, path.join(target, 'Textures', 'colormap.png'));
    bytes += statSync(texture).size;
  }
  const licence = files.find((f) => /license\.txt$/i.test(f));
  if (licence) copyFileSync(licence, path.join(target, 'License.txt'));
  credits.push(`- \`${slug}/\`: ${pack.title}, ${pack.models.length} models`);
}
writeFileSync(path.join(out, 'CREDITS.md'), `${credits.join('\n')}\n`);
// Every model id, for the dev gallery (open the app at #gallery)
const ids = Object.entries(PACKS).flatMap(([slug, pack]) => pack.models.filter((m) => existsSync(path.join(out, slug, `${m}.glb`))).map((m) => `${slug}/${m}`));
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(ids));
console.log(`Copied ${(bytes / 1e6).toFixed(1)} MB into ${out}`);
