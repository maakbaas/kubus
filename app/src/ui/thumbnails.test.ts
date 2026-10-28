// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeThumbnail } from "./thumbnails";

afterEach(() => vi.unstubAllGlobals());

const big = new Uint8Array(200 * 1024);

interface Canvas {
  width: number;
  height: number;
}

/** A browser that can decode `width` x `height` images and encode as `encodes`. */
function browser(opts: { width?: number; height?: number; encodes?: string[]; thumbBytes?: number; alpha?: boolean; context?: boolean; decodes?: boolean } = {}) {
  const { width = 2000, height = 1000, encodes = ["image/webp"], thumbBytes = 5000, alpha = false, context = true, decodes = true } = opts;
  const closed = vi.fn();
  const drawn: Canvas[] = [];
  const asked: { type: string; quality?: number }[] = [];
  vi.stubGlobal("createImageBitmap", async () => {
    if (!decodes) throw new Error("unsupported");
    return { width, height, close: closed };
  });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return context
          ? {
              imageSmoothingQuality: "",
              drawImage: () => drawn.push({ width: this.width, height: this.height }),
              getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, alpha ? 100 : 255]) }),
            }
          : null;
      }
      async convertToBlob(o: { type: string; quality?: number }) {
        asked.push(o);
        // A browser that can't encode the type gives a PNG instead (Safari with WebP).
        const type = encodes.includes(o.type) ? o.type : "image/png";
        return { type, size: thumbBytes, arrayBuffer: async () => new Uint8Array(thumbBytes).fill(7).buffer };
      }
    },
  );
  return { closed, drawn, asked };
}

describe("makeThumbnail", () => {
  it("makes a WebP whose short side is 512 px", async () => {
    const b = browser({ width: 2000, height: 1000 });
    const t = await makeThumbnail(big, "image/jpeg");
    expect(t?.mime).toBe("image/webp");
    expect(t?.data.byteLength).toBe(5000);
    expect(b.drawn).toEqual([{ width: 1024, height: 512 }]);
    expect(b.asked).toEqual([{ type: "image/webp", quality: 0.8 }]);
    expect(b.closed).toHaveBeenCalled();
  });

  it("caps the long side of a panorama", async () => {
    const b = browser({ width: 8000, height: 1000 });
    await makeThumbnail(big, "image/jpeg");
    expect(b.drawn).toEqual([{ width: 2048, height: 256 }]);
  });

  it("falls back to JPEG where WebP can't be encoded, and to PNG for an image with transparency", async () => {
    let b = browser({ encodes: ["image/jpeg"] });
    expect((await makeThumbnail(big, "image/png"))?.mime).toBe("image/jpeg");
    expect(b.asked.map((a) => a.type)).toEqual(["image/webp", "image/jpeg"]);
    b = browser({ encodes: ["image/png"], alpha: true });
    expect((await makeThumbnail(big, "image/png"))?.mime).toBe("image/png");
    expect(b.asked.map((a) => a.type)).toEqual(["image/webp", "image/png"]);
  });

  it("needs none for a small file, a vector, an animated format", async () => {
    const b = browser();
    expect(await makeThumbnail(new Uint8Array(100 * 1024), "image/jpeg")).toBeNull();
    expect(await makeThumbnail(big, "image/svg+xml")).toBeNull();
    expect(await makeThumbnail(big, "image/gif")).toBeNull();
    expect(b.drawn).toEqual([]);
  });

  it("needs none for an image already small", async () => {
    const b = browser({ width: 400, height: 300 });
    expect(await makeThumbnail(big, "image/jpeg")).toBeNull();
    expect(b.closed).toHaveBeenCalled();
  });

  it("makes none when it would not be smaller than the original", async () => {
    browser({ thumbBytes: big.byteLength });
    expect(await makeThumbnail(big, "image/jpeg")).toBeNull();
  });

  it("makes none where the browser can't decode the format or has no canvas", async () => {
    browser({ decodes: false });
    expect(await makeThumbnail(big, "image/heic")).toBeNull();
    browser({ context: false });
    expect(await makeThumbnail(big, "image/jpeg")).toBeNull();
    vi.stubGlobal("OffscreenCanvas", undefined);
    expect(await makeThumbnail(big, "image/jpeg")).toBeNull();
    vi.stubGlobal("createImageBitmap", undefined);
    expect(await makeThumbnail(big, "image/jpeg")).toBeNull();
  });
});
