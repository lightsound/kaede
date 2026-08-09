/**
 * AssetPack config (Phase 5 ①b — factory stage ⑤).
 *
 * The source of truth stays the individual pose PNGs + manifests under
 * `src/game.package` (asset-pipeline.md §1). This config only builds the
 * delivery atlas derivative from a prepared `{tps}` staging folder that
 * `scripts/factory/prepare_assetpack.py` fills. Output is gitignored.
 */
import { texturePacker } from '@assetpack/core/texture-packer';

export default {
  entry: './raw-assets',
  output: './atlas-out',
  pipes: [
    texturePacker({
      texturePacker: {
        padding: 2,
        nameStyle: 'relative',
        removeFileExtension: false,
        textureFormat: 'png',
      },
      resolutionOptions: {
        template: '@%%x',
        resolutions: { default: 1 },
        fixedResolution: 'default',
        maximumTextureSize: 2048,
      },
    }),
  ],
};
