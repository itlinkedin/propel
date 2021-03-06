/**
 * @license
 * Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import * as test_util from "../test_util";
import { MathTests } from "../test_util";

import { Array2D, Array3D } from "./ndarray";

// math.transpose
{
  const tests: MathTests = it => {
    it("2D (no change)", math => {
      const t = Array2D.new([2, 4], [1, 11, 2, 22, 3, 33, 4, 44]);
      const t2 = math.transpose(t, [0, 1]);

      expect(t2.shape).toEqual(t.shape);
      test_util.expectArraysClose(t2, t);
    });

    it("2D (transpose)", math => {
      const t = Array2D.new([2, 4], [1, 11, 2, 22, 3, 33, 4, 44]);
      const t2 = math.transpose(t, [1, 0]);

      expect(t2.shape).toEqual([4, 2]);
      test_util.expectArraysClose(t2, [1, 3, 11, 33, 2, 4, 22, 44]);
    });

    it("2D int32 (transpose)", math => {
      const t = Array2D.new([1, 2], [1, 11], "int32");
      expect(t.dtype).toEqual("int32");
      const t2 = math.transpose(t, [1, 0]);
      expect(t2.dtype).toEqual("int32");
      expect(t2.shape).toEqual([2, 1]);
      test_util.expectArraysClose(t2, [1, 11]);
    });

    it("3D [r, c, d] => [d, r, c]", math => {
      const t = Array3D.new([2, 2, 2], [1, 11, 2, 22, 3, 33, 4, 44]);
      const t2 = math.transpose(t, [2, 0, 1]);

      expect(t2.shape).toEqual([2, 2, 2]);
      test_util.expectArraysClose(t2, [1, 2, 3, 4, 11, 22, 33, 44]);
    });

    it("3D [r, c, d] => [d, c, r]", math => {
      const t = Array3D.new([2, 2, 2], [1, 11, 2, 22, 3, 33, 4, 44]);
      const t2 = math.transpose(t, [2, 1, 0]);

      expect(t2.shape).toEqual([2, 2, 2]);
      test_util.expectArraysClose(t2, [1, 3, 2, 4, 11, 33, 22, 44]);
    });
  };

  test_util.describeMathCPU("transpose", [tests]);
  test_util.describeMathGPU("transpose", [tests], [
    {"WEBGL_VERSION": 1, "WEBGL_FLOAT_TEXTURE_ENABLED": true},
    {"WEBGL_VERSION": 2, "WEBGL_FLOAT_TEXTURE_ENABLED": true},
    {"WEBGL_VERSION": 1, "WEBGL_FLOAT_TEXTURE_ENABLED": false}
  ]);
}
