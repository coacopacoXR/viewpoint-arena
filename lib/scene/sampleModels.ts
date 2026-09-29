// The model that ships with the app, offered as a SAMPLE.
//
// A room starts empty and says so. A sample is here because a room with nothing
// in it has nothing to point at, and a first run or a demo needs something to
// show. A person chooses it, and that choosing is the scene operation it always was
// (`setBuiltIn`), so it obeys the room server and the "who may change models"
// permission exactly like an import does.
//
// Kept out of lib/scene/roomScene.ts on purpose: that module is pure and the room
// server imports it into workerd, and the words on a menu button are not something
// a server has any use for.

import type { BuiltInModel } from './roomScene';

/** One sample: the scene's own spelling of it, and what a menu calls it. */
export interface SampleModel {
  builtIn: BuiltInModel;
  label: string;
}

/** Every sample, in the order both places that offer one show them. */
export const SAMPLE_MODELS: SampleModel[] = [
  { builtIn: 'synth', label: 'Synth assembly' },
];
