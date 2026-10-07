// Text panels for use inside a headset: a canvas drawn with 2D text, shown on a plane.
import * as THREE from "three";

const PX_PER_M = 2000; // canvas pixels per metre of panel

export class TextPanel extends THREE.Mesh {
  /**
   * @param {number} width   metres
   * @param {number} height  metres
   */
  constructor(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * PX_PER_M);
    canvas.height = Math.round(height * PX_PER_M);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const material = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    super(new THREE.PlaneGeometry(width, height), material);
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.texture = texture;
    this.renderOrder = 1000; // draw over the splats
    this.visible = false;
  }

  /** Clears to a rounded dark card; returns the 2D context for drawing. */
  begin() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(18, 18, 26, 0.92)";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 36);
    ctx.fill();
    ctx.stroke();
    return ctx;
  }

  end() {
    this.texture.needsUpdate = true;
  }
}

/** Draws "key — action" rows; returns the y after the last row. */
export function drawRows(ctx, rows, x, y, keyWidth, lineHeight) {
  for (const [key, action] of rows) {
    ctx.fillStyle = "#ffd27a";
    ctx.fillText(key, x, y);
    ctx.fillStyle = "#e8e8ee";
    ctx.fillText(action, x + keyWidth, y);
    y += lineHeight;
  }
  return y;
}
