import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Container integration tests import the bundled browser parser. Resolve
// its bare imports using the widget's own import map, without adding
// development dependencies to the production image.
const widget = new URL('../../public/widgets/gcode-viz/index.html', import.meta.url);
const html = readFileSync(widget, 'utf8');
const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
const aliases = new Map(['three', 'lil-gui'].map(name => {
  const url = new URL(map[name], widget);
  if (url.protocol !== 'file:') throw new Error(`Expected a bundled browser import for ${name}`);
  return [name, url.href];
}));

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(aliases.get(specifier) ?? specifier, context);
  },
});
