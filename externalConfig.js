import { readdirSync } from 'fs';
import path from 'path';
import { ReflectionKind } from 'typedoc';

/** @param {import('typedoc').Application} app */
async function load(app) {
  const dir = readdirSync('node_modules/eludris-api-types/dist');
  const response = await fetch(
    `https://next-eludris-api-types.vercel.app/api.json`,
  );
  /** @type {import('typedoc').JSONOutput.ContainerReflection} */
  const inventory = await response.json();
  const latest = inventory.children
    .map((child) => child.name)
    .sort()
    .at(-1);

  app.converter.addUnknownSymbolResolver(
    (declaration, reflection, part, symbolId) => {
      console.log(declaration, reflection, part, symbolId);
      let filePath = path
        .basename(symbolId?.fileName ?? latest)
        .replace('.d.ts', '');
      const versionInventory = inventory.children.find(
        (child) => child.name === filePath,
      );
      filePath = filePath.replace(/\.|-/g, '_');
      if (declaration.moduleSource !== 'eludris-api-types') {
        return;
      }

      const name = declaration.symbolReference.path[0].path;
      const declarationType = versionInventory.children.find(
        (child) => child.name === name,
      );
      const type = ReflectionKind[declarationType.kind].toLowerCase() + 's';
      console.log(type);
      return `https://next-eludris-api-types.vercel.app/${type}/${filePath}.${name}.html`;
    },
  );
}

export { load };
