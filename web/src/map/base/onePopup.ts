// One popup on the map at a time (V3 §2): a pin's details open anchored to the pin itself, and opening one
// closes whatever was open (another pin's, the sector popover); opening the sector popover closes it.
// Pins c001 and c002 a few metres apart used to stack two popups over each other. The popup itself is
// injected (MapLibre's Popup in the app, a fake in the tests). Built by lane A.

export interface PopupLike {
  setLngLat: (at: [number, number]) => PopupLike;
  setDOMContent: (el: Node) => PopupLike;
  addTo: (map: never) => PopupLike;
  remove: () => PopupLike;
  on?: (type: "close", fn: () => void) => unknown;
}

export class OnePopup {
  /** What is open now (a pin's key), or null. */
  key: string | null = null;
  private popup: PopupLike | null = null;
  constructor(
    private readonly make: () => PopupLike,
    private readonly map: unknown,
    /** Called when a pin's popup opens: close the console's own popover. */
    private readonly onOpen: () => void = () => {},
  ) {}

  /** Open `text` anchored at `at` (lon, lat), closing anything open. Text only, never HTML from the mission. */
  open(key: string, at: [number, number], text: string): void {
    this.close();
    const el = typeof document === "undefined" ? null : document.createElement("div");
    if (el) {
      el.className = "text-small";
      el.style.whiteSpace = "pre-line";
      el.style.color = "#111";
      el.textContent = text;
    }
    const p = this.make();
    this.popup = p;
    this.key = key;
    p.on?.("close", () => {
      if (this.popup === p) {
        this.popup = null;
        this.key = null;
      }
    });
    this.onOpen();
    p.setLngLat(at);
    if (el) p.setDOMContent(el);
    p.addTo(this.map as never);
  }

  close(): void {
    const p = this.popup;
    this.popup = null;
    this.key = null;
    p?.remove();
  }

  get isOpen(): boolean {
    return this.popup !== null;
  }
}
