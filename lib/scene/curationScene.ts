// The scene a curated review means.
//
// A curation stores one model — `asset.modelHash` and the name it was uploaded
// under — because a curation was written when a room showed exactly one model.
// Opening it now makes that a scene holding one model, which is the same claim
// in the new shape, and it is the reason a review still opens with the product
// its viewpoints and pins were placed on.

import {
  FIRST_REVISION,
  lineFromFileName,
  sceneModelId,
  type RoomScene,
  type SceneModel,
} from './roomScene';

/**
 * The curation's model as a scene model.
 *
 * The id comes from the hash, so the model a curator placed pins on in the setup
 * page and the model the room shows when that curation is opened are the SAME
 * scene model — and therefore have the same node ids, which is what a pin
 * points at. A randomly generated id here would have made every pin from every
 * existing curation resolve to nothing.
 *
 * It is the first revision of a line named after the file, because that is what
 * a single uploaded model is: Rev A of itself. A room that later adds a
 * variation continues the line rather than starting another.
 */
export function curationSceneModel(hash: string, fileName: string): SceneModel {
  return {
    id: sceneModelId(hash),
    hash,
    fileName,
    line: lineFromFileName(fileName),
    revision: FIRST_REVISION,
    visible: true,
    offset: [0, 0, 0],
  };
}

/** The one-model scene a curated review opens with. */
export function curationScene(hash: string, fileName: string): RoomScene {
  return { models: [curationSceneModel(hash, fileName)], builtIn: null };
}

/**
 * A curation whose model is still inline bytes, and which therefore has no hash.
 *
 * The empty hash is the marker the loader looks for: there is nothing to fetch,
 * so it leaves this model alone and the caller that has the bytes parses them
 * itself. The id is derived from the file name because there is no content
 * address to derive it from, and it still has to be the same every time this
 * draft is opened or the pins that name its meshes would resolve to nothing.
 */
export function legacyCurationModel(fileName: string): SceneModel {
  const line = lineFromFileName(fileName);
  return {
    id: `legacy-${line}`,
    hash: '',
    fileName,
    line,
    revision: FIRST_REVISION,
    visible: true,
    offset: [0, 0, 0],
  };
}
