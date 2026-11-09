// @ts-check
// The 2D and 3D embed bundle. Views register first, then the element is defined.
import '../views/graph/index.js';
import '../views/sky/index.js';
import { defineMapElement } from './element.js';

defineMapElement();
