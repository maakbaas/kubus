import { describe, expect, it, vi } from "vitest";
import { renderHook } from "../test/hooks";
import { backLayerOpen, takeBackForward, useBackCloses } from "./backLayers";

// The image lightbox over a page: back closes it, forward does nothing, and the page's history isn't moved.
describe("a layer that back closes", () => {
  it("takes back (closing it) and forward while open, nothing once closed", () => {
    const close = vi.fn();
    const hook = renderHook(({ open }: { open: boolean }) => useBackCloses(open, close), { props: { open: true } });
    expect(backLayerOpen()).toBe(true);
    expect(takeBackForward("forward")).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(takeBackForward("back")).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    hook.rerender({ open: false });
    expect(backLayerOpen()).toBe(false);
    expect(takeBackForward("back")).toBe(false);
    hook.unmount();
  });
});
