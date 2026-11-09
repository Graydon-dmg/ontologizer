// @ts-check
// The 3D add-on: only the 3D view, added to the page's views. The 3D bundle is the 2D bundle
// followed by this, each part run only if the page does not have it yet (scripts/build-embed.js),
// so it also works on a page where a 2D export already defined the element.
import '../views/sky/index.js';
import { listViews } from '../shared/view.js';
import { addViews } from './registry.js';

addViews(listViews());
