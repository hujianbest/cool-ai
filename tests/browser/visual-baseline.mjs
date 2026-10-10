import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

// Pixel baselines live per platform (font/AA rendering differs between
// darwin and win32) and are regenerated only by the smoke runners.
const baselineRoot = resolve("tests", "browser", "baselines");
const artifactRoot = resolve("tests", "browser", "test-artifacts");

// Fraction of pixels allowed to differ; per-pixel color distance threshold
// follows the pixelmatch default. Override with VISUAL_DIFF_THRESHOLD.
const maxDiffRatio = Number(process.env.VISUAL_DIFF_THRESHOLD ?? "0.002");

/**
 * Compare a smoke screenshot against its committed platform baseline.
 * Missing baselines (or UPDATE_VISUAL_BASELINES=1) write the baseline and
 * pass; any diff above the threshold fails the runner and drops artifacts
 * into tests/browser/test-artifacts/.
 *
 * @param {{ runner: string, name: string, screenshotPath: string }} options
 */
export function assertMatchesVisualBaseline({ runner, name, screenshotPath }) {
  const baselinePath = join(
    baselineRoot,
    process.platform,
    runner,
    `${name}.png`,
  );

  if (process.env.UPDATE_VISUAL_BASELINES === "1" || !existsSync(baselinePath)) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    copyFileSync(screenshotPath, baselinePath);
    console.log(
      `VISUAL BASELINE ${process.env.UPDATE_VISUAL_BASELINES === "1" ? "UPDATED" : "CREATED"}: ${baselinePath}`,
    );
    return;
  }

  const actual = PNG.sync.read(readFileSync(screenshotPath));
  const expected = PNG.sync.read(readFileSync(baselinePath));

  if (actual.width !== expected.width || actual.height !== expected.height) {
    mkdirSync(join(artifactRoot, runner), { recursive: true });
    copyFileSync(screenshotPath, join(artifactRoot, runner, `${name}-actual.png`));
    assert.fail(
      `VISUAL DIFF FAIL: ${runner}/${name} on ${process.platform}: screenshot is ${actual.width}x${actual.height}, baseline is ${expected.width}x${expected.height}. Actual saved to ${artifactRoot}. If intentional, rerun with UPDATE_VISUAL_BASELINES=1.`,
    );
  }

  const diff = new PNG({ width: expected.width, height: expected.height });
  const mismatchedPixels = pixelmatch(
    actual.data,
    expected.data,
    diff.data,
    expected.width,
    expected.height,
    { threshold: 0.1 },
  );
  const totalPixels = expected.width * expected.height;
  const ratio = mismatchedPixels / totalPixels;

  if (ratio > maxDiffRatio) {
    mkdirSync(join(artifactRoot, runner), { recursive: true });
    writeFileSync(
      join(artifactRoot, runner, `${name}-diff.png`),
      PNG.sync.write(diff),
    );
    copyFileSync(screenshotPath, join(artifactRoot, runner, `${name}-actual.png`));
    copyFileSync(baselinePath, join(artifactRoot, runner, `${name}-baseline.png`));
    assert.fail(
      `VISUAL DIFF FAIL: ${runner}/${name} on ${process.platform}: ${mismatchedPixels}/${totalPixels} px (${(ratio * 100).toFixed(3)}%) differ, threshold ${(maxDiffRatio * 100).toFixed(2)}%. Diff artifacts in ${artifactRoot}. If intentional, rerun with UPDATE_VISUAL_BASELINES=1.`,
    );
  }

  console.log(
    `VISUAL DIFF PASS: ${runner}/${name} (${mismatchedPixels} px, ${(ratio * 100).toFixed(3)}% <= ${(maxDiffRatio * 100).toFixed(2)}%)`,
  );
}
