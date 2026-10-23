import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { unzipPhotos } from "./PhotoDrop";

describe("the sample pack", () => {
  it("unzips its photos in name order, leaving the text files and macOS folders out", async () => {
    const zip = zipSync({
      "pack/SIGHTLINE_f0257.jpg": new Uint8Array([0xff, 0xd8, 2]),
      "pack/SIGHTLINE_f0256.jpg": new Uint8Array([0xff, 0xd8, 1]),
      "pack/README.txt": new Uint8Array([65]),
      "__MACOSX/pack/._SIGHTLINE_f0256.jpg": new Uint8Array([0]),
    });
    const items = await unzipPhotos(zip.buffer as ArrayBuffer);
    expect(items.map((i) => i.name)).toEqual(["SIGHTLINE_f0256.jpg", "SIGHTLINE_f0257.jpg"]);
    expect(items[0]!.blob.type).toBe("image/jpeg");
  });
});
