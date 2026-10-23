import { describe, expect, it } from "vitest";
import { footprintRadiusM, readPose } from "./exif";

/** A JPEG with only an EXIF GPS block (big-endian TIFF) and, optionally, DJI XMP. */
function jpeg(xmp?: string): ArrayBuffer {
  const tiff: number[] = [];
  const u16 = (n: number) => tiff.push((n >> 8) & 255, n & 255);
  const u32 = (n: number) => tiff.push((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const entry = (tag: number, type: number, count: number, value: number[]) => {
    u16(tag);
    u16(type);
    u32(count);
    tiff.push(...value, ...new Array(4 - value.length).fill(0));
  };
  const be32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  tiff.push(0x4d, 0x4d); // "MM"
  u16(42);
  u32(8);
  u16(1); // IFD0: the GPS pointer
  entry(0x8825, 4, 1, be32(26));
  u32(0);
  u16(5); // the GPS IFD at 26; its values at 92
  entry(1, 2, 2, [78, 0]); // N
  entry(2, 5, 3, be32(92));
  entry(3, 2, 2, [87, 0]); // W
  entry(4, 5, 3, be32(116));
  entry(0x11, 5, 1, be32(140));
  u32(0);
  for (const [n, d] of [[49, 1], [22, 1], [1212, 100], [122, 1], [56, 1], [4200, 100], [90, 1]]) {
    u32(n!);
    u32(d!);
  }
  const app = (payload: number[]) => [0xff, 0xe1, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload];
  const exif = app([...[..."Exif"].map((c) => c.charCodeAt(0)), 0, 0, ...tiff]);
  const x = xmp ? app([..."http://ns.adobe.com/xap/1.0/\0".split("").map((c) => c.charCodeAt(0)), ...[...xmp].map((c) => c.charCodeAt(0))]) : [];
  return new Uint8Array([0xff, 0xd8, ...exif, ...x, 0xff, 0xd9]).buffer;
}

describe("a drone photo's position", () => {
  it("reads EXIF GPS: latitude, longitude, the image direction", () => {
    const p = readPose(jpeg())!;
    expect(p.lat).toBeCloseTo(49 + 22 / 60 + 12.12 / 3600, 6);
    expect(p.lon).toBeCloseTo(-(122 + 56 / 60 + 42 / 3600), 6);
    expect(p.heading).toBe(90);
    expect(p.relAlt).toBeNull();
  });

  it("reads DJI's relative altitude from XMP", () => {
    expect(readPose(jpeg('<x:xmpmeta><rdf:Description drone-dji:RelativeAltitude="+48.5" drone-dji:FlightYawDegree="-30.2"/></x:xmpmeta>'))!.relAlt).toBe(48.5);
  });

  it("reads DJI's fields from a comment segment too (the sample pack writes them there)", () => {
    const base = new Uint8Array(jpeg());
    const text = '<x:xmpmeta drone-dji:RelativeAltitude="+50.0" drone-dji:GimbalYawDegree="+90.0"/>';
    const com = [0xff, 0xfe, ((text.length + 2) >> 8) & 255, (text.length + 2) & 255, ...[...text].map((c) => c.charCodeAt(0))];
    const withCom = new Uint8Array([...base.slice(0, -2), ...com, 0xff, 0xd9]);
    const p = readPose(withCom.buffer)!;
    expect(p.relAlt).toBe(50);
    expect(p.heading).toBe(90); // EXIF's image direction wins when both are there
  });

  it("has no position without GPS, or for something that is not a JPEG", () => {
    expect(readPose(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer)).toBeNull();
    expect(readPose(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer)).toBeNull();
  });

  it("sizes the footprint from the height, within sane bounds", () => {
    expect(footprintRadiusM(50)).toBe(40);
    expect(footprintRadiusM(null)).toBe(40);
    expect(footprintRadiusM(5)).toBe(15);
  });
});
