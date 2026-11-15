// @ts-check
// Answer texts shared by the router and the map actions (kept here so actions/* need not import
// service.js, which would be an import cycle: service → map → actions → service).

/** 409 while a save of the map is in progress. */
export const SAVING = 'The map is being saved under a new name: open it by its new name.';
/** 409 while the map is busy. */
export const BUSY = 'The map is busy: try again when it is idle.';
