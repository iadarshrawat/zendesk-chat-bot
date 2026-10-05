import { createCanvas } from "@napi-rs/canvas";
import { writeFileSync } from "node:fs";

function drawLogo(size) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  const scale = size / 320;
  context.scale(scale, scale);

  context.fillStyle = "#0a6e66";
  context.beginPath();
  context.roundRect(0, 0, 320, 320, 66);
  context.fill();

  context.strokeStyle = "rgba(255,255,255,0.4)";
  context.lineWidth = 10;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(73, 247);
  context.lineTo(247, 247);
  context.stroke();

  const bars = [
    [76, 164, 38, 78],
    [128, 116, 38, 126],
    [180, 139, 38, 103],
    [232, 77, 28, 165],
  ];
  context.fillStyle = "#ffffff";
  for (const [x, y, width, height] of bars) {
    context.beginPath();
    context.roundRect(x, y, width, height, 8);
    context.fill();
  }
  return canvas.toBuffer("image/png");
}

for (const [file, size] of [["logo.png", 320], ["logo-small.png", 128]]) {
  writeFileSync(new URL(`../assets/${file}`, import.meta.url), drawLogo(size));
}
