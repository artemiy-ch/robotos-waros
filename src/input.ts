/**
 * Mouse-look with the pointer locked to the canvas (click to capture, Esc to release).
 * Pointer events are used throughout: Babylon cancels pointerdown on the canvas,
 * which suppresses the legacy mouse events.
 */
export class Input {
  /** Left button held. */
  fire = false;
  locked = false;

  private keys = new Set<string>();
  private presses = new Set<string>();
  private dx = 0;
  private dy = 0;
  private wheel = 0;

  constructor(private canvas: HTMLCanvasElement, onLockChange: (locked: boolean) => void) {
    // e.code is the physical key, so WASD works with any keyboard layout.
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (!e.repeat) this.presses.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fire = false;
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.fire = false;
      onLockChange(this.locked);
    });
    document.addEventListener("pointermove", (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 0 && this.locked) this.fire = true;
    });
    window.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.fire = false;
    });
    canvas.addEventListener("wheel", (e) => {
      this.wheel += e.deltaY;
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  lock() {
    try {
      const result = this.canvas.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Browsers refuse re-locking right after Esc; the player just clicks again.
    }
  }

  down(...codes: string[]) {
    return codes.some((c) => this.keys.has(c));
  }

  /** Was the key pressed since the last endFrame()? */
  pressed(...codes: string[]) {
    return codes.some((c) => this.presses.has(c));
  }

  endFrame() {
    this.presses.clear();
  }

  consumeLook() {
    const look = { dx: this.dx, dy: this.dy, wheel: this.wheel };
    this.dx = this.dy = this.wheel = 0;
    return look;
  }
}
