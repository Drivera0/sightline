// A drone photo's position from its JPEG: EXIF GPS (latitude, longitude, altitude, image direction) and the
// DJI XMP fields when they are there (relative altitude above take-off, the flight's or gimbal's yaw). Just
// enough of TIFF to read those tags; no dependency. Pure. Built by lane A.

export interface PhotoPose {
  lat: number;
  lon: number;
  /** Metres above sea level (EXIF GPSAltitude), when present. */
  alt: number | null;
  /** Metres above the take-off point (DJI XMP RelativeAltitude): the height over the ground, near enough. */
  relAlt: number | null;
  /** Degrees from north the camera faced (GPSImgDirection, else the DJI yaw). */
  heading: number | null;
}

const GPS_IFD = 0x8825;

/** The pose in a JPEG's bytes, or null when it has no GPS position. */
export function readPose(buf: ArrayBuffer): PhotoPose | null {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let gps: Omit<PhotoPose, "relAlt"> | null = null;
  let xmp: string | null = null;
  let at = 2;
  while (at + 4 <= v.byteLength) {
    if (v.getUint8(at) !== 0xff) break;
    const marker = v.getUint8(at + 1);
    const len = v.getUint16(at + 2);
    if (marker === 0xda || marker === 0xd9) break; // image data: no more metadata
    if (marker === 0xe1) {
      const start = at + 4;
      const head = ascii(v, start, Math.min(29, len - 2));
      if (head.startsWith("Exif\0\0")) gps = readTiffGps(v, start + 6) ?? gps;
      else if (head.startsWith("http://ns.adobe.com/xap/1.0/")) xmp = ascii(v, start, len - 2);
    }
    at += 2 + len;
  }
  if (!gps) return null;
  const num = (name: string) => {
    const m = xmp ? new RegExp(`${name}\\s*=\\s*"([+-]?[\\d.]+)"`).exec(xmp) ?? new RegExp(`<[^>]*${name}>([+-]?[\\d.]+)<`).exec(xmp) : null;
    return m ? Number(m[1]) : null;
  };
  const yaw = num("drone-dji:GimbalYawDegree") ?? num("drone-dji:FlightYawDegree");
  return { ...gps, relAlt: num("drone-dji:RelativeAltitude"), heading: gps.heading ?? (yaw === null ? null : (yaw + 360) % 360) };
}

function ascii(v: DataView, from: number, n: number): string {
  let s = "";
  for (let i = 0; i < n && from + i < v.byteLength; i++) s += String.fromCharCode(v.getUint8(from + i));
  return s;
}

/** GPS tags from a TIFF block starting at `t` (the EXIF header's end). */
function readTiffGps(v: DataView, t: number): Omit<PhotoPose, "relAlt"> | null {
  const little = v.getUint16(t) === 0x4949;
  const u16 = (o: number) => v.getUint16(t + o, little);
  const u32 = (o: number) => v.getUint32(t + o, little);
  const rational = (o: number) => {
    const d = u32(o + 4);
    return d ? u32(o) / d : 0;
  };
  const entries = (ifd: number) => {
    const n = u16(ifd);
    return Array.from({ length: n }, (_, i) => {
      const e = ifd + 2 + i * 12;
      return { tag: u16(e), type: u16(e + 2), count: u32(e + 4), value: e + 8 };
    });
  };
  try {
    const ifd0 = u32(4);
    const ptr = entries(ifd0).find((e) => e.tag === GPS_IFD);
    if (!ptr) return null;
    const g = new Map(entries(u32(ptr.value)).map((e) => [e.tag, e]));
    const ref = (tag: number) => {
      const e = g.get(tag);
      return e ? String.fromCharCode(v.getUint8(t + e.value)) : "";
    };
    const dms = (tag: number) => {
      const e = g.get(tag);
      if (!e) return null;
      const o = u32(e.value); // three rationals, by offset
      return rational(o) + rational(o + 8) / 60 + rational(o + 16) / 3600;
    };
    const lat = dms(2);
    const lon = dms(4);
    if (lat === null || lon === null || (lat === 0 && lon === 0)) return null;
    const altE = g.get(6);
    const alt = altE ? rational(u32(altE.value)) * (g.get(5) && v.getUint8(t + g.get(5)!.value) === 1 ? -1 : 1) : null;
    const dirE = g.get(0x11);
    return { lat: ref(1) === "S" ? -lat : lat, lon: ref(3) === "W" ? -lon : lon, alt, heading: dirE ? rational(u32(dirE.value)) : null };
  } catch {
    return null;
  }
}

/** A ground footprint's radius from the height above ground (a drone camera sees about 1.6 × its height across). */
export const footprintRadiusM = (heightM: number | null | undefined) => Math.max(15, Math.min(120, 0.8 * (heightM ?? 50)));
