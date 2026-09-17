import { config } from "../config.js";
import * as mock from "./mock.js";
import * as magichour from "./magichour.js";
import * as vmodel from "./vmodel.js";
import * as akool from "./akool.js";

/**
 * Every provider exports:
 *   swapVideo({ videoPath, facePath, outPath, log }) -> Promise<outPath>
 * It must download the finished swapped video to outPath.
 */
const providers = { mock, magichour, vmodel, akool };

export function getProvider(name = config.provider) {
  const p = providers[name];
  if (!p) throw new Error(`Unknown provider: ${name}`);
  return p;
}
