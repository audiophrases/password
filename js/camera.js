// camera.js — webcam for the projector "student in the center of the circle" look.

export class Camera {
  constructor() {
    this.stream = null;
  }

  get active() {
    return !!this.stream;
  }

  async start(videoEl) {
    if (this.stream) {
      videoEl.srcObject = this.stream;
      return true;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      videoEl.srcObject = this.stream;
      await videoEl.play().catch(() => {});
      return true;
    } catch (err) {
      console.warn('Camera unavailable:', err);
      return false;
    }
  }

  stop(videoEl) {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (videoEl) videoEl.srcObject = null;
  }
}

export async function toggleFullscreen(el) {
  if (!document.fullscreenElement) {
    await el.requestFullscreen?.().catch(() => {});
  } else {
    await document.exitFullscreen?.().catch(() => {});
  }
}
