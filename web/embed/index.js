// @ts-check
// The 2D embed bundle: the graph view and the element. The views register before the element is
// defined, because defining it upgrades elements already in the page.
import '../views/graph/index.js';
import { defineMapElement } from './element.js';

defineMapElement();
